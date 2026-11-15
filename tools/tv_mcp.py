#!/usr/bin/env python3
"""MCP server (stdio, no dependencies) for driving and debugging PrimeBrew on the TV.

Wraps tools/tvdebug.py (signed debug channel into the PrimeBrew page) and tools/tvremote.py
(Samsung remote API). If the TV is on another LAN, set PRIMEBREW_SSH to a host that can reach
it (the tools must be in PRIMEBREW_TOOLS there, default ~/primebrew-tools).

  claude mcp add primebrew-tv -e PRIMEBREW_SSH=myhost -- python3 /path/to/tools/tv_mcp.py
"""
import json, os, shlex, subprocess, sys, time, urllib.request

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


PORT = os.environ.get('PRIMEBREW_PORT', '')  # pin the debug service port (8787-8789); default: auto


def run(argv, stdin=None, timeout=60):
    if PORT and argv[:2] == ['python3', 'tvdebug.py']:
        argv = argv[:2] + ['--port', PORT] + argv[2:]
    if SSH:
        cmd = ['ssh', '-o', 'ConnectTimeout=8', SSH,
               'bash -c ' + shlex.quote('cd ' + TOOLS + ' && ' + ' '.join(shlex.quote(a) for a in argv))]
    else:
        cmd = argv
        if argv[0] == 'python3' and argv[1].endswith('.py'):
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


def power_state():
    # 'on' / 'standby' (network standby: REST answers, screen off) / 'off' (unreachable)
    try:
        return json.loads(tv_rest('GET', ''))['device'].get('PowerState', 'on')
    except Exception:
        return 'off'


def page_seen():
    # (service clock now, page last seen) in ms, or None if the debug service isn't up.
    try:
        st = json.loads(run(['python3', 'tvdebug.py', 'status'], timeout=20))
        # A connected page sits in a 25 s long poll: while it waits, it is "seen" right now.
        return st['now'], st['now'] if st.get('pageWaiting') else (st.get('pageSeenAt') or 0)
    except Exception:
        return None


def page_age():
    # Seconds since the PrimeBrew page last polled the debug service (None: no service/page).
    try:
        st = json.loads(run(['python3', 'tvdebug.py', 'status'], timeout=20))
        return (st['now'] - st['pageSeenAt']) / 1000 if st.get('pageSeenAt') else None
    except Exception:
        return None


def wait(cond, timeout, step=5):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(step)
    return False


MAC_CACHE = os.path.expanduser('~/.cache/primebrew-tv-mac')


def tv_mac():
    mac = os.environ.get('PRIMEBREW_TV_MAC')
    if not mac:
        try:
            mac = json.loads(tv_rest('GET', ''))['device']['wifiMac']
            os.makedirs(os.path.dirname(MAC_CACHE), exist_ok=True)
            open(MAC_CACHE, 'w').write(mac)
        except Exception:
            mac = open(MAC_CACHE).read().strip() if os.path.exists(MAC_CACHE) else None
    return mac


def wake():
    mac = tv_mac()
    if not mac:
        return 'no MAC known (set PRIMEBREW_TV_MAC)'
    # Over Wi-Fi only some destinations wake the TV: send to the global and subnet broadcast and
    # to the TV's address, ports 9 and 7.
    subnet = TV_IP.rsplit('.', 1)[0] + '.255'
    code = ("import socket,time;m=bytes.fromhex('%s'.replace(':',''));p=b'\\xff'*6+m*16;"
            "s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.setsockopt(socket.SOL_SOCKET,socket.SO_BROADCAST,1);"
            "[[s.sendto(p,(a,o)) for a in ('255.255.255.255','%s','%s') for o in (9,7)] and time.sleep(1) for _ in range(5)]") % (mac, subnet, TV_IP)
    return run(['python3', '-c', code]) or 'magic packet sent'


