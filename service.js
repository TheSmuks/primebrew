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

function isLocal(req) {
  var a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
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

function pageRoute(req, res, path, body) {
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

http.createServer(function (req, res) {
  var parts = req.url.split('?'), path = parts[0], query = parts[1] || '';
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST' });
    return res.end();
  }
  readBody(req, function (body) {
    try {
      if (path.indexOf('/page/') === 0) {
        if (!isLocal(req)) return send(res, 403, { error: 'page routes are localhost only' });
        return pageRoute(req, res, path, body);
      }
      lanRoute(req, res, path, query, body);
    } catch (e) {
      send(res, 500, { error: String(e) });
    }
  });
}).listen(PORT, '0.0.0.0');

log('info', 'PrimeBrew debug service listening on ' + PORT);
