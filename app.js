// PrimeBrew standalone: runs inside our own Tizen app (launcher/), loaded by its bootstrap from
// the latest release. Unlike a TizenBrew module, a packaged app's page has the Tizen APIs,
// including Samsung's native player (webapis.avplay): the TV's browser DRM path decodes
// protected video as garbage, AVPlay doesn't. So: install the player bridge (tv.js, AVPlay
// backend) and the debug client (userScript.js), then run Amazon's TV app in this page.
(function () {
  var BASE = window.__primebrewBase; // set by launcher/index.html
  var BLAST = 'https://atv-ext-eu.amazon.com/blast-app-hosting/html5/';
  var DTID = 'A1MWYRS2QVQH2N';

  function msg(t) { var m = document.getElementById('msg'); if (m) m.textContent = t; step('screen: ' + t); }
  // Startup steps to the debug service, through the bootstrap's report() (works before the
  // debug client is up).
  function step(t) { try { window.report('info', t); } catch (e) {} }
  window.addEventListener('error', function (e) { step('error: ' + e.message + ' @ ' + e.filename + ':' + e.lineno); });
  function load(file) {
    var x = new XMLHttpRequest();
    x.open('GET', BASE + file, false);
    x.send();
    if (x.status !== 200) throw new Error(file + ' HTTP ' + x.status);
    (0, eval)(x.responseText);
  }

  // Debug channel: TizenBrew's background service runs our service.js; a packaged app can't
  // reach loopback, so the debug client talks to it on the TV's own LAN address.
  try { window.__primebrewDebugHost = webapis.network.getIp(); } catch (e) {}

  step('app.js start; debug host ' + window.__primebrewDebugHost);
  // Debug client first, so a failure further on can be inspected remotely.
  window.__primebrewTV = true;
  try { load('userScript.js'); step('userScript.js ok'); } catch (e) { step('userScript.js failed: ' + (e.stack || e)); }
  try { load('tv.js'); step('tv.js ok'); } catch (e) { step('tv.js failed: ' + (e.stack || e)); throw e; }

  // The app's "exit" is window.close(); in a Tizen app that has to be an application exit.
  window.close = function () { try { tizen.application.getCurrentApplication().exit(); } catch (e) {} };

  // Amazon's app reads deviceTypeID from its own URL.
  history.replaceState(null, '', location.pathname + '?deviceTypeID=' + DTID);
  msg('Loading Prime Video…');
  var x = new XMLHttpRequest();
  x.open('GET', BLAST + 'index.html?deviceTypeID=' + DTID);
  x.onload = function () {
    step('Amazon index.html ' + x.status + ' ' + x.responseText.length + ' bytes');
    if (x.status !== 200) return msg('Prime Video did not load (HTTP ' + x.status + '). Back exits.');
    var html = x.responseText.replace(/<head([^>]*)>/i, '<head$1><base href="' + BLAST + '">');
    // document.open() keeps this window (and window.hawaii, timers) but erases its event
    // listeners: put the key handling back afterwards.
    document.open();
    document.write(html);
    document.close();
    window.__primebrewInstallKeys();
    console.log('[PrimeBrew] standalone: Amazon TV app loaded');
  };
  x.onerror = function () { msg('Prime Video did not load (network error). Back exits.'); };
  x.send();
})();
