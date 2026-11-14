// Injected by TizenBrew via CDP Runtime.evaluate: must be one self-contained file.
// ES5 on purpose: older Tizen TVs ship old Chromium.
(function () {
  var VERSION = '0.6.0';

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

  // Seconds left in an ad break from the player's timer text, e.g. "Ad 1 of 2 · 0:25" -> 25.
  function parseAdTime(text) {
    var m = /(\d+):(\d{2})(?!.*\d:\d)/.exec(text || '');
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    m = /(\d+)\s*s\b/.exec(text || '');
    return m ? Number(m[1]) : NaN;
  }

  if (typeof window === 'undefined') { module.exports = { pickNext: pickNext, parseAdTime: parseAdTime }; return; }
  // TizenBrew evaluates this in every execution context, iframes included: only run in the page.
  if (window.top !== window || window.__primebrew) return;
  window.__primebrew = true;

  var KEYS = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };
  var ENTER = 13, BACK = 10009;
  var MEDIA = { 10252: 'toggle', 415: 'play', 19: 'pause', 413: 'pause', 417: 'ff', 412: 'rw' };
  var SELECTOR = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[role="button"],[role="link"],[role="tab"],[role="menuitem"]';
  var current = null, lastRect = null;

  var style = document.createElement('style');
  style.textContent =
    // Drawn inside the element: Prime's rows clip anything outside their cards.
    '.pb-focus{outline:5px solid #00a8e1 !important;outline-offset:-5px !important;' +
    'box-shadow:inset 0 0 0 10px rgba(0,168,225,.35) !important}' +
    // 10-foot declutter: the desktop footer is unreachable link noise on a TV.
    '[data-testid="footer"]{display:none !important}' +
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
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' }); // smooth scroll stutters on TV chipsets
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

  // A title card's focusable element is its hover-expand button; the link to the title is a
  // sibling with tabindex=-1. OK on a card should open the title.
  function activate(el) {
    var card = el.hasAttribute('aria-expanded') && el.closest('article'), link = card && card.querySelector('a[href]');
    (link || el).click();
  }

  // Back on the first page leaves the app, like a native one (history.back() would do nothing).
  function back() {
    var before = location.href;
    history.back();
    setTimeout(function () {
      if (location.href !== before) return;
      try { tizen.application.getCurrentApplication().exit(); } catch (e) { console.warn('[PrimeBrew] cannot exit: ' + e); }
    }, 600);
  }

  // In Amazon's TV app (tv.js) the app does its own remote navigation and skipping.
  var TV_APP = /^atv-ext/.test(location.hostname);

  if (!TV_APP) window.addEventListener('keydown', function (e) {
    var k = e.keyCode, dir = KEYS[k], v = playerVideo();
    var typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

    if (MEDIA[k] && v) { media(v, MEDIA[k]); }
    else if (v && (dir === 'left' || dir === 'right') && !current) { media(v, dir === 'right' ? 'ff' : 'rw'); }
    else if (v && k === ENTER && !current) { media(v, 'toggle'); }
    else if (k === BACK) {
      if (typing) document.activeElement.blur();
      else if (v && current) { current.classList.remove('pb-focus'); current = null; } // back to seek mode
      else back();
    }
    else if (dir && !(typing && (dir === 'left' || dir === 'right'))) { move(dir); }
    else if (k === ENTER && current && !typing) { activate(current); }
    else return; // let the page handle it
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // Auto-skip: click the skip / next-episode buttons Prime itself shows (intro, recap, credits).
  // Each button element is clicked once, so a skip that Prime ignores doesn't loop.
  var SKIP = '[class*="skipelement"] button, button[class*="skipelement"], [class*="nextupcard-button"]';
  setInterval(function () {
    if (!playerVideo()) return;
    var btns = document.querySelectorAll(SKIP);
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.getAttribute('data-pb-clicked') || !visible(b)) continue;
      b.setAttribute('data-pb-clicked', '1');
      console.log('[PrimeBrew] auto-skip: ' + (b.textContent || b.className).trim().slice(0, 60));
      b.click();
    }
  }, 1000);

  // Ad skip, same idea as the Morphe Android TV patch: Prime splices ads into the stream
  // (server-inserted), so when an ad break starts we seek past it. The web player shows the
  // break's remaining time; jump that far. Chained ads (a 3-min pod) take several jumps:
  // each one is capped at 90 s (PrimeVideoTB found bigger seeks upset the player) and the
  // next is only read once the seek has finished and the timer has had time to refresh,
  // so a stale timer can't make us jump into real content.
  var AD_MAX_JUMP = 90, AD_SETTLE_MS = 1200;
  var adReadyAt = 0, lastAdText = '';
  setInterval(function () {
    var v = playerVideo(), timer = document.querySelector('.atvwebplayersdk-ad-timer-text');
    if (!timer || !visible(timer)) { lastAdText = ''; return; }
    if (!v || v.paused) return;
    if (v.seeking) { adReadyAt = Date.now() + AD_SETTLE_MS; return; }
    if (Date.now() < adReadyAt || timer.textContent === lastAdText) return;
    var left = parseAdTime(timer.textContent);
    if (!(left > 1)) return;
    lastAdText = timer.textContent;
    var jump = Math.min(left - 1, AD_MAX_JUMP);
    adReadyAt = Date.now() + AD_SETTLE_MS;
    console.log('[PrimeBrew] ad skip: ' + jump + 's (' + timer.textContent.trim() + ')');
    v.currentTime += jump;
  }, 250);

  // Debug client: talks to service.js on the TV (127.0.0.1 is allowed from an https page).
  // Ships console output there and evaluates signed commands from tools/tvdebug.py.
  var DEBUG = 'http://127.0.0.1:8787';
  var logBuf = [];

  function xhr(method, path, body, done) {
    var x = new XMLHttpRequest();
    x.open(method, DEBUG + path);
    x.timeout = 30000;
    x.onload = function () { done && done(x.status, x.responseText); };
    x.onerror = x.ontimeout = function () { done && done(0, ''); };
    x.send(body === undefined ? null : body); // text/plain body: no CORS preflight
  }

  function capture(level, args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      try { parts.push(typeof a === 'string' ? a : a instanceof Error ? a.stack || String(a) : JSON.stringify(a)); }
      catch (e) { parts.push(String(a)); }
    }
    logBuf.push({ level: level, msg: parts.join(' ') });
  }

  ['log', 'info', 'warn', 'error'].forEach(function (level) {
    var orig = console[level];
    console[level] = function () { capture(level, arguments); return orig.apply(console, arguments); };
  });
  window.addEventListener('error', function (e) { capture('error', [e.message + ' @ ' + e.filename + ':' + e.lineno]); });
  window.addEventListener('unhandledrejection', function (e) { capture('error', ['unhandled rejection', e.reason]); });
  capture('info', ['PrimeBrew ' + VERSION + ' on ' + location.href]);

  setInterval(function () {
    if (!logBuf.length) return;
    xhr('POST', '/page/log', JSON.stringify(logBuf.splice(0, logBuf.length)));
  }, 1000);

  function reply(id, ok, value) {
    var out;
    try { out = JSON.stringify(value === undefined ? null : value); } catch (e) { out = JSON.stringify(String(value)); }
    if (out.length > 500000) out = JSON.stringify(out.slice(0, 500000) + '…[truncated]');
    xhr('POST', '/page/result', '{"id":' + id + ',"ok":' + ok + ',"value":' + out + '}');
  }

  (function poll() {
    xhr('GET', '/page/next', undefined, function (status, text) {
      if (status === 0) return setTimeout(poll, 10000); // service not running (yet)
      if (status === 200) {
        var cmd = JSON.parse(text);
        try {
          var r = (0, eval)(cmd.js);
          if (r && typeof r.then === 'function') {
            r.then(function (v) { reply(cmd.id, true, v); }, function (e) { reply(cmd.id, false, String(e && e.stack || e)); });
          } else reply(cmd.id, true, r);
        } catch (e) { reply(cmd.id, false, String(e && e.stack || e)); }
      }
      poll();
    });
  })();

  var badge = document.createElement('div');
  badge.id = 'pb-badge';
  badge.textContent = 'PrimeBrew ' + VERSION;
  function mount() { document.body.appendChild(badge); }
  // Ask TizenBrew (its local WebSocket) whether our service is running, and show it on the badge.
  try {
    var ws = new WebSocket('ws://127.0.0.1:8081');
    ws.onopen = function () { ws.send(JSON.stringify({ type: 7 })); }; // GetServiceStatuses
    ws.onmessage = function (m) {
      var msg = JSON.parse(m.data);
      if (msg.type !== 7) return;
      ws.close();
      var mine = (msg.payload || []).filter(function (s) { return /primebrew/i.test(s.name); })[0];
      var st = !mine ? 'service not started' : mine.hasCrashed ? 'service crashed ' + JSON.stringify(mine.error) : 'service ok';
      console.log('[PrimeBrew] ' + st);
      badge.textContent = 'PrimeBrew ' + VERSION + ' · ' + st;
    };
  } catch (e) { console.warn('[PrimeBrew] status: ' + e); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  setTimeout(function () { if (badge.parentNode) badge.parentNode.removeChild(badge); }, 8000);
})();
