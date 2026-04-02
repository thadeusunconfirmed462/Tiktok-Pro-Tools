
// TikTok Pro Tools - Content Script v12
  (function () {
    'use strict';
    if (window.__tptLoaded) return;
    window.__tptLoaded = true;

    // ─── INJECT AUDIO/PLAY HOOKS (WEB ACCESSIBLE) ──────────────────────────────
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('hook.js');
    s.onload = function() {
        this.remove();
    };
    (document.head || document.documentElement).appendChild(s);


  
  
    let cfg = {
      backgroundPlay: true,
      autoPauseAudio: true,
      autoScroll: false,
      speed: 1, 
      eq: 'normal',
      eqBass: 0,
      eqMid: 0,
      eqTreble: 0,
      cleanMode: false,
      unlockShop: false,
      blockKeywords: ''
    };

  // ─── CAPTURE ORIGINALS ───────────────────────────────────────────────────────
  


  const _origPause = HTMLVideoElement.prototype.pause;
  const _origPlay  = HTMLVideoElement.prototype.play;

  // Snapshot the real getter BEFORE we override it
  const _realHiddenGetter = (() => {
    const d = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    return d && d.get ? d.get : null;
  })();
  const _realVisGetter = (() => {
    const d = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    return d && d.get ? d.get : null;
  })();

  function _isReallyHidden() {
    return _realHiddenGetter ? _realHiddenGetter.call(document) : false;
  }

    // ─── BACKGROUND PLAY ─────────────────────────────────────────────────────────
  let _bgEnabled = false;

  const _stopEvent = (e) => {
      if (cfg.backgroundPlay && e.isTrusted) {
          e.stopImmediatePropagation();
      }
  };

  function enableBgPlay() {
    if (_bgEnabled) return;
    _bgEnabled = true;

    try {
      Object.defineProperty(document, 'hidden', {
        get() { return cfg.backgroundPlay ? false : (_realHiddenGetter ? _realHiddenGetter.call(document) : false); },
        configurable: true
      });
      Object.defineProperty(document, 'visibilityState', {
        get() { return cfg.backgroundPlay ? 'visible' : (_realVisGetter ? _realVisGetter.call(document) : 'visible'); },
        configurable: true
      });
    } catch (_) {}

    // Thay vì chặn pause() làm hỏng Auto-Scroll, ta chặn luôn không cho Tiktok biết người dùng rời Tab
    window.addEventListener('visibilitychange', _stopEvent, true);
    document.addEventListener('visibilitychange', _stopEvent, true);
    window.addEventListener('pagehide', _stopEvent, true);
    window.addEventListener('blur', _stopEvent, true);
  }

  function disableBgPlay() {
    cfg.backgroundPlay = false;
    _bgEnabled = false;
    window.removeEventListener('visibilitychange', _stopEvent, true);
    document.removeEventListener('visibilitychange', _stopEvent, true);
    window.removeEventListener('pagehide', _stopEvent, true);
    window.removeEventListener('blur', _stopEvent, true);
  }




  // ─── AUTO PAUSE ON OTHER AUDIO ────────────────────────────────────────────────

  // ─── SCREENSHOT ──────────────────────────────────────────────────────────────
  function captureFrame() {
    const v = _best(); if (!v || v.videoWidth === 0) return;
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    c.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'tiktok-' + Date.now() + '.png';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, 'image/png');
  }

  
// ─── BACKGROUND RAF MOCK ─────────────────────────────────────────────────────
// TikTok's native Auto Scroll usually relies on requestAnimationFrame.
// In background tabs, rAF stops completely. We proxy it to setTimeout so native features keep working!
const _origRaf = window.requestAnimationFrame;
const _origCancelRaf = window.cancelAnimationFrame;
let rafPolyfillActive = false;


let _fadeInterval = null;
let _origVolume = 1;
let _pausedByExtension = false;

function fadeToPause() {
    const video = document.querySelector('video');
    if (!video || video.paused) return;
    clearInterval(_fadeInterval);
    _origVolume = video.volume > 0 ? video.volume : 1;
    _pausedByExtension = true;
    let v = video.volume;
    _fadeInterval = setInterval(() => {
        v -= 0.1;
        if (v <= 0) {
            clearInterval(_fadeInterval);
            video.volume = 0;
            video.pause();
        } else {
            video.volume = v;
        }
    }, 50);
}

function fadeToResume() {
    const video = document.querySelector('video');
    if (!video || !_pausedByExtension) return;
    _pausedByExtension = false;
    clearInterval(_fadeInterval);
    video.play().then(() => {
        let v = 0;
        video.volume = 0;
        _fadeInterval = setInterval(() => {
            v += 0.1;
            if (v >= _origVolume) {
                clearInterval(_fadeInterval);
                video.volume = _origVolume;
            } else {
                video.volume = v;
            }
        }, 50);
    }).catch(e => console.error("Fade resume error:", e));
}


function activateBackgroundRaf() {
    if (rafPolyfillActive) return;
    rafPolyfillActive = true;
    window.requestAnimationFrame = function(cb) {
        if (_isReallyHidden()) {
            // Tab is in background, proxy to setTimeout so it doesn't freeze
            return setTimeout(() => cb(performance.now()), 16);
        }
        return _origRaf.call(window, cb);
    };
    window.cancelAnimationFrame = function(id) {
        if (_isReallyHidden()) {
            clearTimeout(id);
        } else {
            _origCancelRaf.call(window, id);
        }
    };
}
activateBackgroundRaf();

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'other_audio_start' && cfg.autoPauseAudio) {
        fadeToPause();
    } else if (msg.action === 'other_audio_stop' && cfg.autoPauseAudio) {
        fadeToResume();
    }
});

