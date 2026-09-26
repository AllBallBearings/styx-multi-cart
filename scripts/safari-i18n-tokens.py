#!/usr/bin/env python3
"""Rewrite the Safari copy of _locales so placeholders survive Safari.

Safari's chrome.i18n.getMessage() drops a `$N` substitution (and the character
before it) whenever `$N` follows a non-whitespace character, e.g. `"$1"`,
`($1`, `v$1`, `/$2`. About a third of our placeholder messages hit this, so
toasts and confirm dialogs came out as `Created ".` or
`" will be permanently removed.` Chrome parses the same files correctly.

Fix: in the Safari bundle only, replace each `$N` with `{{N}}` and drop the
`placeholders` blocks. A message with no `$` is returned untouched by Safari,
and the t() helpers in popup.js / observer.js / src/background/index.js
substitute the `{{N}}` tokens themselves. On Chrome the tokens never appear, so
that step is a no-op there.

usage: safari-i18n-tokens.py <path to the Safari copy of _locales>
"""
import glob
import json
import re
import sys


def convert(path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)

    for key, entry in data.items():
        placeholders = entry.pop("placeholders", None)
        if placeholders:
            for name, spec in placeholders.items():
                # The rewrite is only valid while every placeholder is the
                # identity mapping ("1" -> "$1"). Fail loudly rather than ship
                # garbled text.
                if spec.get("content") != "$" + name:
                    sys.exit(f"{path}: {key}: placeholder {name!r} is not $-{name}")
            entry["message"] = re.sub(r"\$(\d)", r"{{\1}}", entry["message"])
        # Any `$` still left is a literal dollar sign (e.g. "$9.99 / yr").
        # Safari also eats `$9` / `$1` in those, printing ".99 / yr", so hide
        # them behind {{D}}; t() turns it back into "$".
        entry["message"] = entry["message"].replace("$", "{{D}}")

    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: safari-i18n-tokens.py <_locales dir>")
    files = sorted(glob.glob(sys.argv[1] + "/*/messages.json"))
    if not files:
        sys.exit(f"no messages.json found under {sys.argv[1]}")
    for f in files:
        convert(f)
    print(f"rewrote placeholders to {{{{N}}}} tokens in {len(files)} Safari locale files")
