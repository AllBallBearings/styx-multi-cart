#!/usr/bin/env bash
# Sync the generated web-extension bundle into the checked-in Safari Xcode
# project resources. Run after changing extension source files.
#
# By default the synced resources keep the developer-only debug controls
# (entitlement presets) so you can debug paywall states from an Xcode run.
# Pass --prod (or set STYX_STRIP_DEBUG_ENT=1) before archiving for the App
# Store to strip the client-side premium bypass, matching the Chrome Web
# Store build produced by scripts/build-zip.sh.
#
#   npm run sync:safari            # dev build — controls kept
#   npm run sync:safari -- --prod  # release build — controls stripped

set -euo pipefail

cd "$(dirname "$0")/.."

STRIP_DEBUG_ENT="${STYX_STRIP_DEBUG_ENT:-0}"
for arg in "$@"; do
  case "$arg" in
    --prod|--strip-debug-ent) STRIP_DEBUG_ENT=1 ;;
    *) echo "warning: ignoring unknown argument: $arg" >&2 ;;
  esac
done

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

if [[ "$STRIP_DEBUG_ENT" == "1" ]]; then
  if ! command -v python3 >/dev/null 2>&1; then
    echo "error: python3 is required to strip developer controls for a --prod build" >&2
    exit 1
  fi
  python3 scripts/strip-debug-ent.py "$DEST/popup.html" "$DEST/popup.js"
  echo "synced PRODUCTION resources (developer entitlement controls stripped) to $DEST"
else
  echo "synced DEV resources (developer entitlement controls kept) to $DEST"
  echo "  → run 'npm run sync:safari -- --prod' before archiving for the App Store"
fi

