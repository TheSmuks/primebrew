// TizenBrew service entry (TizenBrew runs it in a Node vm sandbox with `require`). It stays tiny
// and stable: jsDelivr's unpinned URL, which TizenBrew loads, can lag days behind releases. So it
// asks GitHub for the latest release and runs that exact version's service-core.js.
// ES5 (older TizenBrew builds ship old Node).
(function () {
  var https = require('https'), REPO = 'TheSmuks/primebrew';
  function get(url, cb, hops) {
    var o = require('url').parse(url);
    o.headers = { 'User-Agent': 'PrimeBrew' }; // GitHub's API requires one; (url, opts, cb) needs Node 10+
    https.get(o, function (r) {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && (hops || 0) < 5) return get(r.headers.location, cb, (hops || 0) + 1);
      var d = []; r.on('data', function (c) { d.push(c); });
      r.on('end', function () { cb(r.statusCode === 200 ? Buffer.concat(d).toString('utf8') : null); });
    }).on('error', function () { cb(null); });
  }
  function run(base) {
    get(base + 'service-core.js', function (code) {
      if (code) Function('require', code)(require);
      else if (base.indexOf('@') > 0) run('https://cdn.jsdelivr.net/gh/' + REPO + '/'); // fall back to unpinned
    });
  }
  get('https://api.github.com/repos/' + REPO + '/releases/latest', function (text) {
    var tag = null;
    try { tag = JSON.parse(text).tag_name; } catch (e) {}
    run('https://cdn.jsdelivr.net/gh/' + REPO + (tag ? '@' + tag : '') + '/');
  });
})();
