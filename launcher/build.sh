#!/usr/bin/env bash
# Build and sign dist/PrimeBrew.wgt (no Tizen Studio needed).
# env: AUTHOR_P12 (author cert path), AUTHOR_PW; optional TIZENJS (tizen.js CLI command).
# Distributor = Tizen SDK public cert (tizen.js downloads it), as TizenBrew uses;
# accepted by developer-mode TVs (Tizen < 7).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${AUTHOR_P12:?}" "${AUTHOR_PW:?}"
# Tarball URL, not github:…: npx fails on git specs ("GitFetcher requires an Arborist constructor").
TIZENJS=${TIZENJS:-npx -y https://codeload.github.com/reisxd/tizen.js/tar.gz/45b00106149d0c8eff74ead4a979c909dd80efd6}
VERSION=$(node -p "require('./package.json').version")
OUT=$PWD/dist/PrimeBrew.wgt
AUTHOR_P12=$(realpath "$AUTHOR_P12")

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cp launcher/config.xml launcher/index.html launcher/icon.png "$WORK/"
sed -i "s/version=\"0.0.0\"/version=\"$VERSION\"/" "$WORK/config.xml"

mkdir -p dist
# tizen.js packages the current directory.
(cd "$WORK" && $TIZENJS build . -t wgt -o "$OUT" --author "$AUTHOR_P12" --authorPwd "$AUTHOR_PW" -p public)
echo "built dist/PrimeBrew.wgt ($VERSION)"
