# PrimeBrew

TizenBrew mod for Prime Video, in the spirit of TizenTube. Right now it is a **demo**: it opens
`https://www.primevideo.com` and shows a blue overlay for 30 s with the user agent and which DRM
systems (Widevine / PlayReady) the TV exposes.

## Install on the TV

TizenBrew fetches modules through jsDelivr, which only serves **public** GitHub repos and **public**
npm packages. Pick one:

- **GitHub** (repo must be public): in TizenBrew → Module Manager → Add, enter
  `gh/TheSmuks/primebrew@v0.1.0` (pin a tag; a bare branch is cached by jsDelivr for hours).
- **npm**: `npm publish`, then add `npm/primebrew`.
- **Fork/rename anywhere**: change `name`/`repository` in `package.json`, push, use
  `gh/<you>/<repo>@<tag>`.

## Release

```sh
npm test                      # syntax check
npm version patch             # bumps version, commits, tags
git push --follow-tags        # then use gh/TheSmuks/primebrew@<new tag>
```

Keep `VERSION` in `userScript.js` in sync so the overlay tells you which build loaded.

## Spike checklist

Report back: does the overlay appear, the two DRM lines, can you log in, does a title play
(and at what quality), do remote keys work.
