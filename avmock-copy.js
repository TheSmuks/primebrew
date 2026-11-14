window.__avlog = [];
(function () {
  var st = 'NONE', t = 0, L = {}, timer = null;
  function log(x) { window.__avlog.push(x); }
  window.webapis = { avplay: {
    open: function (u) { st = 'IDLE'; log('open ' + u.slice(0, 40)); },
    setDisplayRect: function () { log('rect'); },
    setListener: function (l) { L = l; },
    setDrm: function (a, b, c) { log('setDrm ' + b + ' ' + String(c).slice(0, 60)); },
    prepareAsync: function (ok) { log('prepare'); setTimeout(function () { st = 'READY'; ok(); }, 500); },
    getDuration: function () { return 124000; },
    getState: function () { return st; },
    play: function () { st = 'PLAYING'; log('play'); clearInterval(timer); timer = setInterval(function () { t += 250; L.oncurrentplaytime && L.oncurrentplaytime(t); }, 250); },
    pause: function () { st = 'PAUSED'; log('pause'); clearInterval(timer); },
    seekTo: function (ms, ok) { log('seek ' + ms); t = ms; setTimeout(ok, 100); },
    getCurrentTime: function () { return t; },
    stop: function () { st = 'IDLE'; log('stop'); clearInterval(timer); },
    close: function () { st = 'NONE'; log('close'); },
    suspend: function () {}, restore: function () {}
  } };
})();