def tv_power(args):
    action = args.get('action', 'status')
    if action == 'on':
        if power_state() == 'on':
            return 'already on'
        r = wake()
        return r + ('; on' if wait(lambda: power_state() == 'on', 60) else '; still not on after 60 s')
    if action == 'off':
        if power_state() != 'on':
            return 'already off'
        run(['python3', 'tvremote.py', 'KEY_POWER'])
        return 'off' if wait(lambda: power_state() != 'on', 30) else 'still on'
    if action == 'restart':
        # A 5 s Power hold reboots the TV fully (clears TizenBrew's in-memory caches).
        if power_state() != 'on':
            wake()
            wait(lambda: power_state() == 'on', 60)
        # A 5 s Power hold sometimes reboots, sometimes only sends the TV to standby: if it
        # isn't back on its own within 2 min, wake it with Wake-on-LAN.
        run(['python3', 'tvremote.py', 'hold:KEY_POWER:5'])
        wait(lambda: power_state() != 'on', 30, 2)
        if wait(lambda: power_state() == 'on', 120):
            return 'rebooted, on'
        wake()
        if wait(lambda: power_state() == 'on', 60):
            return 'went to standby instead of rebooting; woken with Wake-on-LAN (TizenBrew caches may survive)'
        return 'did not come back on: needs a manual power cycle'
    return power_state()


def tv_reset(args):
    # Fresh PrimeBrew page with the latest release: reload the page in place. TizenBrew re-injects
    # the mod into the new page and the loader fetches the latest release again.
    # Deliberately no app relaunching: a cold TizenBrew start opens its auto-launch module (e.g.
    # TizenTube) instead of the launcher's request in practice, which disrupts the TV.
    if power_state() != 'on':
        return 'TV is not on (tv_power on to wake it).'
    before = page_seen()
    if not before or before[0] - before[1] > 30000:
        return ('PrimeBrew is not open on the TV (page not seen for %s). Ask the user to open it; '
                'relaunching TizenBrew from here tends to open its auto-launch module instead.'
                % ('ever' if not before or not before[1] else '%d s' % ((before[0] - before[1]) / 1000)))
    old_line = logs({'filter': r'PrimeBrew \d', 'last': 1})
    evaljs('setTimeout(function () { location.reload(); }, 300); "reloading"')
    # The new page announces itself with a fresh "PrimeBrew <version> on <url>" line.
    if wait(lambda: logs({'filter': r'PrimeBrew \d', 'last': 1}) not in ('', old_line), 60, 3):
        return 'reloaded; ' + logs({'filter': r'PrimeBrew \d', 'last': 1})
    return 'reload sent, but the page did not reconnect within 60 s'


def tv_apps(args):
    app, action = args.get('app', APP), args.get('action', 'status')
    method = {'status': 'GET', 'launch': 'POST', 'close': 'DELETE'}[action]
    return tv_rest(method, 'applications/' + app)


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


INSTALL_JS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tv_install.js')


def tv_node_js(js):
    return run(['python3', 'tvdebug.py', 'nodefile', '-'], stdin=js, timeout=130)


def tv_sdb(args):
    cmd = args['cmd'].replace('\\', '\\\\').replace("'", "\\'")
    return tv_node_js(open(INSTALL_JS).read().replace('__CMD__', cmd).replace('__WGT__', '').replace('__PKG__', ''))


