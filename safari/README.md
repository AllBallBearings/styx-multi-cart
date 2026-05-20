# Safari / App Store scaffold

Xcode project generated from the web extension via:

```bash
xcrun safari-web-extension-converter \
  --project-location ./safari \
  --app-name "Styx Multi-Cart" \
  --bundle-identifier com.jaredgoolsby.styx.multicart \
  --swift --copy-resources --no-open --no-prompt --force \
  /path/to/staged/extension/sources
```

**Note**: the converter was run against a staged copy of the extension at `/tmp/styx-ext-src` (which excluded `safari/`, `docs/`, etc.) so it would not recursively copy this directory into itself. To regenerate after changing extension source, restage the sources and re-run with `--force`.

## What's here

- `Styx Multi-Cart.xcodeproj` — Xcode project.
- `Shared (App)` and `Shared (Extension)` — Swift app shim + extension wrapper code shared between platforms.
- `iOS (App)` / `iOS (Extension)` — iOS targets.
- `macOS (App)` / `macOS (Extension)` — macOS Safari targets.
- `Shared (Extension)/Resources/` — copy of the web extension files (`manifest.json`, `background.js`, etc.).

## Local testing on macOS Safari

1. Open `Styx Multi-Cart.xcodeproj` in Xcode.
2. Select the **macOS (App)** scheme.
3. Build (⌘B) and Run (⌘R). The host app launches and registers the extension with Safari.
4. In Safari: `Safari → Settings → Extensions` → enable "Styx Multi-Cart".
5. For unsigned local builds: `Safari → Develop → Allow Unsigned Extensions` (per session).

## App Store submission

**Out of scope for this pass.** Requires:

- Apple Developer Program enrollment ($99/year).
- App Store Connect listing (icon, screenshots, description, privacy nutrition labels).
- Signing identity and provisioning profiles configured in Xcode.
- App Review (typically 1–3 days; iOS/macOS app reviewers are stricter than Chrome Web Store).

Defer until traction on the Chrome Web Store.
