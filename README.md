# PrimeBrew

TizenBrew mod for Prime Video, in the spirit of TizenTube. It opens `https://www.primevideo.com`
and makes it usable with a TV remote.

## Remote controls

| Key | Browsing | In the player |
| --- | --- | --- |
| Arrows | move highlight (scrolls when nothing is that way) | ←/→ seek 10 s · ↑/↓ highlight player controls |
| OK | click highlighted item | play/pause (or click highlighted control) |
| Back | previous page · leave a text field | leave control highlight, then previous page |
| Media keys | — | play/pause/stop, FF/RW 10 s |

## Install on the TV

TizenBrew fetches modules through jsDelivr, which only serves **public** GitHub repos and **public**
npm packages.

- **GitHub**: TizenBrew → Module Manager → Add GitHub module → `TheSmuks/primebrew@v0.2.0`
  (pin a tag; a bare branch is cached by jsDelivr for hours).
- **npm**: `npm publish`, then Add NPM module → `primebrew`.
- **Anywhere else**: change `name`/`repository` in `package.json`, push, add `<you>/<repo>@<tag>`.

No typing on the TV: `tools/tvremote.py` drives the TV over LAN (pair once with "Allow"). Open
the add-module field on the TV, then `python3 tools/tvremote.py text:TheSmuks/primebrew@v0.2.0`.
Requires `pip install websockets`. Sign in to Prime the same way: select the field on the TV,
run `tvremote.py text:-` and type (hidden). `hold:KEY_POWER:5` does a full reboot.

## Release

```sh
npm test                      # syntax check + navigation test
npm version minor             # bumps version, commits, tags
git push --follow-tags        # then add <user>/primebrew@<new tag> on the TV
```

Keep `VERSION` in `userScript.js` in sync: the 5 s badge tells you which build loaded.
