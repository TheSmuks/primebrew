# PrimeBrew

TizenBrew mod for Prime Video, in the spirit of TizenTube. It opens `https://www.primevideo.com`
and makes it usable with a TV remote. A small launcher app puts a **PrimeBrew** icon on the TV
home screen that opens straight into it.

## Remote controls

| Key | Browsing | In the player |
| --- | --- | --- |
| Arrows | move highlight (scrolls when nothing is that way) | ←/→ seek 10 s · ↑/↓ highlight player controls |
| OK | click highlighted item | play/pause (or click highlighted control) |
| Back | previous page · leave a text field | leave control highlight, then previous page |
| Media keys | — | play/pause/stop, FF/RW 10 s |

## Install on the TV

Needs TizenBrew, with the TV's developer-mode Host PC IP set to `127.0.0.1`.

1. **Mod**: TizenBrew → Module Manager → Add GitHub module → `TheSmuks/primebrew`
   (no `@tag`: the launcher opens the module by this exact name, and jsDelivr serves the latest release).
2. **Launcher** (optional, home-screen icon): TizenBrew Installer → install from GitHub →
   `TheSmuks/primebrew` (uses the latest release's `PrimeBrew.wgt`). Or over sdb:
   `sdb push PrimeBrew.wgt /home/owner/share/tmp/sdk_tools/ && sdb shell 0 vd_appinstall PrimeBrew1 /home/owner/share/tmp/sdk_tools/PrimeBrew.wgt`

The launcher is signed with the Tizen SDK public distributor cert, which developer-mode TVs
before Tizen 7 accept. Tizen 7+ needs a Samsung cert: TizenBrew Installer re-signs it for you.

### No typing on the TV

`tools/tvremote.py` drives the TV over LAN (`pip install websockets`; pair once with "Allow").
`tvremote.py keyboard` turns your computer keyboard into the remote: arrows/Enter/Esc (Back)
drive the TV, and typed or pasted text goes into the selected TV text field. For secrets,
`tvremote.py text:-` prompts without echo. Works for the
module name and for the Prime sign-in. `hold:KEY_POWER:5` does a full reboot.

## Release

```sh
npm test                      # syntax check, navigation test, version sync
npm version minor             # bump package.json, then set the same VERSION in userScript.js
git push && git push --tags   # CI signs PrimeBrew.wgt, attaches it to the release, purges jsDelivr
```

CI needs two repo secrets: `TIZEN_AUTHOR_P12` (base64 of the author `.p12`) and
`TIZEN_AUTHOR_PW`. Keep the same author cert forever: the TV only accepts launcher updates
signed by the cert that installed it. Forks: make your own with
`npx https://codeload.github.com/reisxd/tizen.js/tar.gz/main create-tizen-cert --name <you> --password <pw> --output author.p12`.
Local build: `AUTHOR_P12=… AUTHOR_PW=… launcher/build.sh`.
