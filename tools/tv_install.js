// Runs in the TV-side PrimeBrew service; tools/tv_mcp.py fills in the values. With a .wgt:
// writes it to the TV and installs it through the TV's own sdbd on 127.0.0.1:26101 (the
// developer-mode daemon TizenBrew also uses), returning vd_appinstall's full output.
// Without: runs the sdb shell command __CMD__ (e.g. "0 vd_applist").
// Node 4, ES5. Minimal ADB/SDB wire protocol: 24-byte little-endian headers.
var PKG = '__PKG__', WGT_B64 = '__WGT__', CMD = '__CMD__';
var fs = require('fs'), net = require('net');
var CNXN = 0x4e584e43, OPEN = 0x4e45504f, OKAY = 0x59414b4f, CLSE = 0x45534c43, WRTE = 0x45545257;

function packet(cmd, a0, a1, data) {
  data = data || new Buffer(0);
  var h = new Buffer(24), sum = 0;
  for (var i = 0; i < data.length; i++) sum = (sum + data[i]) >>> 0;
  h.writeUInt32LE(cmd, 0); h.writeUInt32LE(a0 >>> 0, 4); h.writeUInt32LE(a1 >>> 0, 8);
  h.writeUInt32LE(data.length, 12); h.writeUInt32LE(sum, 16); h.writeUInt32LE((cmd ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([h, data]);
}

function shell(cmd) {
  return new Promise(function (resolve, reject) {
    var sock = net.connect(26101, '127.0.0.1'), buf = new Buffer(0), out = '', remote = 0, LOCAL = 1;
    var timer = setTimeout(function () { sock.destroy(); resolve(out + '\n[timeout]'); }, 100000);
    sock.on('error', function (e) { clearTimeout(timer); reject(e); });
    sock.on('connect', function () { sock.write(packet(CNXN, 0x01000000, 256 * 1024, new Buffer('host::\0'))); });
    sock.on('data', function (d) {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 24) {
        var len = buf.readUInt32LE(12);
        if (buf.length < 24 + len) break;
        var c = buf.readUInt32LE(0), a0 = buf.readUInt32LE(4), data = buf.slice(24, 24 + len);
        buf = buf.slice(24 + len);
        if (c === CNXN) sock.write(packet(OPEN, LOCAL, 0, new Buffer('shell:' + cmd + '\0')));
        else if (c === OKAY) remote = a0;
        else if (c === WRTE) { out += data.toString(); sock.write(packet(OKAY, LOCAL, a0)); }
        else if (c === CLSE) { clearTimeout(timer); sock.end(); resolve(out); }
      }
    });
  });
}

if (!WGT_B64) return shell(CMD);
var dirs = ['/home/owner/share/tmp/sdk_tools', '/tmp'], path = null, errs = [];
for (var i = 0; i < dirs.length && !path; i++) {
  try { fs.writeFileSync(dirs[i] + '/primebrew-install.wgt', new Buffer(WGT_B64, 'base64')); path = dirs[i] + '/primebrew-install.wgt'; }
  catch (e) { errs.push(dirs[i] + ': ' + e.code); }
}
if (!path) return 'could not write the wgt: ' + errs.join(', ');
return shell('0 vd_appinstall ' + PKG + ' ' + path).then(function (out) { return 'installed from ' + path + ':\n' + out; });
