#!/usr/bin/env python3
"""MCP server (stdio, no dependencies) for driving and debugging PrimeBrew on the TV.

Wraps tools/tvdebug.py (signed debug channel into the PrimeBrew page) and tools/tvremote.py
(Samsung remote API). If the TV is on another LAN, set PRIMEBREW_SSH to a host that can reach
it (the tools must be in PRIMEBREW_TOOLS there, default ~/primebrew-tools).

  claude mcp add primebrew-tv -e PRIMEBREW_SSH=myhost -- python3 /path/to/tools/tv_mcp.py
"""
import json, os, shlex, subprocess, sys, urllib.request

SSH = os.environ.get('PRIMEBREW_SSH', '')
TOOLS = os.environ.get('PRIMEBREW_TOOLS', '~/primebrew-tools' if SSH else os.path.dirname(os.path.abspath(__file__)))
TV_IP = os.environ.get('PRIMEBREW_TV_IP', '192.168.31.105')
APP = 'PrimeBrew1.PrimeBrew'
TIZENBREW = 'xvvl3S1bvH.TizenBrewStandalone'

# What's on screen, as text: Amazon's TV app is mostly DOM, so text + focus tells a lot.
SCREEN_JS = r"""(function () {
  var f = document.activeElement, v = document.getElementById('primebrew-video') || document.querySelector('video');
  function d(e) { if (!e) return null; var r = e.getBoundingClientRect();
    return { tag: e.tagName, id: e.id || undefined, testid: e.getAttribute('data-testid') || undefined,
      label: e.getAttribute('aria-label') || undefined, text: (e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 120),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }; }
  return { url: location.href, focused: d(f),
    video: v ? { t: v.currentTime, paused: v.paused, w: v.videoWidth, h: v.videoHeight, dur: v.duration, readyState: v.readyState, error: v.error && v.error.message } : null,
    adBreaks: window.__primebrewAds || null,
    text: (document.body.innerText || '').replace(/\n{2,}/g, '\n').slice(0, 3000) };
})()"""


def run(argv, stdin=None, timeout=60):
    if SSH:
        cmd = ['ssh', '-o', 'ConnectTimeout=8', SSH,
               'bash -c ' + shlex.quote('cd ' + TOOLS + ' && ' + ' '.join(shlex.quote(a) for a in argv))]
    else:
        cmd = argv
        if argv[0] == 'python3':
            cmd = ['python3', os.path.join(TOOLS, argv[1])] + argv[2:]
    p = subprocess.run(cmd, input=stdin, capture_output=True, text=True, timeout=timeout)
    out = (p.stdout + ('\n' + p.stderr if p.stderr.strip() else '')).strip()
    return out if p.returncode == 0 else 'exit %d: %s' % (p.returncode, out)


def tv_rest(method, path):
    # The TV's REST API (:8001) is reachable only on its LAN: go through the ssh host if any.
    if SSH:
        return run(['curl', '-s', '-m', '5', '-X', method, 'http://%s:8001/api/v2/%s' % (TV_IP, path)])
    req = urllib.request.Request('http://%s:8001/api/v2/%s' % (TV_IP, path), method=method)
    with urllib.request.urlopen(req, timeout=5) as r:
        return r.read().decode()


def evaljs(js):
    return run(['python3', 'tvdebug.py', 'evalfile', '-'], stdin=js)


def screenshot(args):
    js = 'window.__primebrewShot(%s)' % float(args.get('scale', 0.5))
    out = evaljs(js)
    try:
        res = json.loads(out)
        b64 = res['image'].split(',', 1)[1]
    except Exception:
        return [{'type': 'text', 'text': 'screenshot failed: ' + out[:500]}]
    path = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'primebrew-tv-screen.jpg')
    with open(path, 'wb') as f:
        f.write(__import__('base64').b64decode(b64))
    return [{'type': 'image', 'data': b64, 'mimeType': 'image/jpeg'},
            {'type': 'text', 'text': 'saved %s (%s). Drawn from the page: the real video plane and DRM video are not capturable.' % (path, res.get('note') or 'no video')}]


