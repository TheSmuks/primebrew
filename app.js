// PrimeBrew standalone: runs inside our own Tizen app (launcher/), loaded by its bootstrap from
// the latest release. Unlike a TizenBrew module, a packaged app's page has the Tizen APIs,
// including Samsung's native player (webapis.avplay): the TV's browser DRM path decodes
// protected video as garbage, AVPlay doesn't. So: install the player bridge (tv.js, AVPlay
// backend) and the debug client (userScript.js), then run Amazon's TV app in this page.
(function () {
  var BASE = window.__primebrewBase; // set by launcher/index.html
  var BLAST = 'https://atv-ext-eu.amazon.com/blast-app-hosting/html5/';
  var DTID = 'A1MWYRS2QVQH2N';

  function msg(t) { var m = document.getElementById('msg'); if (m) m.textContent = t; }
  function load(file) {
    var x = new XMLHttpRequest();
    x.open('GET', BASE + file, false);
    x.send();
    if (x.status !== 200) throw new Error(file + ' HTTP ' + x.status);
    (0, eval)(x.responseText);
  }

  // Debug channel without TizenBrew's UI: start TizenBrew's background service app if needed,
  // then ask it (its local WebSocket, like TizenBrew's UI does) to run our service.js, which
  // the page's debug client (userScript.js) talks to on 127.0.0.1:8787.
  (function debugService() {
    var tag = (/@([^\/]+)\//.exec(BASE) || [])[1];
    var fullName = 'gh/TheSmuks/primebrew' + (tag ? '@' + tag : '');
    function start(retry) {
      var ws = new WebSocket('ws://127.0.0.1:8081');
      ws.onopen = function () {
        ws.send(JSON.stringify({ type: 6, payload: { fullName: fullName, name: 'primebrew', serviceFile: 'service.js' } }));
        setTimeout(function () { ws.close(); }, 2000);
      };
      ws.onerror = function () {
        if (!retry) return;
        try {
          tizen.application.launchAppControl(
            new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/service'),
            'xvvl3S1bvH.StandaloneService',
            function () { setTimeout(function () { start(false); }, 4000); },
            function (e) { console.warn('[PrimeBrew] cannot start TizenBrew service: ' + e.message); });
        } catch (e) { console.warn('[PrimeBrew] no TizenBrew service: ' + e); }
      };
    }
    start(true);
  })();

  load('tv.js');
  load('userScript.js'); // debug channel (via TizenBrew's service on 127.0.0.1:8787 when it runs)

  // The app's "exit" is window.close(); in a Tizen app that has to be an application exit.
  window.close = function () { try { tizen.application.getCurrentApplication().exit(); } catch (e) {} };

  // Amazon's app reads deviceTypeID from its own URL.
  history.replaceState(null, '', location.pathname + '?deviceTypeID=' + DTID);
  msg('Loading Prime Video…');
  var x = new XMLHttpRequest();
  x.open('GET', BLAST + 'index.html?deviceTypeID=' + DTID);
  x.onload = function () {
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
