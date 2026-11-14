// TizenBrew's main file. TizenBrew keeps this text in memory until the TV fully restarts,
// so it stays tiny and fetches the current release's userScript.js on every launch:
// new releases apply the next time PrimeBrew opens, no TV restart needed.
(function () {
  if (window.top !== window || window.__primebrewLoader) return;
  window.__primebrewLoader = true;
  var x = new XMLHttpRequest();
  // jsDelivr's unpinned URL is the latest release; ?t= skips the browser's 7-day cache.
  x.open('GET', 'https://cdn.jsdelivr.net/gh/TheSmuks/primebrew/userScript.js?t=' + Date.now());
  x.onload = function () {
    if (x.status === 200) (0, eval)(x.responseText);
    else console.error('[PrimeBrew] loader: HTTP ' + x.status);
  };
  x.onerror = function () { console.error('[PrimeBrew] loader: network error'); };
  x.send();
})();
