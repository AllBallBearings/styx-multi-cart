#!/usr/bin/env bash
# Build a Chrome Web Store-ready zip of the extension.
#
# Output: dist/styx-multi-cart-v<version>.zip containing only the files
# Chrome needs to load the extension. Excludes docs, store assets,
# dev helpers, and VCS metadata.

set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 is required to read the manifest version" >&2
  exit 1
fi

VERSION=$(python3 -c 'import json,sys; print(json.load(open("manifest.json"))["version"])')

if [[ -z "$VERSION" ]]; then
  echo "error: could not read version from manifest.json" >&2
  exit 1
fi

mkdir -p dist
OUT="dist/styx-multi-cart-v${VERSION}.zip"
rm -f "$OUT"

FILES=(
  manifest.json
  background.js
  content.js
  observer.js
  popup.html
  popup.css
  popup.js
  status.html
  status.css
  status.js
  LICENSE
  icons/icon16.png
  icons/icon32.png
  icons/icon48.png
  icons/icon128.png
)

for f in "${FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "error: missing required file: $f" >&2
    exit 1
  fi
done

zip -q "$OUT" "${FILES[@]}"

echo "built $OUT"
unzip -l "$OUT"
