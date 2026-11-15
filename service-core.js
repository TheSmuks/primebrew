// PrimeBrew debug service. TizenBrew runs it on the TV in a Node vm sandbox (old Node: ES5 only).
//
// Relays between the PrimeBrew page script and a debugger on the LAN (tools/tvdebug.py):
//   page  -> 127.0.0.1:8787/page/*  (logs, command results; unauthenticated, localhost only)
//   LAN   -> :8787/cmd, /logs, /status (every request RSA-signed with the owner's debug key)
// A LAN command is JS that the page evaluates, i.e. full control of the Prime session, so
// nothing reaches the page without a valid signature. Forks: replace PUBLIC_KEY with your own.
var http = require('http');
var crypto = require('crypto');

var PORT = 8787;
var PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkZEtMc9w4r4K14N47csv\nI5TugzeiRYHWlgo+ZOxuz2i1ijWxpRJypGreQ6aXIoynpV5swcPym0WYX6KN6sFK\nCs3uSeYOvLiPUxk4kfhSJXfyy+peL5Js13dqqw0547CDn2/60FXcymRKK3+yqD7c\nAPg55w8ENY6kuD87Po0IQb2d8JqvCmRAvbUYZ7xqxzr4zzt8x3i3Tl4DTnwMMA8O\n/TCOXW+Bqr4DQS5zsYG2yu6A40Wook+HyAKefXIo/7gCE4YrVdsZZo1vhZFvAkuF\npwvE8/KwQpDP45hMaFgVMyVy3S7cjDQNiMcxlMVRSCs0zvTuFLThcqXuu71XOiCn\nwwIDAQAB\n-----END PUBLIC KEY-----\n';
var MAX_SKEW = 120000; // ms between debugger and TV clocks
var MAX_BODY = 1024 * 1024;
var MAX_LOGS = 1000;

var seen = {};        // signature -> expiry (replay protection)
var queue = [];       // commands waiting for the page
var pageWaiter = null; // pending GET /page/next
var pending = {};     // command id -> LAN response waiting for the result
var logs = [];
var nextId = 1;
var pageSeenAt = 0;
var NODE_REQUIRE = require; // for /node

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(obj === undefined ? '' : JSON.stringify(obj));
}

