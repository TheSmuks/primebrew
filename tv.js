// PrimeBrew TV mode: runs Amazon's hosted living-room (TV) app by standing in for the native
// "Hawaii"/Ruby player bridge the official TV apps provide. The app talks JSON messages
// ({cmd, params}) to the bridge; we answer device/version queries and play the DASH streams
// it opens with Shaka Player, relaying PlayReady license requests back to the app (which
// fetches licenses with the signed-in session). ES5: Tizen 6.5 runs Chromium 85.
(function () {
  if (typeof window === 'undefined' || window.top !== window || window.hawaii) return;

  var SHAKA = 'https://cdn.jsdelivr.net/npm/shaka-player@4.11.7/dist/shaka-player.compiled.js';
  var listener = null, video = null, player = null, shakaReady = null;
  var pendingLicense = null, lastState = '', timeTimer = null, hasPlayReady = false, loaded = false, wantPlay = false;

  function send(cmd, params) {
    var msg = JSON.stringify({ cmd: cmd, params: params || {} });
    setTimeout(function () { if (listener) listener(msg); }, 0);
  }
  function setState(s) { if (s !== lastState) { lastState = s; send('player_state_change', { state: s }); } }
  function report(type, extra) {
    var p = { type: type };
    for (var k in extra) p[k] = extra[k];
    send('report_output', p);
  }

  var devId = (function () {
    try {
      var id = localStorage.getItem('primebrew_device_id');
      if (!id) { id = ''; for (var i = 0; i < 32; i++) id += '0123456789abcdef'.charAt(Math.random() * 16 | 0); localStorage.setItem('primebrew_device_id', id); }
      return id;
    } catch (e) { return 'primebrew0000000000000000000000'; }
  })();

  var DEVICE = {
    deviceTypeId: 'A1MWYRS2QVQH2N', deviceId: devId, udid: devId, serial: devId,
    manufacturer: 'Samsung', modelName: 'Tizen TV', chipset: 'Tizen', firmwareVersion: '1.0',
    osName: 'Tizen', deviceLanguage: navigator.language || 'en-US', uiResolution: '1920x1080',
    playerName: 'PrimeBrew', playerVersion: '1.0', nativeEngineVersion: '1.0', scriptEngine: 'v8',
    supportsDASH: true, supportsStreamingTechnologyDash: true, supportsHDR: false, supportsUHD: false,
    supportsHEVC: false, supportsHDCP: true, hdcpVersion: '2.2', supportsDolbyVisionHdr: false,
    supportsHexEncodedManifest: false, supportsCompressedContentEncoding: true, hasExternalOutput: false
  };

  function loadShaka() {
    if (!shakaReady) shakaReady = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = SHAKA;
      s.onload = function () {
        shaka.polyfill.installAll();
        // Finish this check before Shaka counts as ready: the first open() configures DRM from it.
        var drmCheck = navigator.requestMediaKeySystemAccess('com.microsoft.playready', [{
          videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.640028"' }]
        }]).then(function () { hasPlayReady = true; }, function () { console.warn('[PrimeBrew TV] no PlayReady'); });
        // The app, not us, holds the session that fetches licenses: hand the challenge over.
        shaka.net.NetworkingEngine.registerScheme('primebrew-license', function (uri, request) {
          return shaka.util.AbortableOperation.notAbortable(new Promise(function (res, rej) {
            pendingLicense = { resolve: res, reject: rej, uri: uri };
            var bytes = new Uint8Array(request.body), bin = '';
            for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            report('playready_license_requested');
            send('license_request', { request: encodeURIComponent(btoa(bin)) });
          }));
        });
        drmCheck.then(resolve);
      };
      s.onerror = function () { shakaReady = null; reject(new Error('cannot load Shaka Player')); };
      (document.head || document.documentElement).appendChild(s);
    });
    return shakaReady;
  }

  function onLicense(response) {
    var p = pendingLicense;
    pendingLicense = null;
    if (!p) return;
    if (!response || /^dumm/.test(response)) return p.reject(new shaka.util.Error(2, 6, 6007, 'no license from app'));
    var bin;
    try { bin = response.charAt(0) === '<' ? response : atob(response); } catch (e) { bin = response; }
    var buf = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    report('playready_license_acquired');
    p.resolve({ uri: p.uri, originalUri: p.uri, data: buf.buffer, headers: {} });
  }

  // Amazon's manifests carry bare DRM init data in <cenc:pssh> (a PlayReady object / Widevine
  // PSSH payload), not the full 'pssh' box DASH specifies; Ruby copes, a browser CDM rejects
  // it ("Initialization data for CENC is incorrect"). Wrap each payload in a proper box.
  function psshBox(systemId, b64) {
    var bin = atob(b64.replace(/\s+/g, ''));
    if (bin.substr(4, 4) === 'pssh') return b64; // already a box
    var size = 32 + bin.length, head = String.fromCharCode(size >>> 24 & 255, size >>> 16 & 255, size >>> 8 & 255, size & 255) + 'pssh\0\0\0\0';
    var id = systemId.replace(/-/g, '');
    for (var i = 0; i < 32; i += 2) head += String.fromCharCode(parseInt(id.substr(i, 2), 16));
    var n = bin.length;
    return btoa(head + String.fromCharCode(n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255) + bin);
  }
  function fixManifest(xml) {
    return xml.replace(/(<ContentProtection\b[^>]*schemeIdUri="urn:uuid:([0-9a-fA-F-]{36})"[^>]*>\s*<cenc:pssh>)([^<]+)(<\/cenc:pssh>)/g,
      function (all, open, id, data, close) { return open + psshBox(id, data) + close; });
  }
  window.__primebrewFixManifest = fixManifest; // for tests

  function ensureVideo() {
    if (video) return video;
    video = document.createElement('video');
    video.id = 'primebrew-video';
    // Ruby draws video on a plane under the web UI; we put the element under the app instead.
    video.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:-1;background:#000';
    document.body.insertBefore(video, document.body.firstChild);
    video.addEventListener('playing', function () { setState('playing'); });
    video.addEventListener('pause', function () { if (!video.ended) setState('paused'); });
    video.addEventListener('waiting', function () { setState('buffering'); });
    video.addEventListener('seeked', sendTime);
    video.addEventListener('ended', function () { setState('stopped'); });
    return video;
  }

  function sendTime() { if (video) send('playback_time', { playback_time: video.currentTime }); }

  function fail(e) {
    var code = (e && e.code) || 1000, data = '';
    try { data = JSON.stringify(e && e.data, function (k, v) { return v && v.byteLength !== undefined ? '[' + v.byteLength + ' bytes]' : v && v.message ? v.name + ': ' + v.message : v; }); } catch (x) {}
    console.error('[PrimeBrew TV] player error ' + code + ': ' + (e && e.message) + ' ' + String(data).slice(0, 1000));
    send('error', { code: code, message: 'PrimeBrew player error ' + code });
  }

  function open(url, startSec) {
    loaded = false;
    // Ruby fetches natively; from this https page an http:// stream would be blocked as
    // mixed content. Amazon's CDNs serve the same paths over https.
    url = https(String(url));
    loadShaka().then(function () {
      ensureVideo();
      if (player) return player.load(url, startSec || 0);
      player = new shaka.Player(video);
      player.addEventListener('error', function (ev) { fail(ev.detail); });
      player.getNetworkingEngine().registerResponseFilter(function (type, response) {
        if (type !== shaka.net.NetworkingEngine.RequestType.MANIFEST) return;
        response.data = new TextEncoder().encode(fixManifest(new TextDecoder().decode(response.data))).buffer;
      });
      // Only ask for PlayReady where it exists (the TV); demanding a missing key system makes
      // Shaka drop every variant, clear trailers included.
      if (hasPlayReady) player.configure({ drm: { servers: { 'com.microsoft.playready': 'primebrew-license://app' } } });
      report('manifest_requested');
      return player.load(url, startSec || 0);
    }).then(function () {
      loaded = true;
      if (wantPlay) video.play().catch(function () {});
      report('manifest_obtained');
      report('metadata', { duration: video.duration, uid: 0 });
      var t = player.getVariantTracks().filter(function (x) { return x.active; })[0];
      if (t) report('video_frame_quality_level_change', { bitrate: t.videoBandwidth || t.bandwidth, width: t.width, height: t.height });
      if (!timeTimer) timeTimer = setInterval(function () { if (video && !video.paused) sendTime(); }, 500);
    }).catch(fail);
  }

  function shutdown() {
    clearInterval(timeTimer); timeTimer = null;
    var done = function () {
      if (video && video.parentNode) video.parentNode.removeChild(video);
      video = null; player = null; lastState = ''; loaded = wantPlay = false;
      send('shutdown_complete');
    };
    if (player) player.destroy().then(done, done); else done();
  }

  function control(p) {
    switch (p.call_function) {
      case 'open': open(p.function_param, p.start_time_seconds); break;
      // The app sends play right after open, before the stream has loaded: remember it.
      case 'play': wantPlay = true; if (loaded) video.play().catch(function () {}); break;
      case 'pause': wantPlay = false; if (video) video.pause(); break;
      case 'seek': if (video) video.currentTime = Number(p.function_param) / 1000; break;
      case 'stop': if (video) { video.pause(); setState('stopped'); } break;
      case 'shutdown': shutdown(); break;
    }
  }

  // Ad skipping. Ads are spliced into the stream (server-side), and the app knows where: it
  // logs each playback timeline ("timeline received {...}"). We rebuild its ad-inclusive
  // positions the way PlayerTimelineManager#buildTimelineMetadata does (items in order, each
  // endTime - startTime long; Advertisement/AdTransition items are ads) and jump to the end of
  // a break when playback reaches it. Playback (not a user seek) crossing an ad makes the app
  // mark it watched, so it doesn't pull us back; a user seek past an ad gets redirected to the
  // ad by the app, we skip it, and the app then resumes the seek to its reserved position.
  var adRanges = [];
  function onTimeline(tl) {
    var ranges = [], pos = 0, items = tl.items || [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.timeUnit !== 'ContentMillis' || it.startTime === null || it.endTime === null) break;
      var type = (tl.contentInfos[it.contentId] || {}).contentType, dur = (it.endTime - it.startTime) / 1000;
      if (type === 'Advertisement' || type === 'AdTransition') {
        var last = ranges[ranges.length - 1];
        if (last && Math.abs(last[1] - pos) < 0.01) last[1] = pos + dur; else ranges.push([pos, pos + dur]);
      }
      pos += dur;
    }
    adRanges = window.__primebrewAds = ranges;
    if (ranges.length) console.log('[PrimeBrew TV] ad breaks: ' + JSON.stringify(ranges));
  }
  ['log', 'info'].forEach(function (level) {
    var orig = console[level];
    console[level] = function (msg) {
      var k = typeof msg === 'string' && msg.indexOf('[UxTimelineManager#onTimelineChange] timeline received ') === 0 ? 55 : -1;
      if (k > 0) { try { onTimeline(JSON.parse(msg.slice(k))); } catch (e) { console.warn('[PrimeBrew TV] timeline: ' + e); } }
      return orig.apply(console, arguments);
    };
  });
  function skipAds() {
    if (!video || !loaded || video.seeking || !adRanges.length) return;
    var t = video.currentTime;
    for (var i = 0; i < adRanges.length; i++) {
      var r = adRanges[i];
      if (t >= r[0] - 0.3 && t < r[1] - 0.5) {
        console.log('[PrimeBrew TV] skipping ad break ' + r[0].toFixed(1) + '-' + r[1].toFixed(1) + 's');
        video.currentTime = r[1] + 0.05;
        return;
      }
    }
  }
  setInterval(skipAds, 250);

  // Ruby fetches natively, so the app hands out http:// URLs (subtitles, streams); from this
  // https page those are blocked as mixed content. Amazon's CDNs serve the same over https.
  // Never local addresses: the PrimeBrew debug service is plain http on 127.0.0.1.
  function https(url) {
    return typeof url === 'string' && !/^http:\/\/(127\.0\.0\.1|localhost)[:\/]/.test(url) ? url.replace(/^http:\/\//, 'https://') : url;
  }
  // Amazon's config for this device type says "deviceTier":"Tier-3", which turns off every UI
  // animation (Tier 1 = all, Tier 2 = core, Tier 3/4 = none). The TV handles more: ask for Tier 2
  // (Tier 1 also autoplays trailers while browsing).
  var TIER = 'Tier-2';
  function patchConfig(url, text) {
    return /\/acm\/GetConfiguration\//.test(url) ? text.replace(/"deviceTier":"Tier-\d"/g, '"deviceTier":"' + TIER + '"') : text;
  }
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? https(input) : input;
    var p = origFetch.call(this, url, init);
    if (typeof url !== 'string' || !/\/acm\/GetConfiguration\//.test(url)) return p;
    return p.then(function (r) {
      return r.text().then(function (t) {
        return new Response(patchConfig(url, t), { status: r.status, statusText: r.statusText, headers: r.headers });
      });
    });
  };
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = [].slice.call(arguments);
    args[1] = https(url);
    this.__pbUrl = args[1];
    return origOpen.apply(this, args);
  };
  ['responseText', 'response'].forEach(function (prop) {
    var d = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, prop);
    Object.defineProperty(XMLHttpRequest.prototype, prop, {
      configurable: true,
      get: function () {
        var v = d.get.call(this);
        return typeof v === 'string' && this.__pbUrl && /\/acm\/GetConfiguration\//.test(this.__pbUrl) ? patchConfig(this.__pbUrl, v) : v;
      }
    });
  });

  // The app's key map has no Samsung Back (10009) or Play/Pause (10252): translate them into
  // keys it knows (Backspace = BACK; Play 415 / Pause 19).
  function remapKey(e) {
    var to = e.keyCode === 10009 ? 8
      : e.keyCode === 10252 ? (video && !video.paused ? 19 : 415) : 0;
    if (!to) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    var ev = new KeyboardEvent(e.type, { bubbles: true, cancelable: true, key: to === 8 ? 'Backspace' : '' });
    Object.defineProperty(ev, 'keyCode', { get: function () { return to; } });
    Object.defineProperty(ev, 'which', { get: function () { return to; } });
    (e.target || document).dispatchEvent(ev);
  }
  window.addEventListener('keydown', remapKey, true);
  window.addEventListener('keyup', remapKey, true);

  window.hawaii = {
    registerMessageListener: function (cb) { listener = cb; },
    sendMessage: function (raw) {
      var m;
      try { m = JSON.parse(raw); } catch (e) { return; }
      var p = m.params || {};
      switch (m.cmd) {
        case 'tick': return;
        case 'device_description_request': send('device_description', DEVICE); break;
        case 'device_update_request': send('device_update', DEVICE); break;
        case 'version_request': send('version', { major: '2', minor: '5', revision: '0' }); break;
        case 'player_init': loadShaka().catch(fail); break;
        case 'player_control': control(p); break;
        case 'license_response': onLicense(p.response); break;
      }
      if (window.__primebrewTrace) console.log('[PrimeBrew TV] <- ' + raw.slice(0, 200));
    }
  };
})();
