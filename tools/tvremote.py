#!/usr/bin/env python3
"""Drive a Samsung Tizen TV over its LAN remote API (port 8002).

usage: tvremote.py [--ip IP] ACTION...
  ACTION = KEY_xxx | text:STRING | text:- (prompt, hidden) | hold:KEY_xxx:SECONDS | wait:SECONDS
  e.g. hold:KEY_POWER:5 = full reboot (needed after changing developer-mode Host PC IP)
First run pops an "Allow" dialog on the TV; the token is saved next to this file.
Prints TV events (e.g. ms.remote.imeStart = on-screen keyboard is open).
"""
import asyncio, base64, getpass, json, pathlib, ssl, sys
import websockets

TOKEN_FILE = pathlib.Path(__file__).with_name('.tv-token')


def payload(action, cmd='Click'):
    if action.startswith('text:'):
        return {'Cmd': base64.b64encode(action[5:].encode()).decode(),
                'DataOfCmd': 'base64', 'TypeOfRemote': 'SendInputString'}
    return {'Cmd': cmd, 'DataOfCmd': action, 'Option': 'false', 'TypeOfRemote': 'SendRemoteKey'}


def send(ws, p):
    return ws.send(json.dumps({'method': 'ms.remote.control', 'params': p}))


async def main(ip, actions):
    name = base64.b64encode(b'PrimeBrew').decode()
    url = f'wss://{ip}:8002/api/v2/channels/samsung.remote.control?name={name}'
    if TOKEN_FILE.exists():
        url += '&token=' + TOKEN_FILE.read_text().strip()
    ctx = ssl.create_default_context()
    ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE  # TV uses a self-signed cert

    async with websockets.connect(url, ssl=ctx, open_timeout=30) as ws:
        msg = json.loads(await asyncio.wait_for(ws.recv(), 60))  # waits for "Allow" on first run
        print('<', msg.get('event'))
        if msg.get('event') != 'ms.channel.connect':
            sys.exit(f'not authorized: {msg}')
        token = msg.get('data', {}).get('token')
        if token:
            TOKEN_FILE.write_text(token)

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


if __name__ == '__main__':
    args = sys.argv[1:]
    ip = '192.168.31.105'
    if args[:1] == ['--ip']:
        ip, args = args[1], args[2:]
    asyncio.run(main(ip, args))