function readBody(req, cb) {
  var chunks = [], size = 0;
  req.on('data', function (c) {
    size += c.length;
    if (size > MAX_BODY) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', function () { cb(Buffer.concat(chunks).toString('utf8')); });
}

// The page is on this TV. Loopback, or (our packaged app can't reach loopback) the TV's own
// LAN address.
function isLocal(req) {
  var a = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (a === '127.0.0.1' || a === '::1') return true;
  var ifs = require('os').networkInterfaces();
  for (var k in ifs) for (var i = 0; i < ifs[k].length; i++) if (ifs[k][i].address === a) return true;
  return false;
}

function verify(req, body) {
  var ts = Number(req.headers['x-pb-ts']), sig = req.headers['x-pb-sig'];
  var now = Date.now();
  if (!ts || !sig || Math.abs(now - ts) > MAX_SKEW || seen[sig]) return false;
  var v = crypto.createVerify('RSA-SHA256');
  v.update(ts + '\n' + req.method + ' ' + req.url + '\n' + body);
  var ok = false;
  try { ok = v.verify(PUBLIC_KEY, sig, 'base64'); } catch (e) { ok = false; }
  if (!ok) return false;
  for (var k in seen) if (seen[k] < now) delete seen[k];
  seen[sig] = now + MAX_SKEW * 2;
  return true;
}

function flush() {
  if (pageWaiter && queue.length) {
    var w = pageWaiter;
    pageWaiter = null;
    clearTimeout(w.timer);
    send(w.res, 200, queue.shift());
  }
}

function log(level, msg) {
  logs.push({ t: Date.now(), level: level, msg: String(msg).slice(0, 4000) });
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
}

// License relay for AVPlay (the player in our own app): AVPlay posts its PlayReady challenge to
// /license like to any license server; the page (tv.js) long-polls /license/next, has Amazon's
// app fetch the license with the signed-in session, and posts it to /license/response.
var lic = { avplay: null, challenge: null, pageWaiter: null };
function licenseRoute(req, res, path, body) {
  if (path === '/license/ping') return send(res, 204);
  if (path === '/license' && req.method === 'POST') {
    if (lic.avplay) send(lic.avplay.res, 503, { error: 'superseded' });
    lic.avplay = { res: res, timer: setTimeout(function () { lic.avplay = null; send(res, 504, { error: 'no license from page' }); }, 45000) };
    lic.challenge = new Buffer(body, 'utf8').toString('base64');
    log('info', 'license: challenge from player (' + body.length + ' bytes)');
    if (lic.pageWaiter) { var w = lic.pageWaiter; lic.pageWaiter = null; clearTimeout(w.timer); send(w.res, 200, { challenge: lic.challenge }); lic.challenge = null; }
    return;
  }
  if (path === '/license/next') {
    if (lic.challenge) { send(res, 200, { challenge: lic.challenge }); lic.challenge = null; return; }
    if (lic.pageWaiter) { clearTimeout(lic.pageWaiter.timer); send(lic.pageWaiter.res, 204); }
    lic.pageWaiter = { res: res, timer: setTimeout(function () { lic.pageWaiter = null; send(res, 204); }, 25000) };
    return;
  }
  if (path === '/license/response' && req.method === 'POST') {
    var a = lic.avplay;
    send(res, 204);
    if (!a) return log('warn', 'license: response but no player waiting');
    lic.avplay = null; clearTimeout(a.timer);
    var lic64 = body.trim(), bin = /^</.test(lic64) ? new Buffer(lic64, 'utf8') : new Buffer(lic64, 'base64');
    log('info', 'license: answering player (' + bin.length + ' bytes)');
    a.res.writeHead(bin.length && lic64 !== 'error' ? 200 : 500, { 'Content-Type': 'text/xml; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return a.res.end(bin);
  }
  send(res, 404, { error: 'not found' });
}

// Manifest proxy for AVPlay: Amazon's manifests carry bare DRM payloads in <cenc:pssh> (no
// 'pssh' box) and relative BaseURLs; serve a cleaned copy. Options (query): drop=ec-3 removes
// AdaptationSets with that codec; nopssh=1 removes the <cenc:pssh> elements instead of fixing.
function psshBox(systemId, b64) {
  var data = new Buffer(b64.replace(/\s+/g, ''), 'base64');
  if (data.length > 8 && data.toString('ascii', 4, 8) === 'pssh') return b64;
  var head = new Buffer(32);
  head.writeUInt32BE(32 + data.length, 0); head.write('pssh', 4, 'ascii'); head.writeUInt32BE(0, 8);
  new Buffer(systemId.replace(/-/g, ''), 'hex').copy(head, 12);
  head.writeUInt32BE(data.length, 28);
  return Buffer.concat([head, data]).toString('base64');
}
function fetchText(url, cb, hops) {
  var mod = /^https:/.test(url) ? require('https') : require('http');
  mod.get(url, function (r) {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && (hops || 0) < 5) return fetchText(require('url').resolve(url, r.headers.location), cb, (hops || 0) + 1);
    var d = []; r.on('data', function (c) { d.push(c); }); r.on('end', function () { cb(null, r.statusCode, Buffer.concat(d).toString('utf8')); });
  }).on('error', function (e) { cb(e); });
}
function mpdRoute(req, res, query) {
  var q = require('querystring').parse(query), url = q.u;
  fetchText(url, function (err, status, xml) {
    if (err || status !== 200) return send(res, 502, { error: String(err || status) });
    var dir = url.split('?')[0].replace(/[^\/]*$/, '');
    xml = xml.replace(/<BaseURL>(?!https?:)([^<]*)<\/BaseURL>/g, function (a, rel) { return '<BaseURL>' + dir + rel + '</BaseURL>'; });
    if (q.nopssh) xml = xml.replace(/<cenc:pssh>[^<]*<\/cenc:pssh>/g, '');
    else xml = xml.replace(/(<ContentProtection\b[^>]*schemeIdUri="urn:uuid:([0-9a-fA-F-]{36})"[^>]*>\s*<cenc:pssh>)([^<]+)(<\/cenc:pssh>)/g,
      function (a, open, id, data, close) { return open + psshBox(id, data) + close; });
    if (q.drop) {
      var codecs = q.drop.split(',');
      xml = xml.replace(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/g, function (as) {
        for (var i = 0; i < codecs.length; i++) if (as.indexOf('codecs="' + codecs[i]) >= 0) return '';
        return as;
      });
    }
    log('info', 'mpd: served ' + xml.length + ' bytes (' + query.replace(/u=[^&]*/, 'u=..') + ')');
    res.writeHead(200, { 'Content-Type': 'application/dash+xml', 'Access-Control-Allow-Origin': '*' });
    res.end(xml);
  });
}

function pageRoute(req, res, path, body) {
  if (path === '/page/ping') return send(res, 204); // lets the page find a current service
  pageSeenAt = Date.now();
  if (req.method === 'GET' && path === '/page/next') {
    if (pageWaiter) { clearTimeout(pageWaiter.timer); send(pageWaiter.res, 204); }
    pageWaiter = { res: res, timer: setTimeout(function () { pageWaiter = null; send(res, 204); }, 25000) };
    return flush();
  }
  var data;
  try { data = JSON.parse(body); } catch (e) { return send(res, 400, { error: 'bad json' }); }
  if (path === '/page/log') {
    (data || []).forEach(function (l) { log(l.level, l.msg); });
    return send(res, 204);
  }
  if (path === '/page/result') {
    var w = pending[data.id];
    if (w) { delete pending[data.id]; clearTimeout(w.timer); send(w.res, 200, data); }
    return send(res, 204);
  }
  send(res, 404, { error: 'not found' });
}

function lanRoute(req, res, path, query, body) {
  if (!verify(req, body)) return send(res, 403, { error: 'bad signature', now: Date.now() });
  if (path === '/status') {
    return send(res, 200, { now: Date.now(), pageSeenAt: pageSeenAt, pageWaiting: !!pageWaiter, queued: queue.length, logs: logs.length });
  }
  if (path === '/logs') {
    var since = Number((/since=(\d+)/.exec(query) || [])[1] || 0);
    return send(res, 200, logs.filter(function (l) { return l.t > since; }));
  }
  // Run JS in this service (Node, with require): installs over the TV's local sdbd, file and
  // process inspection. Same signature requirement as everything here. Promises are awaited.
  if (path === '/node' && req.method === 'POST') {
    var finished = false;
    var finish = function (ok, v) {
      if (finished) return;
      finished = true;
      var out;
      try { out = JSON.stringify(v === undefined ? null : v); } catch (e) { out = JSON.stringify(String(v)); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":' + ok + ',"value":' + out + '}');
    };
    setTimeout(function () { finish(false, 'timeout after 120 s'); }, 120000);
    try {
      // TizenBrew's sandbox copies the host's globals, eval included, so eval here is another
      // realm's and can't see our require: build a function with require as a parameter.
      var fn;
      try { fn = Function('require', 'return (' + body + '\n);'); } catch (e) { fn = Function('require', body); }
      var r = fn(NODE_REQUIRE);
      if (r && typeof r.then === 'function') r.then(function (v) { finish(true, v); }, function (e) { finish(false, String(e && e.stack || e)); });
      else finish(true, r);
    } catch (e) { finish(false, String(e && e.stack || e)); }
    return;
  }
  if (path === '/cmd' && req.method === 'POST') {
    var id = nextId++;
    pending[id] = { res: res, timer: setTimeout(function () {
      delete pending[id];
      send(res, 504, { error: 'no result from page in 30s (is PrimeBrew open on the TV?)' });
    }, 30000) };
    queue.push({ id: id, js: body });
    return flush();
  }
  send(res, 404, { error: 'not found' });
}

var server = http.createServer(function (req, res) {
  var parts = req.url.split('?'), path = parts[0], query = parts[1] || '';
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST' });
    return res.end();
  }
  readBody(req, function (body) {
    try {
      if (path === '/mpd') {
        if (!isLocal(req)) return send(res, 403, { error: 'mpd proxy is TV-local only' });
        return mpdRoute(req, res, query);
      }
      if (path === '/license' || path.indexOf('/license/') === 0) {
        if (!isLocal(req)) return send(res, 403, { error: 'license routes are TV-local only' });
        return licenseRoute(req, res, path, body);
      }
      if (path.indexOf('/page/') === 0) {
        if (!isLocal(req)) return send(res, 403, { error: 'page routes are localhost only' });
        return pageRoute(req, res, path, body);
      }
      lanRoute(req, res, path, query, body);
    } catch (e) {
      send(res, 500, { error: String(e) });
    }
  });
});
// A newer copy can be started next to older ones still holding 8787 (TizenBrew keeps services
// in memory until the TV restarts): then take the next port, up to 8795.
server.on('error', function (e) {
  if (e.code === 'EADDRINUSE' && PORT < 8795) { PORT++; server.listen(PORT, '0.0.0.0'); }
  else log('error', 'server: ' + e);
});
server.on('listening', function () { log('info', 'PrimeBrew debug service listening on ' + PORT); });
server.listen(PORT, '0.0.0.0');