// ─── AUDIO EQUALIZER ─────────────────────────────────────────────────────────
  const audioContextMap = new WeakMap();

  function applyEqToVideo(videoElement) {
    if (cfg.eq === 'normal' && !cfg.eqBass && !cfg.eqMid && !cfg.eqTreble) return;
    if (!videoElement.hasAttribute('crossorigin')) {
        try { videoElement.crossOrigin = "anonymous"; } catch(e){}
    }
    
    // Yêu cầu có tương tác người dùng mới bật AudioContext
    if (!navigator.userActivation || !navigator.userActivation.hasBeenActive) {
        return; // Đợi user tương tác
    }

    if (videoElement._audioContextCreated) {
        let audioNodes = audioContextMap.get(videoElement);
        if (audioNodes) {
             // Continue to update EQ gains
        } else {
             return;
        }
    }
    
    if (!audioContextMap.has(videoElement)) {
      try {
        videoElement._audioContextCreated = true;
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioContext();
        const source = ctx.createMediaElementSource(videoElement);
        
        const bassNode = ctx.createBiquadFilter();
        bassNode.type = "lowshelf";
        bassNode.frequency.value = 250;
        
        const trebleNode = ctx.createBiquadFilter();
        trebleNode.type = "highshelf";
        trebleNode.frequency.value = 6000;
        
        const midNode = ctx.createBiquadFilter();
        midNode.type = "peaking";
        midNode.frequency.value = 1000;
        midNode.Q.value = 1;

        source.connect(bassNode);
        bassNode.connect(midNode);
        midNode.connect(trebleNode);
        trebleNode.connect(ctx.destination);

        audioContextMap.set(videoElement, { ctx, bassNode, midNode, trebleNode });
      } catch (e) {
        // Silently ignore if AudioContext fails (e.g. InvalidStateError in background or already connected)
        // console.debug("EQ init skipped for this video element");
      }
    }

    const audioNodes = audioContextMap.get(videoElement);
    if (!audioNodes) return;
    
    if (audioNodes.ctx.state === 'suspended') {
        if (navigator.userActivation && navigator.userActivation.hasBeenActive) {
            audioNodes.ctx.resume().catch(() => {});
        }
    }

    audioNodes.bassNode.gain.value = 0;
    audioNodes.midNode.gain.value = 0;
    audioNodes.trebleNode.gain.value = 0;

    switch (cfg.eq) {
      case 'bass':
        audioNodes.bassNode.gain.value = 12;
        audioNodes.trebleNode.gain.value = -3;
        break;
      case 'treble':
        audioNodes.trebleNode.gain.value = 12;
        audioNodes.bassNode.gain.value = -3;
        break;
      case 'vocal':
        audioNodes.midNode.gain.value = 8;
        audioNodes.bassNode.gain.value = -5;
        audioNodes.trebleNode.gain.value = 2;
        break;
      case 'advanced':
        audioNodes.bassNode.gain.value = cfg.eqBass || 0;
        audioNodes.midNode.gain.value = cfg.eqMid || 0;
        audioNodes.trebleNode.gain.value = cfg.eqTreble || 0;
        break;
      case 'normal':
      default:
        break;
    }
  }

  // ─── CLEAN MODE ──────────────────────────────────────────────────────────────
  let tptStyleElement = null;

  function updateInjectedStyles() {
    if (!tptStyleElement) {
      tptStyleElement = document.createElement('style');
      tptStyleElement.id = 'tpt-injected-styles';
      document.head.appendChild(tptStyleElement);
    }
    
    let css = '';
    if (cfg.cleanMode) {
      css += `
        [data-e2e="video-desc"],
        [data-e2e="video-author-avatar"],
        [data-e2e="browser-nickname"],
        [data-e2e="video-music"],
        [class*="DivVideoInfoContainer"],
        [class*="DivMediaCardOverlayBottom"],
        [class*="DivActionItemContainer"],
        .tiktok-1vyw0v6-DivVideoInfoContainer,
        .tiktok-14bqk18-DivVideoContainer {
            opacity: 0 !important;
            pointer-events: none !important;
            transition: opacity 0.3s ease;
        }
      `;
    }
    
    tptStyleElement.textContent = css;
  }

  // ─── SHOP VIDEO UNBLOCKER ───────────────────────────────────────────────────
  let _shopFetching = new WeakSet();
  
  function checkShopVideos() {
    if (!cfg.unlockShop) return;
    
    // Tìm các container lớn có thể chứa video (bao gồm cả trường hợp TikTok xoá luôn thẻ video)
    const wrappers = document.querySelectorAll(
      '[class*="DivVideoWrapper"], [class*="DivVideoContainer"], [data-e2e="recommend-list-item-container"], .video-container'
    );
    
    wrappers.forEach(wrapper => {
      // Để tránh tìm trùng lớp cha-con, loại bỏ cha nếu có con tương tự
      if (wrapper.querySelector('[class*="DivVideoWrapper"]') && wrapper.className.includes('Container')) return;
      
      if (wrapper.dataset.tptShopFixed || _shopFetching.has(wrapper)) return;
      
      const rect = wrapper.getBoundingClientRect();
      const isVisible = rect.height > 0 && rect.top >= -500 && rect.bottom <= window.innerHeight + 500;
      if (!isVisible) return; 
      
      const vid = wrapper.querySelector('video');
      
      // Phát hiện video bị chặn (không có thẻ <video>, hoặc có nhưng không có source/không phát được)
      const isBlocked = !vid || (!vid.src && !vid.currentSrc && !vid.querySelector('source')) || 
                        (vid.readyState === 0 && (!vid.hasAttribute('src') || vid.getAttribute('src') === ''));
      
      // Loại hẳn bài đăng ảnh cuộn bị nhận diện nhầm
      if (wrapper.querySelector('[class*="DivImageContainer"]') || wrapper.innerHTML.includes('photo')) {
          if (!vid) return; 
      }

      // Tiêu chí bổ sung: Chữ "Xem video" hoặc icon báo lỗi của tiktok
      const hasErrorText = /TikTok Shop|(video|Nội dung) (này )?(không khả dụng|bị giới hạn)/i.test(wrapper.innerText || "");

      if (isBlocked || (!vid && hasErrorText)) {
        let targetUrl = window.location.href;
        
        // Tìm URL chuẩn trong feed nếu có
        const container = wrapper.closest('[data-e2e="recommend-list-item-container"], [class*="DivItemContainer"]');
        if (container) {
          const aTag = container.querySelector('a[href*="/video/"], a[href*="/v/"]');
          if (aTag) targetUrl = aTag.href;
        }

        if (!targetUrl.includes('/video/') && !targetUrl.includes('/v/')) {
          return; // Loại cứng /photo/ để shop unlocker không chõ mõm vào ảnh
        }

        _shopFetching.add(wrapper);
        console.log("TPT: Detected blocked Shop Video, fetching bypass link...", targetUrl);
        
        const loader = document.createElement('div');
        loader.style.cssText = `
          position: absolute; top: 0; left: 0; width: 100%; height: 100%;
          background: rgba(0,0,0,0.85); color: white; display: flex; flex-direction: column;
          align-items: center; justify-content: center; z-index: 1000; font-family: 'DM Sans', sans-serif;
          backdrop-filter: blur(2px); border-radius: 8px;
        `;
        loader.innerHTML = `
          <div style="width:36px; height:36px; border:4px solid rgba(255,255,255,0.2); border-top-color:#fe2c55; border-radius:50%; animation:tpt-spin 1s linear infinite;"></div>
          <style>@keyframes tpt-spin { 100% { transform: rotate(360deg); } }</style>
          <div style="margin-top:14px; font-weight:600; font-size:13px; text-shadow: 1px 1px 2px rgba(0,0,0,0.5);">Đang mở video TikTok Shop...</div>
        `;
        
        if (window.getComputedStyle(wrapper).position === 'static') {
          wrapper.style.position = 'relative';
        }
        wrapper.appendChild(loader);

        chrome.runtime.sendMessage({ type: 'TIKWM_FETCH', url: targetUrl }, res => {
          if (res && res.ok && res.data && (res.data.play || res.data.hdplay)) {
            const realUrl = res.data.hdplay || res.data.play;
            
            const newVid = document.createElement('video');
            newVid.src = realUrl;
            newVid.crossOrigin = "anonymous";
            newVid.controls = true;
            newVid.autoplay = true;
            newVid.loop = true;
            newVid.muted = false;
            newVid.style.cssText = `
              object-fit: contain; width: 100%; height: 100%;
              position: absolute; top: 0; left: 0; z-index: 999;
              background: #000; border-radius: 8px;
            `;
            
            wrapper.appendChild(newVid);
            if (vid) vid.remove(); 
            loader.remove(); 
            wrapper.dataset.tptShopFixed = "true";
            
            console.log("TPT: Shop Video unlocked with direct link!");
          } else {
            console.log("TPT: Failed to fetch bypass link", res);
            loader.innerHTML = `<div style="color:#ff3b30; font-weight:600; font-size:13px;">Không thể mở video này! (API lỗi)</div>`;
            setTimeout(() => {
              loader.remove();
              _shopFetching.delete(wrapper); 
            }, 3000);
          }
        });
      }
    });
  }

  
  

  // ─── VIDEO UTILS ─────────────────────────────────────────────────────────────
  function _best() {
    const all = [...document.querySelectorAll('video')];
    return all.find(v => !v.paused && v.readyState >= 2) || all.find(v => v.readyState >= 2) || all[0] || null;
  }

