// PrimeBrew TV mode: runs Amazon's hosted living-room (TV) app by standing in for the native
// "Hawaii"/Ruby player bridge the official TV apps provide. The app talks JSON messages
// ({cmd, params}) to the bridge; we answer device/version queries and play the DASH streams
// it opens, relaying PlayReady license requests back to the app (which fetches licenses with
// the signed-in session). Two players: Samsung's native AVPlay when the page has Tizen APIs (our
// own app, launcher/), else Shaka Player over MSE/EME (TizenBrew). ES5 on purpose.
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

  function sendTime() { if (loaded) send('playback_time', { playback_time: backend().time() }); }

  function fail(e) {
    var code = (e && e.code) || 1000, data = '';
    try { data = JSON.stringify(e && e.data, function (k, v) { return v && v.byteLength !== undefined ? '[' + v.byteLength + ' bytes]' : v && v.message ? v.name + ': ' + v.message : v; }); } catch (x) {}
    console.error('[PrimeBrew TV] player error ' + code + ': ' + (e && e.message) + ' ' + String(data).slice(0, 1000));
    send('error', { code: code, message: 'PrimeBrew player error ' + code });
  }

  // ---- Shaka backend (TizenBrew: a remote page without Tizen APIs) ----
  var SHAKA_BACKEND = {
    name: 'shaka',
    init: function () { return loadShaka(); },
    open: function (url, startSec) {
      // From an https page an http:// stream is blocked as mixed content; Amazon's CDNs serve
      // the same paths over https.
      url = window.__primebrewUrl = https(String(url));
      loadShaka().then(function () {
        ensureVideo();
        if (player) return player.load(url, startSec || 0);
        player = new shaka.Player(video);
        window.__primebrewPlayer = player; // for tools/tv_mcp.py (tv_eval)
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
      }).catch(fail);
    },
    play: function () { video.play().catch(function () {}); },
    pause: function () { if (video) video.pause(); },
    seek: function (sec) { if (video) video.currentTime = sec; },
    stop: function () { if (video) { video.pause(); setState('stopped'); } },
    shutdown: function (done) {
      var fin = function () {
        if (video && video.parentNode) video.parentNode.removeChild(video);
        video = null; player = null; done();
      };
      if (player) player.destroy().then(fin, fin); else fin();
    },
    license: onLicense,
    time: function () { return video ? video.currentTime : 0; },
    paused: function () { return !video || video.paused; },
    busy: function () { return !video || video.seeking; }
  };

  // ---- AVPlay backend (our own Tizen app: Samsung's native player) ----
  // The TV's browser DRM path (EME) decodes protected video as garbage on this TV, in every app;
  // AVPlay is what native apps use. PlayReady "GenChallenge" mode hands us the license challenge
  // so the app can fetch the license with its session, then we install it.
  var av = null, avObj = null, avSeeking = false, avLastTime = 0;
  function avState() { try { return av.getState(); } catch (e) { return 'NONE'; } }
  function trace(m) { if (window.__primebrewTraceSync) window.__primebrewTraceSync('AVPlay ' + m); }
  // DRM properties for AVPlay; override for experiments: localStorage primebrew_avplay_props.
  // AVPlay's challenge mode (GetChallenge/GenChallenge) never delivers the challenge on this TV
  // (and crashes on encrypted-from-the-start streams). So AVPlay gets a normal license server:
  // our service on the TV, which relays the challenge to this page (see licensePoll).
  var LIC = null; // 'http://<tv>:<port>' of a service with the license relay
  function findLicenseRelay(done) {
    var host = window.__primebrewDebugHost || '127.0.0.1', ports = [8795, 8794, 8793, 8792, 8791, 8790, 8789, 8788, 8787], i = 0;
    (function next() {
      if (i >= ports.length) return done(null);
      var url = 'http://' + host + ':' + ports[i++], x = new XMLHttpRequest();
      x.open('GET', url + '/license/ping');
      x.timeout = 3000;
      x.onload = function () { if (x.status === 204) done(url); else next(); };
      x.onerror = x.ontimeout = x.onabort = next;
      x.send();
    })();
  }
  var licensePolling = false, licenseIds = [];
  function licensePoll() {
    if (licensePolling || !LIC) return;
    licensePolling = true;
    (function poll() {
      var x = new XMLHttpRequest();
      x.open('GET', LIC + '/license/next');
      x.timeout = 30000;
      x.onload = function () {
        if (x.status === 200) {
          var m = JSON.parse(x.responseText), ch = m.challenge; // base64 of the SOAP challenge
          licenseIds.push(m.id); // the app answers license requests in order
          trace('license challenge #' + m.id + ' (' + ch.length + ' chars) -> app');
          report('playready_license_requested');
          send('license_request', { request: encodeURIComponent(ch) });
        }
        poll();
      };
      x.onerror = x.ontimeout = x.onabort = function () { setTimeout(poll, 2000); };
      x.send();
    })();
  }
  function avProps() {
    try { var o = JSON.parse(localStorage.getItem('primebrew_avplay_props')); if (o) return o; } catch (e) {}
    return LIC ? { DeleteLicenseAfterUse: true, LicenseServer: LIC + '/license' } : null;
  }
  var AVPLAY_BACKEND = {
    name: 'avplay',
    init: function () { return Promise.resolve(); },
    open: function (url, startSec) {
      // The relay lives in TizenBrew's service, which may still be starting (app launch): retry ~30 s.
      if (!LIC) return (function attempt(n) {
        findLicenseRelay(function (u) {
          if (!u && n < 10) return setTimeout(function () { attempt(n + 1); }, 3000);
          LIC = u || 'none';
          trace('license relay ' + LIC);
          if (u) licensePoll();
          AVPLAY_BACKEND.open(url, startSec);
        });
      })(0);
      if (LIC === 'none') LIC = null;
      try { av.stop(); } catch (e) {}
      try { av.close(); } catch (e) {}
      if (!avObj) {
        avObj = document.createElement('object');
        avObj.type = 'application/avplayer';
        avObj.id = 'primebrew-avplayer';
        avObj.style.cssText = 'position:fixed;left:0;top:0;width:1920px;height:1080px;z-index:-1';
      }
      if (!avObj.parentNode) document.body.appendChild(avObj);
      // AVPlay draws on the video plane under the page: keep the page itself see-through.
      document.documentElement.style.background = document.body.style.background = 'transparent';
      window.__primebrewUrl = url = String(url);
      // Through the service's manifest proxy (fixes Amazon's bare <cenc:pssh>, absolute BaseURLs).
      // Options for experiments: localStorage primebrew_mpd_opts (e.g. "drop=ec-3").
      var mpdOpts = '';
      try { mpdOpts = localStorage.getItem('primebrew_mpd_opts') || ''; } catch (e) {}
      if (LIC && mpdOpts !== 'direct') url = LIC + '/mpd?' + (mpdOpts ? mpdOpts + '&' : '') + 'u=' + encodeURIComponent(url);
      try {
        trace('open ' + url.slice(0, 80));
        av.open(url);
        trace('setDisplayRect');
        av.setDisplayRect(0, 0, 1920, 1080); // always in 1920x1080 coordinates
        av.setListener({
          onbufferingstart: function () { setState('buffering'); },
          onbufferingcomplete: function () { setState(avState() === 'PLAYING' ? 'playing' : 'paused'); },
          oncurrentplaytime: function (ms) {
            avLastTime = ms / 1000;
            if (avState() === 'PLAYING') setState('playing');
          },
          onstreamcompleted: function () { setState('stopped'); },
          onerror: function (type) { fail({ code: 3002, message: 'AVPlay error ' + type }); },
          onevent: function (type, data) { console.log('[PrimeBrew TV] AVPlay event ' + type + ' ' + String(data).slice(0, 200)); },
          ondrmevent: function (type, data) {
            trace('drm event ' + type + ' ' + JSON.stringify(data).slice(0, 200));
            if (data && data.name === 'Challenge') {
              // The app wants base64 of the challenge: pass it as is, or encode raw XML.
              var ch = String(data.challenge || '');
              report('playready_license_requested');
              send('license_request', { request: encodeURIComponent(ch.charAt(0) === '<' ? btoa(ch) : ch) });
            } else {
              console.warn('[PrimeBrew TV] AVPlay drm event ' + type + ' ' + JSON.stringify(data).slice(0, 300));
              if (data && data.name === 'DrmError') fail({ code: 3003, message: 'DRM ' + data.code + ' ' + data.message });
            }
          }
        });
        var props = avProps();
        trace('setDrm SetProperties ' + JSON.stringify(props));
        if (props) av.setDrm('PLAYREADY', 'SetProperties', JSON.stringify(props));
      } catch (e) { return fail({ code: 3000, message: 'AVPlay open: ' + e }); }
      report('manifest_requested');
      trace('prepareAsync');
      av.prepareAsync(function () {
        trace('prepared, duration ' + av.getDuration());
        loaded = true;
        report('manifest_obtained');
        report('metadata', { duration: av.getDuration() / 1000, uid: 0 });
        var go = function () { if (wantPlay) { av.play(); setState('playing'); } else setState('paused'); };
        if (startSec > 0) av.seekTo(startSec * 1000, go, go); else go();
      }, function (e) { fail({ code: 3001, message: 'AVPlay prepare: ' + e }); });
    },
    play: function () { av.play(); setState('playing'); },
    pause: function () { av.pause(); setState('paused'); },
    seek: function (sec) {
      avSeeking = true;
      var done = function () { avSeeking = false; avLastTime = sec; sendTime(); };
      av.seekTo(Math.max(0, sec * 1000), done, done);
    },
    stop: function () { try { av.stop(); } catch (e) {} setState('stopped'); },
    shutdown: function (done) {
      try { av.stop(); } catch (e) {}
      try { av.close(); } catch (e) {}
      if (avObj && avObj.parentNode) avObj.parentNode.removeChild(avObj);
      done();
    },
    license: function (response) {
      // Hand the app's license to AVPlay's pending license-server request (the relay).
      var ok = response && !/^dumm/.test(response);
      trace('license from app: ' + (ok ? response.length + ' chars' : 'none'));
      var id = licenseIds.shift(), x = new XMLHttpRequest();
      trace('license for #' + id);
      x.open('POST', LIC + '/license/response?id=' + id);
      x.send(ok ? response : 'error');
      if (ok) report('playready_license_acquired');
      else fail({ code: 3004, message: 'no license from app' });
    },
    time: function () { try { return av.getCurrentTime() / 1000; } catch (e) { return avLastTime; } },
    paused: function () { return avState() !== 'PLAYING'; },
    busy: function () { return avSeeking || !loaded; }
  };

  var B = null;
  function backend() {
    if (!B) {
      av = window.webapis && window.webapis.avplay;
      B = av ? AVPLAY_BACKEND : SHAKA_BACKEND;
      console.log('[PrimeBrew TV] player: ' + B.name);
    }
    return B;
  }
  // Leaving the app (Home, standby) must release the hardware player completely: a protected
  // stream left suspended across standby left the TV's PlayReady unusable (DRM error 7 for any
  // title) until a reboot. Close it and tell the app, which reopens playback when it's needed.
  document.addEventListener('visibilitychange', function () {
    if (!av || !document.hidden || avState() === 'NONE') return;
    trace('hidden: closing the player');
    try { av.stop(); } catch (e) {}
    try { av.close(); } catch (e) {}
    loaded = wantPlay = false;
    setState('stopped');
  });

  var timeTimerOn = false;
  function open(url, startSec) {
    loaded = false;
    backend().open(url, startSec);
    if (!timeTimerOn) { timeTimerOn = true; setInterval(function () { if (loaded && !backend().paused()) sendTime(); }, 500); }
  }

  function shutdown() {
    backend().shutdown(function () {
      lastState = ''; loaded = wantPlay = false;
      send('shutdown_complete');
    });
  }

  function control(p) {
    switch (p.call_function) {
      case 'open': open(p.function_param, p.start_time_seconds); break;
      // The app sends play right after open, before the stream has loaded: remember it.
      case 'play': wantPlay = true; if (loaded) backend().play(); break;
      case 'pause': wantPlay = false; if (loaded) backend().pause(); break;
      case 'seek': if (loaded) backend().seek(Number(p.function_param) / 1000); break;
      case 'stop': backend().stop(); break;
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
    window.__primebrewTimeline = tl; // for inspection (tools/tv_mcp.py tv_eval)
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
    if (!loaded || !adRanges.length || backend().busy()) return;
    var t = backend().time();
    for (var i = 0; i < adRanges.length; i++) {
      var r = adRanges[i];
      if (t >= r[0] - 0.3 && t < r[1] - 0.5) {
        console.log('[PrimeBrew TV] skipping ad break ' + r[0].toFixed(1) + '-' + r[1].toFixed(1) + 's');
        backend().seek(r[1] + 0.05);
        return;
      }
    }
  }
  setInterval(skipAds, 250);

  // Ruby fetches natively, so the app hands out http:// URLs (subtitles, streams); from this
  // https page those are blocked as mixed content. Amazon's CDNs serve the same over https.
  // Never local addresses: the PrimeBrew debug service is plain http on 127.0.0.1.
  // Only needed on an https page (TizenBrew's); our packaged app's page isn't one. Never for
  // local-network addresses (the debug service is plain http on the TV).
  var UPGRADE = location.protocol === 'https:';
  function https(url) {
    return UPGRADE && typeof url === 'string' && !/^http:\/\/(127\.|localhost|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url)
      ? url.replace(/^http:\/\//, 'https://') : url;
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
      : e.keyCode === 10252 ? (loaded && !backend().paused() ? 19 : 415) : 0;
    if (!to) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    var ev = new KeyboardEvent(e.type, { bubbles: true, cancelable: true, key: to === 8 ? 'Backspace' : '' });
    Object.defineProperty(ev, 'keyCode', { get: function () { return to; } });
    Object.defineProperty(ev, 'which', { get: function () { return to; } });
    (e.target || document).dispatchEvent(ev);
  }
  // document.open() (how our own app loads Amazon's page) erases window listeners: reinstallable.
  window.__primebrewInstallKeys = function () {
    window.addEventListener('keydown', remapKey, true);
    window.addEventListener('keyup', remapKey, true);
  };
  window.__primebrewInstallKeys();

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
        case 'player_init': backend().init().catch(fail); break;
        case 'player_control': control(p); break;
        case 'license_response': backend().license(p.response); break;
      }
      if (window.__primebrewTrace) console.log('[PrimeBrew TV] <- ' + raw.slice(0, 200));
    }
  };
})();
