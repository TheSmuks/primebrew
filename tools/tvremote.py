#!/usr/bin/env python3
"""Drive a Samsung Tizen TV over its LAN remote API (port 8002).

usage: tvremote.py [--ip IP] keyboard
         interactive: arrows/Enter/Esc(=Back) drive the TV; typed or pasted text replaces
         the open TV text field (select it on the TV first); Backspace deletes; Ctrl-C quits.
       tvremote.py [--ip IP] ACTION...
         ACTION = KEY_xxx | text:STRING | text:- (prompt, hidden) | hold:KEY_xxx:SECONDS | wait:SECONDS
         e.g. hold:KEY_POWER:5 = full reboot (needed after changing developer-mode Host PC IP)
First run pops an "Allow" dialog on the TV; the token is saved next to this file.
"""
import asyncio, base64, getpass, json, os, pathlib, re, ssl, sys, termios, tty
import websockets

TOKEN_FILE = pathlib.Path(__file__).with_name('.tv-token')
KEYMAP = {'\x1b[A': 'KEY_UP', '\x1b[B': 'KEY_DOWN', '\x1b[C': 'KEY_RIGHT', '\x1b[D': 'KEY_LEFT',
          '\x1b': 'KEY_RETURN', '\r': 'KEY_ENTER', '\n': 'KEY_ENTER', '\r\n': 'KEY_ENTER'}
TOKENS = re.compile(r'\x1b\[[A-D]|\x1b\[[0-9;]*[~A-Za-z]|\x1b|\r\n|\r|\n|\x7f|\x03|[^\x1b\r\n\x7f\x03]+')


def payload(action, cmd='Click'):
    if action.startswith('text:'):
        return {'Cmd': base64.b64encode(action[5:].encode()).decode(),
                'DataOfCmd': 'base64', 'TypeOfRemote': 'SendInputString'}
    return {'Cmd': cmd, 'DataOfCmd': action, 'Option': 'false', 'TypeOfRemote': 'SendRemoteKey'}


def send(ws, p):
    return ws.send(json.dumps({'method': 'ms.remote.control', 'params': p}))


async def connect(ip):
    name = base64.b64encode(b'PrimeBrew').decode()
    url = f'wss://{ip}:8002/api/v2/channels/samsung.remote.control?name={name}'
    if TOKEN_FILE.exists():
        url += '&token=' + TOKEN_FILE.read_text().strip()
    ctx = ssl.create_default_context()
    ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE  # TV uses a self-signed cert
    ws = await websockets.connect(url, ssl=ctx, open_timeout=30)
    msg = json.loads(await asyncio.wait_for(ws.recv(), 60))  # waits for "Allow" on first run
    if msg.get('event') != 'ms.channel.connect':
        sys.exit(f'not authorized: {msg}')
    token = msg.get('data', {}).get('token')
    if token:
        TOKEN_FILE.write_text(token)
    return ws


async def run_actions(ws, actions):
    async def listen():
        async for raw in ws:
            m = json.loads(raw)
            print('<', m.get('event'), json.dumps(m.get('data'))[:200])
    listener = asyncio.create_task(listen())
    for a in actions:
        if a.startswith('wait:'):
            await asyncio.sleep(float(a[5:]))
            continue
        if a.startswith('hold:'):
            _, key, secs = a.split(':')
            await send(ws, payload(key, 'Press'))
            await asyncio.sleep(float(secs))
            await send(ws, payload(key, 'Release'))
        elif a == 'text:-':
            await send(ws, payload('text:' + getpass.getpass('text for TV (hidden): ')))
            a = 'text:<hidden>'
        else:
            await send(ws, payload(a))
        print('>', a)
        await asyncio.sleep(0.6)
    await asyncio.sleep(1.5)
    listener.cancel()


async def keyboard(ws):
    # SendInputString replaces the whole field (tested on a Q75B), and this TV doesn't report
    # the field's content back, so we keep what we typed and resend it all on every change.
    # Any remote key (Enter/Esc/arrows) means "done with this field" and starts a fresh one.
    field = ''

    def status(note=''):
        sys.stdout.write(f'\r\x1b[K[typed: {field!r}] {note}')
        sys.stdout.flush()

    loop, keys = asyncio.get_running_loop(), asyncio.Queue()
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    tty.setraw(fd)
    loop.add_reader(fd, lambda: keys.put_nowait(os.read(fd, 4096).decode(errors='ignore')))
    print('keyboard mode: arrows/Enter/Esc(Back) drive the TV, type or paste text, Ctrl-C quits\r')
    status()
    try:
        while True:
            for tok in TOKENS.findall(await keys.get()):
                if tok == '\x03':
                    return
                if tok in KEYMAP:
                    await send(ws, payload(KEYMAP[tok]))
                    field = ''
                    status(KEYMAP[tok])
                elif tok.startswith('\x1b'):
                    continue  # other escape sequences (F-keys etc.)
                else:
                    field = field[:-1] if tok == '\x7f' else field + tok
                    await send(ws, payload('text:' + field))
                    status()
    finally:
        loop.remove_reader(fd)
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
        print()


async def main(ip, args):
    ws = await connect(ip)
    async with ws:
        await (keyboard(ws) if args == ['keyboard'] else run_actions(ws, args))


if __name__ == '__main__':
    args = sys.argv[1:]
    ip = '192.168.31.105'
    if args[:1] == ['--ip']:
        ip, args = args[1], args[2:]
    asyncio.run(main(ip, args))