// ─── AUTO SCROLL (CUSTOM FIXED) ──────────────────────────────────────────────
function _logScroll(msg) {
    console.log(`[TPT-AutoScroll] ${new Date().toISOString()} - ${msg}`);
}


let _scrollCooldown = false;

function doScrollNext() {
    if (_scrollCooldown) return;
    _scrollCooldown = true;
    _logScroll("Attempting to scroll to the next video...");
    
    // Fallback un-pause in case it was paused
    const video = document.querySelector('video');
    if (video && video.paused && !video.dataset.pausedByExtension) video.play().catch(()=>{});

    // 1. Try finding the standard "Down" arrow in the feed (for TV mode or specific layouts)
    const btnDown = document.querySelector('[data-e2e="arrow-right"]') || document.querySelector('button[data-e2e="video-switch-next"]');
    if (btnDown) {
        _logScroll("Found next button, clicking it.");
        btnDown.click();
    } else {
        // 2. Try the keyboard fallback (ArrowDown) targeting a valid DOM element with a tagName
        _logScroll("Next button not found, trying KeyboardEvent (ArrowDown).");
        const e = new KeyboardEvent('keydown', { 
            key: 'ArrowDown', 
            code: 'ArrowDown', 
            keyCode: 40, 
            which: 40, 
            bubbles: true, 
            cancelable: true,
            composed: true,
            view: window
        });
        
        // Dispatch strictly on the closest feed container or #app, it must have a tagName to not crash React
        const targetElement = (video ? video.closest('[data-e2e="recommend-list-item-container"]') : null) 
                            || document.getElementById('app') 
                            || document.documentElement; // html has a tagname
                            
        targetElement.dispatchEvent(e);
        _logScroll("Keyboard event dispatched on: " + targetElement.tagName);
        
        // 3. Fallback: Emulate TikTok App scrollBy
        setTimeout(() => {
            const v = document.querySelector('video');
            if (v) {
                const wheelEvent = new WheelEvent('wheel', {
                    deltaY: 1000,
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    view: window
                });
                
                const container = v.closest('[data-e2e="recommend-list-item-container"]') || v.closest('div[class*="DivItemContainer"]');
                const feedWrapper = document.querySelector('[data-e2e="recommend-list-item-container"]')?.parentElement || document.getElementById('app');
                
                if (feedWrapper) {
                    _logScroll("Wheel event dispatched on feed parent.");
                    feedWrapper.dispatchEvent(wheelEvent);
                }
                
                // Final safety: Native scrollTo override
                if (container && container.nextElementSibling) {
                    _logScroll("Native scrollBy fallback executed.");
                    container.parentElement.scrollBy({ top: window.innerHeight, behavior: 'auto' });
                }
            }
        }, 150);
    }
    
    setTimeout(() => { _scrollCooldown = false; }, 2000); // 2 second cooldown
}

