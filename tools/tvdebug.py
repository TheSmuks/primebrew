#!/usr/bin/env python3
"""Debug the PrimeBrew page on the TV through service.js (every request RSA-signed).

usage: tvdebug.py [--ip IP] [--key KEY] COMMAND
  status            service + page connection state
  logs [-f]         console output from the page (-f: keep following)
  eval JS           evaluate JS in the page, print the result (Promises are awaited)
  evalfile FILE     same, JS from a file ('-' = stdin)
  snapshot          URL, title, focused element and the visible interactive elements
  node JS / nodefile FILE   run JS in the TV-side service (Node, with require)
KEY defaults to debug.key next to this script (private half of service.js's PUBLIC_KEY).
"""
import base64, json, pathlib, subprocess, sys, time, urllib.error, urllib.request

SNAPSHOT = r"""(function () {
  function desc(el) {
    var r = el.getBoundingClientRect();
    return { tag: el.tagName.toLowerCase(), id: el.id || undefined,
      cls: (el.getAttribute('class') || '').slice(0, 80) || undefined,
      text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 60),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
  }
  var sel = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[role=button],[role=link],[role=tab]';
  var els = [].slice.call(document.querySelectorAll(sel)).filter(function (e) {
    var r = e.getBoundingClientRect();
    return r.width > 3 && r.height > 3 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  });
  var v = document.querySelector('video');
  return { url: location.href, title: document.title, viewport: [innerWidth, innerHeight],
    focused: document.querySelector('.pb-focus') ? desc(document.querySelector('.pb-focus')) : null,
    video: v ? { paused: v.paused, t: v.currentTime, dur: v.duration, w: v.videoWidth, h: v.videoHeight } : null,
    visible: els.map(desc) };
})()"""


def request(ip, key, method, path, body='', port=8787, timeout=40):
    ts = str(int(time.time() * 1000))
    sig = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', key],
                         input=f'{ts}\n{method} {path}\n{body}'.encode(), capture_output=True, check=True).stdout
    req = urllib.request.Request(f'http://{ip}:{port}{path}', method=method,
                                 data=body.encode() if method == 'POST' else None,
                                 headers={'X-PB-TS': ts, 'X-PB-Sig': base64.b64encode(sig).decode(),
                                          'Content-Type': 'text/plain'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        sys.exit(f'HTTP {e.code}: {e.read().decode()}')
    except OSError as e:
        sys.exit(f'cannot reach debug service at {ip}:{port} ({e}); is PrimeBrew open on the TV?')
    return json.loads(data) if data else None


def run_js(ip, key, js, port=8787):
    res = request(ip, key, 'POST', '/cmd', js, port)
    out = res.get('value')
    print(out if isinstance(out, str) else json.dumps(out, indent=1, ensure_ascii=False))
    if not res.get('ok'):
        sys.exit(1)


def main(argv):
    ip, key = '192.168.31.105', str(pathlib.Path(__file__).with_name('debug.key'))
    while argv[:1] in (['--ip'], ['--key']):
        if argv[0] == '--ip':
            ip = argv[1]
        else:
            key = argv[1]
        argv = argv[2:]
    cmd, rest = (argv[0], argv[1:]) if argv else ('', [])
    # Several service copies may run (8787-8789, TizenBrew keeps old ones until a TV restart):
    # page commands go to the one the page talks to (most recently seen page).
    port, best = 8787, -1
    for p in (8787, 8788, 8789):
        try:
            st = request(ip, key, 'GET', '/status', port=p, timeout=5)
        except SystemExit:
            continue
        seen = st['now'] if st.get('pageWaiting') else st.get('pageSeenAt', 0)
        if seen > best:
            port, best = p, seen

    if cmd == 'status':
        print(json.dumps(dict(request(ip, key, 'GET', '/status', port=port), port=port), indent=1))
    elif cmd == 'logs':
        since = 0
        while True:
            for entry in request(ip, key, 'GET', f'/logs?since={since}', port=port):
                since = entry['t']
                print(time.strftime('%H:%M:%S', time.localtime(entry['t'] / 1000)), entry['level'], entry['msg'])
            if rest != ['-f']:
                break
            time.sleep(2)
    elif cmd == 'eval' and rest:
        run_js(ip, key, ' '.join(rest), port)
    elif cmd == 'evalfile' and rest:
        run_js(ip, key, sys.stdin.read() if rest[0] == '-' else pathlib.Path(rest[0]).read_text(), port)
    elif cmd in ('node', 'nodefile') and rest:
        js = ' '.join(rest) if cmd == 'node' else (sys.stdin.read() if rest[0] == '-' else pathlib.Path(rest[0]).read_text())
        # A newer service may run on 8788 next to an older one on 8787 (which lacks /node).
        res = None
        for port in (8789, 8788, 8787):
            try:
                res = request(ip, key, 'POST', '/node', js, port, 125)
                break
            except SystemExit as e:
                err = e
        if res is None:
            raise err
        out = res.get('value')
        print(out if isinstance(out, str) else json.dumps(out, indent=1, ensure_ascii=False))
        if not res.get('ok'):
            sys.exit(1)
    elif cmd == 'snapshot':
        run_js(ip, key, SNAPSHOT, port)
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
