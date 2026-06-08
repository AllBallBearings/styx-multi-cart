#!/usr/bin/env python3
"""Strip developer-only debug-entitlement blocks from popup files.

Deletes everything between the MC_DEBUG_ENT_START / MC_DEBUG_ENT_END markers
(inclusive) in each file passed as an argument. Those markers wrap the debug
menu's entitlement preset buttons + their click handler, which forge a premium
state straight into chrome.storage.local — a client-side premium bypass that
must not ship in any production build (Chrome Web Store zip or Safari App Store
archive).

Exits non-zero if a file has no markers, or if any debug-entitlement code
survives the strip, so a refactor that drops or renames the markers can't
silently re-ship the bypass.

Used by scripts/build-zip.sh (Chrome) and scripts/sync-safari-resources.sh
(Safari, with --prod) so both platforms strip identically.
"""
import re
import sys

# Keep this regex in sync with tests/unit/debug-ent-strip.test.js.
MARKER = re.compile(
    r"[ \t]*(?:<!--|/\*)\s*MC_DEBUG_ENT_START\s*(?:-->|\*/)"
    r".*?"
    r"(?:<!--|/\*)\s*MC_DEBUG_ENT_END\s*(?:-->|\*/)[ \t]*\n?",
    re.DOTALL,
)


def strip_file(path):
    with open(path, encoding="utf-8") as fh:
        src = fh.read()
    stripped, n = MARKER.subn("", src)
    if n == 0:
        sys.exit(f"error: no MC_DEBUG_ENT markers found in {path}; refusing to ship.")
    if "MC_DEBUG_ENT" in stripped or "data-debug-ent" in stripped:
        sys.exit(f"error: residual debug-entitlement code left in {path} after strip.")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(stripped)
    name = path.replace("\\", "/").rsplit("/", 1)[-1]
    print(f"stripped {n} developer entitlement block(s) from {name}")


def main(argv):
    if not argv:
        sys.exit("usage: strip-debug-ent.py <file> [<file> ...]")
    for path in argv:
        strip_file(path)


if __name__ == "__main__":
    main(sys.argv[1:])