function handleVideoTimeUpdate(e) {
    const v = e.target;
    if (!cfg.autoScroll) return;

    // Check if the current video is actually visible (ignore background hidden videos)
    const rect = v.getBoundingClientRect();
    const isVisible = rect.top >= -100 && rect.top <= window.innerHeight / 2;
    if (!isVisible) return;

    if (!v._tptLastTime) v._tptLastTime = 0;
    
    if (v.duration > 0) {
        const timeDiff = v.currentTime - v._tptLastTime;
        // Check loop jump
        if (timeDiff < -1.0 && v._tptLastTime >= v.duration - 0.5) {
            _logScroll(`Video looped (AutoScroll triggered). Duration: ${v.duration.toFixed(2)}, Previous: ${v._tptLastTime.toFixed(2)} -> Current: ${v.currentTime.toFixed(2)}`);
            doScrollNext();
        }
        // Force ended if within 0.1s and not looping
        else if (!v.loop && v.currentTime >= v.duration - 0.1 &&!_scrollCooldown) {
            _logScroll(`Video ending (AutoScroll triggered). Duration: ${v.duration.toFixed(2)}, Current: ${v.currentTime.toFixed(2)}`);
            doScrollNext();
        }
    }
    v._tptLastTime = v.currentTime;
}


function setupAutoScrollFeature(v) {
    if (v.dataset.tptHasAutoScroll) return;
    v.dataset.tptHasAutoScroll = "true";
    _logScroll("Hooking timeupdate event to video: " + (v.src ? v.src.substring(0, 30) : "unknown blob"));
    
    v.addEventListener('timeupdate', handleVideoTimeUpdate);
    v.addEventListener('ended', (e) => {
        if (!cfg.autoScroll) return;
        _logScroll("Video ended natively (ended event).");
        doScrollNext();
    });
}

