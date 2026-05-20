# scripts/

## `build-zip.sh`

Builds the Chrome Web Store upload zip.

```bash
bash scripts/build-zip.sh
```

Output: `dist/styx-multi-cart-v<version>.zip`. The version is read from `manifest.json`.

### What's in the zip

Only the runtime files: `manifest.json`, the JS/HTML/CSS, the `icons/` PNGs, and `LICENSE`.

### What's excluded

`docs/`, `store-assets/`, `safari/`, `scripts/`, `dist/`, `AGENT_HANDOFF.md`, `README.md`, `generate_icons.html`, `icons/_render.py`, `.git/`, `.claude/`.

## Uploading to the Chrome Web Store

1. Bump `manifest.json` `"version"` (semver: increment patch for bugfixes, minor for features).
2. `bash scripts/build-zip.sh`
3. Sign in to <https://chrome.google.com/webstore/devconsole>.
4. New item → upload `dist/styx-multi-cart-v<version>.zip`.
5. Fill in the listing fields. Copy/paste source text from:
   - Privacy policy URL: `docs/privacy.md` (live at the GitHub Pages URL).
   - Per-permission justifications: `docs/permissions.md`.
   - Store assets: `store-assets/`.
6. Submit for review.

The first review typically takes 1–3 business days.
