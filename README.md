# PrimeBrew

TizenBrew mod for Prime Video, in the spirit of TizenTube. It runs **Amazon's own TV app**
(the living-room UI other smart TVs load from `atv-ext-eu.amazon.com/blast-app-hosting`), with
QR / `primevideo.com/mytv` code sign-in and full remote navigation. A small launcher app puts a
**PrimeBrew** icon on the TV home screen that opens straight into it.

## How TV mode works

Amazon's TV app expects a native player bridge ("Hawaii"/Ruby) from the TV maker's firmware.
`tv.js` provides one in JavaScript: it answers the app's device/version queries, plays the DASH
streams the app opens with [Shaka Player](https://github.com/shaka-project/shaka-player), and
relays PlayReady license requests back to the app, which fetches licenses with your session.
It also maps the Samsung remote's Back and Play/Pause keys, which the app doesn't know.

**Ad skipping (TV mode):** the app knows where its server-inserted ads are (its playback
timeline). `tv.js` reads that timeline, and when playback reaches an ad break it jumps to the end
of the whole break in one seek, however many ads are chained. Because playback crossed the
break, the app counts the ads as watched and doesn't pull you back.

The website mode below (`userScript.js` on www.primevideo.com) is kept as a fallback.

## Website mode: remote controls

| Key | Browsing | In the player |
| --- | --- | --- |
| Arrows | move highlight (scrolls when nothing is that way) | ←/→ seek 10 s · ↑/↓ highlight player controls |
| OK | open highlighted item (a title card opens the title) | play/pause (or click highlighted control) |
| Back | previous page (exits on the first page) · leave a text field | leave control highlight, then previous page |
| Media keys | — | play/pause/stop, FF/RW 10 s |

## Automatic skipping

- **Ads**: like the Morphe Android TV patch, it seeks past server-inserted ad breaks using the
  player's ad countdown (≤ 90 s per jump, so a 3-minute pod takes two jumps).
- **Intro / recap / next episode**: clicks the skip buttons Prime shows.

## Debugging from the LAN

`service.js` runs on the TV (TizenBrew starts it with the mod) and relays between the page and
`tools/tvdebug.py`: `status`, `logs [-f]`, `snapshot`, `eval JS`. Every LAN request must be
signed with the private half of `PUBLIC_KEY` in `service.js` (`tools/debug.key`, never
committed), because a command runs JS in your logged-in Prime session.
**Forks: replace `PUBLIC_KEY`** (`openssl genpkey -algorithm RSA -out debug.key && openssl pkey -in debug.key -pubout`).

## Install on the TV

Needs TizenBrew, with the TV's developer-mode Host PC IP set to `127.0.0.1`.

1. **Mod**: TizenBrew → Module Manager → Add GitHub module → `TheSmuks/primebrew`
   (no `@tag`: the launcher opens the module by this exact name, and jsDelivr serves the latest release).
2. **Launcher** (optional, home-screen icon): TizenBrew Installer → install from GitHub →
   `TheSmuks/primebrew` (uses the latest release's `PrimeBrew.wgt`). Or over sdb:
   `sdb push PrimeBrew.wgt /home/owner/share/tmp/sdk_tools/ && sdb shell 0 vd_appinstall PrimeBrew1 /home/owner/share/tmp/sdk_tools/PrimeBrew.wgt`

**Updates are automatic.** TizenBrew keeps a module's main file in memory until the TV fully
restarts, so the main file is `loader.js`, which fetches the latest release's `userScript.js`
on every launch. The 5-second badge shows the running version and whether the debug service is up.
(`service.js` still only updates after a full restart: hold Power for 5 s.)

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