function _applyAll() {
    
    document.querySelectorAll('video').forEach(v => {
      // 4. Force Unmute dynamically once if we automatically muted it
        if (v.dataset.tptAutoMuted === "true" && navigator.userActivation && navigator.userActivation.hasBeenActive) {
            v.muted = false;
            delete v.dataset.tptAutoMuted;
            if (v.volume === 0) v.volume = 1;
            v.play().catch(()=>{});
        }
        
        if (Math.abs(v.playbackRate - cfg.speed) > 0.05) v.playbackRate = cfg.speed;
      setupAutoScrollFeature(v);
      setupAutoScrollFeature(v);
      applyEqToVideo(v);
    });
    updateInjectedStyles();
    checkShopVideos();
  }
  function _setSpeed(val) { cfg.speed  = +val; _applyAll(); chrome.storage.sync.set({ speed: cfg.speed }); }

  new MutationObserver(_applyAll).observe(document.body, { childList: true, subtree: true });
  let _lastHref = location.href;
  setInterval(() => { if (location.href !== _lastHref) { _lastHref = location.href; setTimeout(_applyAll, 900); } }, 500);

  // ─── MESSAGES ────────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'PING') return;
    if (msg.type === 'CAPTURE_FRAME') { captureFrame(); return; }
    if (msg.type === 'UPDATE_SETTINGS') {
      const s = msg.settings;
      if (s.backgroundPlay !== undefined) { cfg.backgroundPlay = s.backgroundPlay; s.backgroundPlay ? enableBgPlay() : disableBgPlay(); }
      if (s.speed !== undefined) _setSpeed(s.speed);
      if (s.eq !== undefined) { cfg.eq = s.eq; _applyAll(); }
      if (s.eqBass !== undefined) { cfg.eqBass = s.eqBass; _applyAll(); }
      if (s.eqMid !== undefined) { cfg.eqMid = s.eqMid; _applyAll(); }
      if (s.eqTreble !== undefined) { cfg.eqTreble = s.eqTreble; _applyAll(); }
      if (s.cleanMode !== undefined) { cfg.cleanMode = s.cleanMode; _applyAll(); }
      if (s.unlockShop !== undefined) { cfg.unlockShop = s.unlockShop; _applyAll(); }
      if (s.autoScroll !== undefined) { cfg.autoScroll = s.autoScroll; _applyAll(); }
      if (s.blockKeywords !== undefined) { cfg.blockKeywords = s.blockKeywords; _applyAll(); }
      if (s.autoPauseAudio !== undefined) { cfg.autoPauseAudio = s.autoPauseAudio; }
    }
  });

  
  

  

  // Fallback Interval để rà quét các chức năng (kể cả khi tab bị chrome làm chậm ngầm)
  setInterval(() => {
    // OVERRIDE: Chặn từ khoá rà soát liên tục
    if (cfg.blockKeywords && cfg.blockKeywords.trim()) {
      const kws = cfg.blockKeywords.toLowerCase().split(',').map(k => k.trim()).filter(k => k);
      if (kws.length > 0) {
        document.querySelectorAll('[data-e2e="recommend-list-item-container"], [class*="DivItemContainer"], [data-e2e="search-card-video-caption"]').forEach(el => {
          if (el.dataset.tptBlocked) return;
          const textContext = el.textContent.toLowerCase();
          
          if (kws.some(kw => textContext.includes(kw))) {
            el.dataset.tptBlocked = "true";
            el.style.opacity = '0.05';
            el.style.height = '0px';
            el.style.overflow = 'hidden';
            el.style.pointerEvents = 'none';

            const vid = el.querySelector('video');
            if (vid && !vid.paused) {
                vid.muted = true;
                vid.pause();
                const nextBtn = document.querySelector('[data-e2e="arrow-right"]');
                if (nextBtn) nextBtn.click();
            }
          }
        });

        document.querySelectorAll('[data-e2e="comment-level-1"], [data-e2e="comment-level-2"], [class*="DivCommentItemContainer"]').forEach(el => {
          if (el.dataset.tptBlocked) return;
          if (kws.some(kw => el.textContent.toLowerCase().includes(kw))) {
            el.dataset.tptBlocked = "true";
            el.style.display = 'none';
          }
        });
      }
    }
  }, 800); // 800ms đủ an toàn để Chrome không vứt hẳn, mà đủ nhanh để bắt sự kiện skip

  // ─── INIT ────────────────────────────────────────────────────────────────────
  chrome.storage.sync.get(null, data => {
    cfg = Object.assign(cfg, data);
    if (cfg.backgroundPlay) enableBgPlay();
        _applyAll();
  });
})();