def logs(args):
    out = run(['python3', 'tvdebug.py', 'logs'])
    lines = [l for l in out.splitlines() if not l.startswith('    at ')]
    flt = args.get('filter')
    if flt:
        import re
        rx = re.compile(flt, re.I)
        lines = [l for l in lines if rx.search(l)]
    n = int(args.get('last', 60))
    return '\n'.join(l[:int(args.get('width', 400))] for l in lines[-n:])


TOOLS_DEF = [
    ('tv_status', 'PrimeBrew debug service state on the TV (is the page connected?).', {}, lambda a: run(['python3', 'tvdebug.py', 'status'])),
    ('tv_logs', 'Console output from the PrimeBrew page on the TV (newest last).',
     {'filter': {'type': 'string', 'description': 'regex to keep matching lines'},
      'last': {'type': 'integer', 'description': 'how many lines (default 60)'},
      'width': {'type': 'integer', 'description': 'truncate lines (default 400)'}}, logs),
    ('tv_eval', 'Evaluate JavaScript in the PrimeBrew page on the TV; returns the JSON result (Promises are awaited).',
     {'js': {'type': 'string'}}, lambda a: evaljs(a['js'])),
    ('tv_screen', 'What is on the TV screen: URL, focused element, video state, ad breaks, visible text.', {}, lambda a: evaljs(SCREEN_JS)),
    ('tv_keys', 'Press remote keys, e.g. ["KEY_DOWN","KEY_ENTER","wait:2","KEY_RETURN"] (KEY_RETURN = Back). Also text:STR.',
     {'keys': {'type': 'array', 'items': {'type': 'string'}}}, lambda a: run(['python3', 'tvremote.py'] + a['keys'], timeout=120)),
    ('tv_screenshot', 'Picture of the PrimeBrew UI on the TV, rendered from the page (DRM video shows as black).',
     {'scale': {'type': 'number', 'description': 'size relative to 1920x1080 (default 0.5)'}}, screenshot),
    ('tv_launch', 'Open PrimeBrew on the TV (via its launcher app).', {}, lambda a: tv_rest('POST', 'applications/' + APP)),
    ('tv_restart_tizenbrew', 'Close TizenBrew and reopen PrimeBrew (reloads the mod).', {},
     lambda a: tv_rest('DELETE', 'applications/' + TIZENBREW) + ' ' + (__import__('time').sleep(3) or tv_rest('POST', 'applications/' + APP))),
    ('tv_info', 'TV power state, model and running state of TizenBrew.', {},
     lambda a: tv_rest('GET', '') + '\n' + tv_rest('GET', 'applications/' + TIZENBREW)),
]


def handle(msg):
    m, mid = msg.get('method'), msg.get('id')
    if m == 'initialize':
        return {'protocolVersion': msg['params'].get('protocolVersion', '2024-11-05'),
                'capabilities': {'tools': {}}, 'serverInfo': {'name': 'primebrew-tv', 'version': '1.0'}}
    if m == 'tools/list':
        return {'tools': [{'name': n, 'description': d,
                           'inputSchema': {'type': 'object', 'properties': p, 'required': [k for k in p if k in ('js', 'keys')]}}
                          for n, d, p, _ in TOOLS_DEF]}
    if m == 'tools/call':
        name, args = msg['params']['name'], msg['params'].get('arguments') or {}
        fn = next((f for n, _, _, f in TOOLS_DEF if n == name), None)
        if not fn:
            return {'content': [{'type': 'text', 'text': 'unknown tool ' + name}], 'isError': True}
        try:
            res = fn(args)
            if isinstance(res, list):
                return {'content': res}
            return {'content': [{'type': 'text', 'text': res or '(no output)'}], 'isError': res.startswith('exit ')}
        except Exception as e:
            return {'content': [{'type': 'text', 'text': '%s: %s' % (type(e).__name__, e)}], 'isError': True}
    if m == 'ping':
        return {}
    return None if mid is None else {'__error': {'code': -32601, 'message': 'method not found: %s' % m}}


def main():
    for line in sys.stdin:
        if not line.strip():
            continue
        msg = json.loads(line)
        res = handle(msg)
        if msg.get('id') is None or res is None:
            continue  # notification
        out = {'jsonrpc': '2.0', 'id': msg['id']}
        if '__error' in res:
            out['error'] = res['__error']
        else:
            out['result'] = res
        sys.stdout.write(json.dumps(out) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
