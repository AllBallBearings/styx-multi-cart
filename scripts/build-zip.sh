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

npm run build

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
  ExtPay.js
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

# Refuse to build a zip with the EXTPAY_ID placeholder still in place — that
# would publish a build whose Upgrade button leads to ExtensionPay's 404.
# Override for sub-1.0 dev builds with: STYX_ALLOW_PLACEHOLDER_EXTPAY_ID=1
if grep -q 'EXTPAY_ID = "REPLACE_ME"' background.js; then
  if [[ "${STYX_ALLOW_PLACEHOLDER_EXTPAY_ID:-0}" != "1" ]]; then
    echo "error: background.js still has EXTPAY_ID = \"REPLACE_ME\"." >&2
    echo "       Fill it in (see docs/internal/EXTENSIONPAY-SETUP.md) or" >&2
    echo "       re-run with STYX_ALLOW_PLACEHOLDER_EXTPAY_ID=1 for a dev build." >&2
    exit 1
  fi
  echo "warning: building with placeholder EXTPAY_ID — for local dev only." >&2
fi

# Belt-and-suspenders: DEBUG is now runtime-controlled by the mc.dev.v1
# storage flag (popup Settings → Developer mode), so there's no good reason
# to hard-code `DEBUG = true` in source. Catch the historic mistake of doing
# so anyway, across every script that carries a DEBUG switch.
# Override with STYX_ALLOW_DEBUG_TRUE=1 if you genuinely want it.
for f in background.js observer.js content.js; do
  if grep -qE '^\s*(let|var|const)\s+DEBUG\s*=\s*true' "$f"; then
    if [[ "${STYX_ALLOW_DEBUG_TRUE:-0}" != "1" ]]; then
      echo "error: $f has DEBUG = true hardcoded." >&2
      echo "       DEBUG is runtime-controlled by Settings → Developer mode now;" >&2
      echo "       flip it back to false and toggle from the popup instead." >&2
      echo "       Override with STYX_ALLOW_DEBUG_TRUE=1 if you really mean it." >&2
      exit 1
    fi
    echo "warning: building with DEBUG = true hardcoded in $f — verbose logs always on." >&2
  fi
done

# Stage the files into a temp dir and strip developer-only blocks before
# zipping, so the published artifact carries no in-UI premium bypass. The
# working tree is left untouched (devs loading unpacked keep the controls).
OUT_ABS="$(pwd)/$OUT"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

for f in "${FILES[@]}"; do
  mkdir -p "$STAGE/$(dirname "$f")"
  cp "$f" "$STAGE/$f"
done

# Delete everything between MC_DEBUG_ENT_START / MC_DEBUG_ENT_END (inclusive)
# in the staged popup. These markers wrap the entitlement preset buttons +
# their handler — forging premium straight into chrome.storage.local. The
# strip MUST find a marker in each file or the build fails (so a refactor that
# drops the markers can't silently ship the bypass). Override the whole strip
# for a dev-flavored zip with STYX_KEEP_DEBUG_ENT=1.
if [[ "${STYX_KEEP_DEBUG_ENT:-0}" == "1" ]]; then
  echo "warning: keeping developer entitlement controls in the zip (STYX_KEEP_DEBUG_ENT=1)." >&2
else
  python3 scripts/strip-debug-ent.py "$STAGE/popup.html" "$STAGE/popup.js"
fi

( cd "$STAGE" && zip -q "$OUT_ABS" "${FILES[@]}" )

echo "built $OUT"
unzip -l "$OUT"
