// Injected by TizenBrew via CDP Runtime.evaluate: must be one self-contained file.
// ES5 on purpose: older Tizen TVs ship old Chromium.
(function () {
  if (window.__primebrew) return;
  window.__primebrew = true;

  var VERSION = '0.1.0';
  var lines = ['PrimeBrew ' + VERSION + ' loaded', 'URL: ' + location.href, 'UA: ' + navigator.userAgent];
  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:20px;right:20px;max-width:60%;z-index:2147483647;' +
    'background:#00a8e1;color:#fff;font:20px/1.4 sans-serif;padding:16px 24px;border-radius:8px;' +
    'white-space:pre-wrap;word-break:break-all;pointer-events:none';

  function add(line) {
    lines.push(line);
    box.textContent = lines.join('\n');
    console.log('[PrimeBrew] ' + line);
  }

  function mount() {
    (document.body || document.documentElement).appendChild(box);
    box.textContent = lines.join('\n');
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  // Spike data: which DRM systems the TV's browser exposes to the page.
  var config = [{
    initDataTypes: ['cenc'],
    videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }]
  }];
  ['com.widevine.alpha', 'com.microsoft.playready'].forEach(function (ks) {
    if (!navigator.requestMediaKeySystemAccess) return add(ks + ': no EME');
    navigator.requestMediaKeySystemAccess(ks, config).then(
      function () { add(ks + ': yes'); },
      function (e) { add(ks + ': no (' + e.name + ')'); }
    );
  });

  setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 30000);
})();
