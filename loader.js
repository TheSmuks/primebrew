// TizenBrew's main file. TizenBrew keeps this text in memory until the TV fully restarts,
// so it stays tiny and fetches the current release on every launch: new releases apply the
// next time PrimeBrew opens, no TV restart needed.
(function () {
  if (window.top !== window || window.__primebrewLoader) return;
  window.__primebrewLoader = true;
  var REPO = 'TheSmuks/primebrew';

  function get(url, sync, done) {
    var x = new XMLHttpRequest();
    x.open('GET', url, !sync);
    x.onload = function () { done(x.status === 200 ? x.responseText : null, x.status); };
    x.onerror = function () { done(null, 0); };
    try { x.send(); } catch (e) { done(null, 0); } // sync failures throw
  }

  // jsDelivr's unpinned URL lags behind new releases (it caches which tag is "latest", and
  // purges get throttled). Ask GitHub for the latest tag and load that exact, immutable version.
  var base = window.__primebrewBase;
  if (!base) get('https://api.github.com/repos/' + REPO + '/releases/latest', true, function (text) {
    try { base = 'https://cdn.jsdelivr.net/gh/' + REPO + '@' + JSON.parse(text).tag_name + '/'; } catch (e) {}
  });
  // Fallback: unpinned, with ?t= to skip the browser's 7-day cache.
  var bust = base ? '' : '?t=' + Date.now();
  base = base || 'https://cdn.jsdelivr.net/gh/' + REPO + '/';

  function load(file, sync) {
    get(base + file + bust, sync, function (text, status) {
      if (text !== null) (0, eval)(text);
      else console.error('[PrimeBrew] loader: ' + file + ' HTTP ' + status);
    });
  }
  // Amazon's TV app checks for its native player bridge early: install ours synchronously.
  if (/^atv-ext/.test(location.hostname)) load('tv.js', true);
  load('userScript.js');
})();
