// Injected by TizenBrew via CDP Runtime.evaluate: must be one self-contained file.
// ES5 on purpose: older Tizen TVs ship old Chromium.
(function () {
  var VERSION = '0.2.0';

  // Pick the rect nearest to `from` in direction dir ('left'|'right'|'up'|'down').
  // Distance along the direction counts once, sideways offset counts double,
  // so a slightly-further item straight ahead beats a near one off to the side.
  function pickNext(from, rects, dir) {
    var fx = from.left + from.width / 2, fy = from.top + from.height / 2;
    var best = -1, bestScore = Infinity;
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i], x = r.left + r.width / 2, y = r.top + r.height / 2;
      var main, side;
      if (dir === 'left') { main = from.left - (r.left + r.width); side = Math.abs(y - fy); }
      else if (dir === 'right') { main = r.left - (from.left + from.width); side = Math.abs(y - fy); }
      else if (dir === 'up') { main = from.top - (r.top + r.height); side = Math.abs(x - fx); }
      else { main = r.top - (from.top + from.height); side = Math.abs(x - fx); }
      if (main < -1) continue; // behind us (allow 1px overlap)
      var score = Math.max(main, 0) + side * 2;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  if (typeof window === 'undefined') { module.exports = { pickNext: pickNext }; return; }
  if (window.__primebrew) return;
  window.__primebrew = true;

  var KEYS = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };
  var ENTER = 13, BACK = 10009;
  var MEDIA = { 10252: 'toggle', 415: 'play', 19: 'pause', 413: 'pause', 417: 'ff', 412: 'rw' };
  var SELECTOR = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[role="button"],[role="link"],[role="tab"],[role="menuitem"]';
  var current = null, lastRect = null;

  var style = document.createElement('style');
  style.textContent =
    '.pb-focus{outline:4px solid #00a8e1 !important;outline-offset:3px !important;' +
    'box-shadow:0 0 0 8px rgba(0,168,225,.35) !important;border-radius:6px}' +
    '#pb-badge{position:fixed;top:20px;right:20px;z-index:2147483647;background:#00a8e1;color:#fff;' +
    'font:20px sans-serif;padding:10px 18px;border-radius:8px;pointer-events:none}';
  (document.head || document.documentElement).appendChild(style);

  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && !el.disabled;
  }

  function candidates() {
    var all = document.querySelectorAll(SELECTOR), out = [];
    for (var i = 0; i < all.length; i++) if (all[i] !== current && visible(all[i])) out.push(all[i]);
    return out;
  }

  function focus(el) {
    if (current) current.classList.remove('pb-focus');
    current = el;
    el.classList.add('pb-focus');
    el.focus();
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    lastRect = el.getBoundingClientRect();
  }

  function move(dir) {
    if (current && !document.contains(current)) current = null; // SPA re-rendered it away
    var from = current ? current.getBoundingClientRect()
      : lastRect || { left: 0, top: -1, width: 0, height: 0 }; // start top-left
    var els = candidates();
    var i = pickNext(from, els.map(function (e) { return e.getBoundingClientRect(); }), dir);
    if (i >= 0) return focus(els[i]);
    // Nothing that way on screen: scroll so lazy-loaded rows can appear.
    var dy = dir === 'up' ? -0.6 : dir === 'down' ? 0.6 : 0;
    if (dy) window.scrollBy(0, dy * window.innerHeight);
  }

  function playerVideo() {
    var vids = document.getElementsByTagName('video');
    for (var i = 0; i < vids.length; i++) {
      var r = vids[i].getBoundingClientRect();
      if (r.width > window.innerWidth * 0.6) return vids[i];
    }
    return null;
  }

  function media(v, action) {
    if (action === 'toggle') action = v.paused ? 'play' : 'pause';
    if (action === 'play') v.play();
    else if (action === 'pause') v.pause();
    else v.currentTime += action === 'ff' ? 10 : -10;
  }

  window.addEventListener('keydown', function (e) {
    var k = e.keyCode, dir = KEYS[k], v = playerVideo();
    var typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

    if (MEDIA[k] && v) { media(v, MEDIA[k]); }
    else if (v && (dir === 'left' || dir === 'right') && !current) { media(v, dir === 'right' ? 'ff' : 'rw'); }
    else if (v && k === ENTER && !current) { media(v, 'toggle'); }
    else if (k === BACK) {
      if (typing) document.activeElement.blur();
      else if (v && current) { current.classList.remove('pb-focus'); current = null; } // back to seek mode
      else history.back();
    }
    else if (dir && !(typing && (dir === 'left' || dir === 'right'))) { move(dir); }
    else if (k === ENTER && current && !typing) { current.click(); }
    else return; // let the page handle it
    e.preventDefault();
    e.stopPropagation();
  }, true);

  var badge = document.createElement('div');
  badge.id = 'pb-badge';
  badge.textContent = 'PrimeBrew ' + VERSION;
  function mount() { document.body.appendChild(badge); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  setTimeout(function () { if (badge.parentNode) badge.parentNode.removeChild(badge); }, 5000);
})();
