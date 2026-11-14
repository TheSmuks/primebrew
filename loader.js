// TizenBrew's main file. TizenBrew keeps this text in memory until the TV fully restarts,
// so it stays tiny and fetches the current release on every launch: new releases apply the
// next time PrimeBrew opens, no TV restart needed.
(function () {
  if (window.top !== window || window.__primebrewLoader) return;
  window.__primebrewLoader = true;
  // jsDelivr's unpinned URL is the latest release; ?t= skips the browser's 7-day cache.
  var BASE = window.__primebrewBase || 'https://cdn.jsdelivr.net/gh/TheSmuks/primebrew/';
  function load(file, sync) {
    var x = new XMLHttpRequest();
    x.open('GET', BASE + file + '?t=' + Date.now(), !sync);
    x.onload = function () {
      if (x.status === 200) (0, eval)(x.responseText);
      else console.error('[PrimeBrew] loader: ' + file + ' HTTP ' + x.status);
    };
    x.onerror = function () { console.error('[PrimeBrew] loader: ' + file + ' network error'); };
    try { x.send(); } catch (e) { console.error('[PrimeBrew] loader: ' + file + ' ' + e); } // sync failures throw
  }
  // Amazon's TV app checks for its native player bridge early: install ours synchronously.
  if (/^atv-ext/.test(location.hostname)) load('tv.js', true);
  load('userScript.js');
})();
