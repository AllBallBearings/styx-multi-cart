#!/usr/bin/env bash
# Sync the generated web-extension bundle into the checked-in Safari Xcode
# project resources. Run after changing extension source files.

set -euo pipefail

cd "$(dirname "$0")/.."

npm run build

DEST="safari/Styx Multi-Cart/Shared (Extension)/Resources"

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
  ExtPay.js
  LICENSE
)

for f in "${FILES[@]}"; do
  cp "$f" "$DEST/$f"
done

mkdir -p "$DEST/icons"
cp icons/icon16.png "$DEST/icons/icon16.png"
cp icons/icon32.png "$DEST/icons/icon32.png"
cp icons/icon48.png "$DEST/icons/icon48.png"
cp icons/icon128.png "$DEST/icons/icon128.png"

echo "synced web extension resources to $DEST"