def tv_install(args):
    # The PrimeBrew app from a GitHub release (default: latest), or a local .wgt path.
    src = args.get('wgt') or 'latest'
    if os.path.exists(src):
        data = open(src, 'rb').read()
    else:
        api = 'https://api.github.com/repos/TheSmuks/primebrew/releases/' + ('latest' if src == 'latest' else 'tags/' + src)
        rel = json.load(urllib.request.urlopen(api, timeout=20))
        asset = next(a for a in rel['assets'] if a['name'].endswith('.wgt'))
        data = urllib.request.urlopen(asset['browser_download_url'], timeout=60).read()
        src = rel['tag_name']
    b64 = __import__('base64').b64encode(data).decode()
    js = open(INSTALL_JS).read().replace('__WGT__', b64).replace('__PKG__', args.get('package', 'PrimeBrew1')).replace('__CMD__', '')
    return 'wgt %s (%d bytes)\n' % (src, len(data)) + tv_node_js(js)


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
    ('tv_status', 'PrimeBrew debug service state on the TV (is the page connected?).', {},
     lambda a: 'power: %s, page last seen: %s s ago\n%s' % (power_state(), page_age(), run(['python3', 'tvdebug.py', 'status']))),
    ('tv_reset', 'Reload the PrimeBrew page in place (fresh page, latest release) and wait for it to reconnect. Needs PrimeBrew already open on the TV.',
     {}, tv_reset),
    ('tv_power', 'TV power: action = status | on (Wake-on-LAN) | off | restart (full reboot via 5 s Power hold).',
     {'action': {'type': 'string', 'enum': ['status', 'on', 'off', 'restart']}}, tv_power),
    ('tv_apps', 'Query, launch or close a TV app by id (default PrimeBrew launcher). TizenBrew is ' + TIZENBREW + '.',
     {'app': {'type': 'string'}, 'action': {'type': 'string', 'enum': ['status', 'launch', 'close']}}, tv_apps),
    ('tv_logs', 'Console output from the PrimeBrew page on the TV (newest last).',
     {'filter': {'type': 'string', 'description': 'regex to keep matching lines'},
      'last': {'type': 'integer', 'description': 'how many lines (default 60)'},
      'width': {'type': 'integer', 'description': 'truncate lines (default 400)'}}, logs),
    ('tv_eval', 'Evaluate JavaScript in the PrimeBrew page on the TV; returns the JSON result (Promises are awaited).',
     {'js': {'type': 'string'}}, lambda a: evaljs(a['js'])),
    ('tv_node', 'Run JavaScript in the TV-side PrimeBrew service (Node 4, ES5, with require: fs, net, child_process...). Promises are awaited.',
     {'js': {'type': 'string'}}, lambda a: tv_node_js(a['js'])),
    ('tv_install', 'Install the PrimeBrew app on the TV through its own sdbd (no Host-IP change): wgt = release tag (default latest) or a local .wgt path.',
     {'wgt': {'type': 'string'}, 'package': {'type': 'string'}}, tv_install),
    ('tv_sdb', 'Run an sdb shell command on the TV through its own sdbd, e.g. "0 vd_applist" (whitelisted commands only on retail TVs).',
     {'cmd': {'type': 'string'}}, tv_sdb),
    ('tv_screen', 'What is on the TV screen: URL, focused element, video state, ad breaks, visible text.', {}, lambda a: evaljs(SCREEN_JS)),
    ('tv_keys', 'Press remote keys, e.g. ["KEY_DOWN","KEY_ENTER","wait:2","KEY_RETURN"] (KEY_RETURN = Back). Also text:STR.',
     {'keys': {'type': 'array', 'items': {'type': 'string'}}}, lambda a: run(['python3', 'tvremote.py'] + a['keys'], timeout=120)),
    ('tv_screenshot', 'Picture of the PrimeBrew UI on the TV, rendered from the page (DRM video shows as black).',
     {'scale': {'type': 'number', 'description': 'size relative to 1920x1080 (default 0.5)'}}, screenshot),
    ('tv_launch', 'Open PrimeBrew via its launcher. Only reliable when TizenBrew is not running; a cold TizenBrew may open its auto-launch module (TizenTube) instead.', {}, lambda a: tv_rest('POST', 'applications/' + APP)),
    ('tv_restart_tizenbrew', 'Close TizenBrew and reopen PrimeBrew. Unreliable: usually opens the auto-launch module (TizenTube). Prefer tv_reset.', {},
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
