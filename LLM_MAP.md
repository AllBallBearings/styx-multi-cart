# Repo map: styx-multi-cart

> Auto-generated skeleton map. Function/method bodies are elided —
> `...` and `…` mark elisions. Request specific files in full when you
> need implementation details.

## File tree
```
.claude/
  skills/
    chrome-web-store-assets/
      references/
        chrome-store-media-spec.md  (416 tok)
      scripts/
        fit_png.py  (491 tok)
        validate_assets.py  (1,311 tok)
      SKILL.md  (1,791 tok)
  launch.json  (117 tok)
  settings.local.json  (2,389 tok)
.github/
  ISSUE_TEMPLATE/
    bug_report.md  (171 tok)
docs/
  assets/
    css/
      style.css  (2,849 tok)
  internal/
    APP-STORE-CHECKLIST.md  (1,438 tok)
    EXTENSIONPAY-SETUP.md  (1,043 tok)
    IAP-SETUP.md  (1,190 tok)
    PROMO-CODES.md  (832 tok)
    TESTING-PURCHASES.md  (597 tok)
  MONETIZATION_PLAN.md  (2,522 tok)
  _config.yml  (35 tok)
  index.html  (3,028 tok)
  permissions.md  (1,142 tok)
  privacy.md  (1,155 tok)
  report-bug.md  (704 tok)
icons/
  _render.py  (1,283 tok)
lib/
  clear-cart.js  (821 tok)
  extpay-sync.js  (1,000 tok)
  helpers.js  (3,038 tok)
  native-sync.js  (982 tok)
  scrape.js  (2,008 tok)
  storage.js  (855 tok)
safari/
  Styx Multi-Cart/
    Shared (App)/
      Assets.xcassets/
        AccentColor.colorset/
          Contents.json  (48 tok)
        AppIcon.appiconset/
          Contents.json  (716 tok)
        LargeIcon.imageset/
          Contents.json  (111 tok)
        Contents.json  (27 tok)
      Resources/
        Base.lproj/
          Main.html  (351 tok)
        Script.js  (393 tok)
        Style.css  (274 tok)
      StoreManager.swift  (1,491 tok)
      ViewController.swift  (608 tok)
    Shared (Extension)/
      Resources/
        icons/
          _render.py  (1,283 tok)
        content.js  (6,377 tok)
        manifest.json  (1,404 tok)
        observer.js  (28,634 tok)
        popup.css  (13,440 tok)
        popup.html  (9,146 tok)
        popup.js  (23,462 tok)
        status.css  (1,010 tok)
        status.html  (897 tok)
        status.js  (505 tok)
      SafariWebExtensionHandler.swift  (574 tok)
    Styx Multi-Cart.xcodeproj/
      project.xcworkspace/
        contents.xcworkspacedata  (45 tok)
      xcuserdata/
        jaredgoolsby.xcuserdatad/
          xcschemes/
            xcschememanagement.plist  (192 tok)
      project.pbxproj  (16,439 tok)
    iOS (App)/
      Base.lproj/
        LaunchScreen.storyboard  (585 tok)
        Main.storyboard  (573 tok)
      AppDelegate.swift  (146 tok)
      Info.plist  (248 tok)
      SceneDelegate.swift  (97 tok)
    iOS (Extension)/
      Info.plist  (136 tok)
    macOS (App)/
      Base.lproj/
        Main.storyboard  (1,696 tok)
      AppDelegate.swift  (339 tok)
      Info.plist  (202 tok)
    macOS (Extension)/
      Info.plist  (136 tok)
    StyxMultiCart.storekit  (518 tok)
  README.md  (498 tok)
scripts/
  README.md  (302 tok)
  build-extension.mjs  (155 tok)
  build-zip.sh  (1,110 tok)
  patch-safari-manifest.py  (358 tok)
  strip-debug-ent.py  (493 tok)
  sync-safari-resources.sh  (585 tok)
src/
  background/
    index.js  (58,866 tok)
tests/
  e2e/
    fixtures.js  (3,369 tok)
    popup.spec.js  (1,537 tok)
  fixtures/
    amazon/
      cart-empty.html  (75 tok)
      cart-fallback-permissive.html  (200 tok)
      cart-flyout-ewc.html  (212 tok)
      cart-multi-item.html  (508 tok)
      cart-single-item.html  (331 tok)
      cart-spinner-image.html  (413 tok)
      cart-with-saved-for-later.html  (326 tok)
  scrape/
    scrape.test.js  (3,209 tok)
  unit/
    amazon-list-scraper.test.js  (1,714 tok)
    bulk-confirm-page.test.js  (1,033 tok)
    clear-cart-step.test.js  (1,298 tok)
    debug-ent-strip.test.js  (850 tok)
    devmode-logging-wiring.test.js  (754 tok)
    entitlement.test.js  (2,825 tok)
    extpay-sync.test.js  (1,829 tok)
    helpers.test.js  (3,307 tok)
    list-access.test.js  (825 tok)
    list-page-add.test.js  (1,318 tok)
    manifest-floating.test.js  (827 tok)
    native-sync.test.js  (855 tok)
    observer-atc-intercept.test.js  (4,790 tok)
    page-injected-no-dlog.test.js  (794 tok)
    storage.test.js  (1,570 tok)
  setup.js  (114 tok)
.gitignore  (70 tok)
.llmignore  (34 tok)
AGENT_HANDOFF.md  (9,521 tok)
HANDOFF-addtolist-buybox.md  (2,503 tok)
README.md  (2,259 tok)
content.js  (6,377 tok)
generate_icons.html  (2,121 tok)
manifest.json  (1,602 tok)
observer.js  (38,592 tok)
package.json  (235 tok)
playwright.config.js  (192 tok)
popup.css  (13,852 tok)
popup.html  (9,256 tok)
popup.js  (24,339 tok)
status.css  (1,010 tok)
status.html  (897 tok)
status.js  (505 tok)
vitest.config.js  (64 tok)
```

## File skeletons
### `.gitignore`
```text
dist/
.DS_Store
*.zip
node_modules/
coverage/
safari/build/
safari/**/*.xcodeproj/xcuserdata/
safari/**/*.xcodeproj/project.xcworkspace/xcuserdata/
__pycache__/
*.pyc

# Private operational notes (promo code plaintext, EXTPAY_ID, etc.)
docs/internal/
```

### `.llmignore`
```text
# generated / vendored — see memory: background.js built from src/background/index.js
background.js
ExtPay.js
test-results/
store-assets/
*.zip
```

### `AGENT_HANDOFF.md`
```md
# Agent Handoff
## Pre-Launch Anti-Piracy / Revenue Hygiene (added 2026-05-25)
## Monetization UI Phase (shipped 2026-05-25)
### What shipped
### Bug fixes worth remembering
### Files touched
### Open follow-ups
## Performance Plan (in progress — 2026-05-11)
### Findings
### Plan (in priority order)
## Roadmap to Public Launch (added 2026-05-11)
### Track A — Store readiness (Chrome / Edge / Firefox / Safari)
#### A1. Production hygiene
#### A2. Store listing assets
#### https://developer.chrome.com/docs/webstore/images?csw=1
#### A3. Cross-browser support
#### A4. Tests
### Track B — Free vs Pro monetization
#### B1. Tier design
#### B2. Billing infrastructure
#### B3. Gating implementation sketch
### Track C — Import Amazon Lists as Carts
#### C1. Feasibility
#### C2. UX sketch
#### C3. Implementation steps
### Track D — Cart editing & merging
#### D1. Edit a saved cart
#### D2. Merge Carts
### Track E — Status toast redesign (shipped 2026-05-12, commit 4cf5598)
### Track F — Hybrid batch + reconciliation restore
#### F1. Design
#### F2. Implementation checklist
#### F3. Decisions & edge cases
## Project Overview
## Current State
## What Was Built This Session
### 1. Save Cart from Any Amazon Page (`scrapeCartInBackground`)
### 2. Thumbnail Images Fixed
### 3. Return to Origin After Clear
### 4. On-Screen Status Overlay (Most Recent Feature)
```

### `HANDOFF-addtolist-buybox.md`
```md
# Handoff — "Add to List" buybox relocation (Part A)
## 1. Background / why this exists
### The hard constraint (verified live, June 2026, against the owner's account)
### The unblock (this work)
## 2. What was built (Part A)
### New code (`observer.js`, in the section before `// ---- Boot`)
### Pattern reused
## 3. Verification done
### Spike gotchas (automation artifacts, NOT feature bugs) — for the next agent re-testing live
## 4. Decisions locked (by the owner)
## 5. Open items / next steps
## 6. Cleanup note
## 7. Key file/line index
```

### `README.md`
```md
# Styx Multi-Cart
## What it does
## Install (Chrome / Edge / Brave / Arc / Opera / Vivaldi)
## Install (Safari)
## Install (Firefox)
## Developer mode & diagnostics
## Building for release
### Chrome / Edge / Brave / … (Chrome Web Store)
### Safari (App Store)
### Loading the dev build unpacked
## How to use
### How "Send All to Amazon Cart" works under the hood
## Files
## Adding custom toolbar icons (optional)
## Troubleshooting
## Privacy
```

### `content.js`
```js
/**
 * content.js — runs on Amazon cart pages.
 *
 * Two responsibilities:
 *   1. Scrape the current cart (ASIN, title, qty, price, image).
 *   2. Clear the current cart by clicking each item's "Delete" link.
 *
 * The popup talks to this script through chrome.runtime.sendMessage,
 * relayed by the background service worker.
 */
(function () {
  "use strict";
  // Re-injection guard. Besides the manifest declaration, background.js
  // injects this file on demand when a tab has no listener (Safari's "Ask"
  // site-access level blocks manifest content scripts while the activeTab
  // grant still allows scripting). A second evaluation must not register a
  // second onMessage listener or every request would get double responses.
  if (window.__styxMcContentLoaded) return;
  window.__styxMcContentLoaded = true;
  // Diagnostic logging — mirrors the popup's Developer mode switch (the
… (678 more non-blank lines elided)
```

### `generate_icons.html`
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Generate Styx icons</title>
    <style>
      body {
        font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          sans-serif;
        max-width: 640px;
        margin: 40px auto;
        padding: 0 20px;
        color: #131a22;
      }
      h1 { margin-bottom: 4px; }
      p { color: #4a5360; }
      button {
        font: inherit;
        font-weight: 600;
        background: #ff9900;
… (192 more non-blank lines elided)
```

### `manifest.json`
```json
{
  "manifest_version": 3,
  "name": "Styx Multi-Cart",
  "version": "1.0.1",
  "author": "Jared Goolsby",
  "homepage_url": "https://allballbearings.github.io/styx-multi-cart/",
  "description": "Save, switch, and restore multiple Amazon shopping carts. Local-only storage, no t…
  "permissions": [
  ],
  "host_permissions": [
  ],
  "background": {
  },
  "action": {
  },
  "icons": {
  },
  "content_scripts": [
  ],
  "web_accessible_resources": [
  ]
}
… (values elided; request full file if needed)
```

### `observer.js`
```js
/**
 * observer.js — runs on Amazon product pages and upsell/attach pages.
 *
 * Two jobs:
 *  1. On a product page (/dp/, /gp/product/), when the user clicks
 *     "Add to Cart", tell background.js the ASIN + title so the next
 *     upsell observation can be linked to it.
 *  2. On an upsell/attach surface, when the user picks a coverage option
 *     or declines, tell background.js so it can store the choice
 *     (24 h TTL) for later replay during cart restore.
 *
 * This script is intentionally read-only — it never auto-clicks anything.
 * Replay happens inside restoreCart via chrome.scripting.executeScript.
 */
(function () {
  "use strict";
  // Diagnostic logging — mirrors the popup's Developer mode switch (the
  // mc.dev.v1 flag in chrome.storage.local). When it's on, dlog/dwarn print to
  // this page's console AND forward to the service worker's in-memory ring
  // buffer, so the popup's "Copy diagnostic logs" button can gather logs from
… (3293 more non-blank lines elided)
```

### `package.json`
```json
{
  "name": "styx-multi-cart",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Chrome MV3 extension to save, switch, and restore multiple Amazon shopping carts.",
  "scripts": {
    "build": "node scripts/build-extension.mjs",
    "sync:safari": "bash scripts/sync-safari-resources.sh",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "test:all": "npm run build && npm run test && npm run test:e2e"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.1",
    "esbuild": "^0.21.5",
    "jsdom": "^25.0.1",
    "sinon-chrome": "^3.0.1",
    "vitest": "^2.1.9"
  },
  "dependencies": {
    "extpay": "^3.1.2"
  }
}
```

### `playwright.config.js`
```js
import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./tests/e2e", testMatch: /.*\.spec\.js$/, timeout: 30_000, expect: { timeout: 5_000 }, fullyParallel: false, // chrome e…
```

### `popup.css`
```css
/* Amazon Multi-Cart — popup styles
   Aim: feels native to Amazon (warm, slightly serif headline, the iconic
   yellow-orange CTA) without literally copying their identity. */
/* Author rules like .mc-tier-strip { display: flex } override the user-agent
   default [hidden] { display: none }. Force the attribute to win globally so
   element.hidden = true actually hides things. */
[hidden] { display: none !important; }
:root {
  --mc-bg: #ffffff;
  --mc-bg-soft: #f7f3ec;
  --mc-bg-sunk: #ece7dd;
  --mc-fg: #131a22;
  --mc-fg-soft: #4a5360;
  --mc-fg-muted: #7a8492;
  --mc-line: #e0d9cc;
  --mc-line-strong: #c9bfae;
  --mc-accent: #ff9900;       /* Amazon-ish amber */
  --mc-accent-strong: #e88a00;
  --mc-accent-ink: #1a1209;
  --mc-link: #0066c0;
… (1860 more non-blank lines elided)
```

### `popup.html`
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Styx Multi-Cart</title>
    <link rel="stylesheet" href="popup.css" />
  </head>
  <body>
    <header class="mc-header">
      <div class="mc-brand">
        <svg
          class="mc-logo"
          viewBox="0 0 32 32"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <!-- Background tile -->
          <rect width="32" height="32" rx="7" fill="#131a22" />
          <!-- Top cart (apex of the pyramid) -->
… (1045 more non-blank lines elided)
```

### `popup.js`
```js
/**
 * popup.js — drives the extension popup.
 *
 * All real work happens in the background service worker;
 * this file just renders state and forwards button clicks.
 */
(function () {
  "use strict";
  // The native Chrome side panel loads this page with ?surface=sidepanel so
  // it can fill the panel's width/height instead of the fixed popup size.
  // ("panel" is the legacy in-page-iframe value, kept for safety.)
  const _surface = new URLSearchParams(location.search).get("surface");
  if (
    _surface === "sidepanel" ||
    _surface === "panel" ||
    _surface === "floating"
  ) {
    document.documentElement.dataset.surface = _surface;
  }
  // In the side panel (and the floating modal iframe), window.close() would
… (2517 more non-blank lines elided)
```

### `status.css`
```css
/* Styx Multi-Cart — status window */
:root {
  --sc-bg:        #ffffff;
  --sc-bg-soft:   #f7f3ec;
  --sc-fg:        #131a22;
  --sc-fg-soft:   #4a5360;
  --sc-fg-muted:  #7a8492;
  --sc-line:      #e0d9cc;
  --sc-accent:    #ff9900;
  --sc-accent-dk: #e88a00;
  --sc-done:      #1e7e34;
  --sc-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --sc-bg:       #161a1f;
    --sc-bg-soft:  #1f242b;
    --sc-fg:       #f3efe6;
    --sc-fg-soft:  #c2cbd6;
… (119 more non-blank lines elided)
```

### `status.html`
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Styx Multi-Cart</title>
    <link rel="stylesheet" href="status.css" />
  </head>
  <body>
    <header class="sc-header">
      <svg class="sc-logo" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect width="32" height="32" rx="7" fill="#131a22" />
        <g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none">
          <path d="M12 5.5 L19 5.5 L18.3 8.7 L12.7 8.7 Z" />
          <path d="M12 5.5 L10.5 4.2" />
        </g>
        <circle cx="13.7" cy="10.2" r="0.9" fill="#ff9900" />
        <circle cx="17.3" cy="10.2" r="0.9" fill="#ff9900" />
        <g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none">
          <path d="M4 12 L11 12 L10.3 15.2 L4.7 15.2 Z" />
          <path d="M4 12 L2.5 10.7" />
… (31 more non-blank lines elided)
```

### `status.js`
```js
/**
 * status.js — drives the live operation status window.
 *
 * Polls background.js for the current operation state every 350 ms and
 * renders it with a cycling "..." animation. Closes itself 3.5 s after
 * the background reports the operation is done.
 */
(function () {
  "use strict";
  const $titleText = document.getElementById("sc-title-text");
  const $dots      = document.getElementById("sc-dots");
  const $detail    = document.getElementById("sc-detail");
  // ---- Blinking dots -------------------------------------------------------
  // Cycles independently of the poll loop so it never pauses even when
  // poll responses are slow.
  let dotCount = 0;
  const dotTimer = setInterval(() => {
    dotCount = (dotCount + 1) % 4;
    $dots.textContent = ".".repeat(dotCount);
  }, 350);
… (45 more non-blank lines elided)
```

### `vitest.config.js`
```js
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["tests/**/*.test.js"], setupFiles: ["tests/setup.js"], globals: false, restoreMocks: true, …
```

### `.claude/launch.json`
```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "docs",
      "runtimeExecutable": "python3",
      "runtimeArgs": ["-m", "http.server", "4321", "--directory", "docs"],
      "port": 4321
    },
    {
      "name": "root",
      "runtimeExecutable": "python3",
      "runtimeArgs": ["-m", "http.server", "4322"],
      "port": 4322
    }
  ]
}
```

### `.claude/settings.local.json`
```json
{
  "permissions": {
  }
}
… (values elided; request full file if needed)
```

### `.claude/skills/chrome-web-store-assets/SKILL.md`
```md
---
name: chrome-web-store-assets
description: Create, capture, post-process, and validate Chrome Web Store listing media for browser extensions, including exact-dimension screenshots, demo videos, small promo tiles, marquee promo tiles, and optional large promo tiles. Use when asked to produce Chrome Web Store screenshots or promotional assets, automate desktop/browser capture with Playwright, computer use, Shottr, OBS/QuickTime, or ffmpeg, add callouts/graphics, or verify store-assets compliance before upload.
---

# Chrome Web Store Assets
## Start Here
## Required Asset Targets
## Capture Strategy
### Playwright Screenshot Flow
### Desktop/Shottr Screenshot Flow
## Screenshot Storyboard
## Added Graphics and Callouts
## Promo Tile Workflow
## Video Workflow
## Validation Commands
## Final Delivery Checklist
```

### `.claude/skills/chrome-web-store-assets/references/chrome-store-media-spec.md`
```md
# Chrome Web Store Media Reference
## Common Dimensions
## Common Rejection Risks
## Capture Tool Selection
## Metadata Inspection
```

### `.claude/skills/chrome-web-store-assets/scripts/fit_png.py`
```py
import argparse
from pathlib import Path
def parse_color(value): ...
def main(): ...
```

### `.claude/skills/chrome-web-store-assets/scripts/validate_assets.py`
```py
import argparse
import json
import shutil
import subprocess
from pathlib import Path
EXPECTED_IMAGES = ...
SCREENSHOT_SIZE = (1280, 800)
ALT_SCREENSHOT_SIZE = (640, 400)
def profile_name(image): ...
def inspect_png(path): ...
def check_image(path, expected_size=None, allow_alpha=True): ...
def inspect_video(path): ...
def main(): ...
```

### `.github/ISSUE_TEMPLATE/bug_report.md`
```md
---
name: Bug report
about: Report something broken or behaving unexpectedly in Styx Multi-Cart
title: "[Bug] "
```

### `docs/MONETIZATION_PLAN.md`
```md
# Monetization & Premium Tier Plan
## Core Strategy
### Why
## Current Model (updated 2026-07-14)
## Pricing
### Pricing rationale
## Entitlement Model
### The Amazon cart is first-class and always free
## Lapsed Premium Behavior
### Auto-promotion on deletion
### Rationale for strict read-only
## Renewal Warnings
### Cross-platform note
## Data Model Sketch
### Derived at render time
### Storage location
## Gate Functions
## Paywall UX
## Payment Provider
### Chrome (launch)
### Apple (future)
## Build Order
## Open Questions / Future
```

### `docs/_config.yml`
```yml
title: Styx Multi-Cart
description: A browser extension for managing multiple Amazon shopping carts.
theme: jekyll-theme-cayman
markdown: kramdown
```

### `docs/index.html`
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Styx Multi-Cart — Supercharge your Amazon lists into carts</title>
    <meta
      name="description"
      content="Styx Multi-Cart supercharges your Amazon lists, repurposing them as reusable carts you fill with items and move to checkout in one click — a separate cart for every occasion. Backed by your Amazon account. 3 carts free; unlimited with Premium."
    />
    <link rel="icon" type="image/png" href="assets/favicon-128.png" />
    <link rel="stylesheet" href="assets/css/style.css" />
    <meta property="og:title" content="Styx Multi-Cart" />
    <meta
      property="og:description"
      content="Supercharge your Amazon lists — repurpose them as reusable carts you fill and send to checkout in one click. A cart for every occasion, synced across your devices. 3 free; unlimited with Premium."
    />
    <meta
      property="og:image"
      content="https://allballbearings.github.io/styx-multi-cart/assets/promo-1400x560.png"
… (297 more non-blank lines elided)
```

### `docs/permissions.md`
```md
---
title: Permissions Justification — Styx Multi-Cart
---

# Permissions Justification
## `storage`
## `activeTab`
## `scripting`
## `tabs`
## `alarms`
## Host permissions
## Outbound non-Amazon network requests
## Bundled third-party code
## What the extension does NOT do
```

### `docs/privacy.md`
```md
---
title: Privacy Policy — Styx Multi-Cart
---

# Privacy Policy
## Data the extension stores locally
## Data we never collect
## Network requests the extension makes
### 1. Requests to Amazon
### 2. Requests to the payment / license provider (Premium only)
## Permissions
## Children
## Changes to this policy
## Contact
```

### `docs/report-bug.md`
```md
---
title: Report a Bug — Styx Multi-Cart
---

# Report a Bug
## The quick way (from the extension)
## Before you file
## What makes a great report
## Attaching diagnostic logs (optional but powerful)
## Requesting a feature
```

### `docs/assets/css/style.css`
```css
/* Styx Multi-Cart — product page styles */
:root {
  color-scheme: light;
  --navy-900: #0b121b;
  --navy-800: #101923;
  --navy-700: #17212d;
  --orange: #ff9900;
  --orange-light: #ffc34d;
  --blue-light: #6cc7ff;
  --blue-pale: #9bd9ff;
  --river: #5f7686;
  --ink: #1c2733;
  --muted: #5b6b7c;
  --paper: #f6f8fa;
  --border: #e3e8ed;
  --max: 1080px;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
… (294 more non-blank lines elided)
```

### `docs/internal/APP-STORE-CHECKLIST.md`
```md
# Safari App Store Submission Checklist
## Payment model (Guideline 3.1.1) — DECIDED: Option A (Apple IAP)
## Done ✅
## Track 1 — Xcode project config
## Track 2 — Build & archive
## Track 3 — App Store Connect listing
## Track 4 — Submit
## Rebuild command reference
# regenerate bundle + sync RELEASE resources (debug bypass stripped) into Xcode
```

### `docs/internal/EXTENSIONPAY-SETUP.md`
```md
# ExtensionPay Setup
## Steps
## Operational notes
```

### `docs/internal/IAP-SETUP.md`
```md
# Safari In-App Purchase (StoreKit) Setup
## How it works
## Product identifiers (must match everywhere)
## One-time Xcode setup (GUI — do this yourself)
## App Store Connect setup
## Testing checklist
## Notes / gotchas
```

### `docs/internal/PROMO-CODES.md`
```md
# Promo Codes — Active
## Hash → code map
## How to revoke a code
## How to add a new code
```

### `docs/internal/TESTING-PURCHASES.md`
```md
# Testing Premium Purchases
## Reset local entitlement (after a test purchase)
## Dev Mode entitlement presets (no purchase needed)
## Retesting live Stripe checkout without colliding on email
## ExtensionPay test vs live mode
```

### `icons/_render.py`
```py
import os
from PIL import Image, ImageDraw
ICON_DIR = os.path.dirname(os.path.abspath(__file__))
SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 4
def hex_rgba(h, alpha=255): ...
def trace_wave_points(width, y_center, amp, segments=4, samples_per_segment=24): ...  # "Sample points along the chained quadratic-Bezier wave."
def draw_icon(target_size): ...
def main(): ...
```

### `lib/clear-cart.js`
```js
export function evaluateClearStep({ settled, beforeRows, beforeQuantity, stalledDeletes })
```

### `lib/extpay-sync.js`
```js
export const EXTPAY_PREMIUM_BUFFER_MS = 28 * 24 * 60 * 60 * 1000;
export function extpayUserToEntitlementPatch(user, current, nowMs)
```

### `lib/helpers.js`
```js
export const STORAGE_KEY = "mc.carts.v1";
export const SETTINGS_KEY = "mc.settings.v1";
export const UPSELL_CHOICES_KEY = "mc.upsell.choices.v1";
export const UPSELL_TTL_MS = 24 * 60 * 60 * 1000;
export const PENDING_ATC_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_SETTINGS = { interceptAtc: true, restoring: false, };
export const AMAZON_TLDS = [ "amazon.com", "amazon.co.uk", "amazon.ca", "amazon.com.au", "amazon.de", "amazon.fr", "amazon.it", "amazon.es", "amazon.co.jp", "amazon.in…
export function makeId()
export function prunePendingAtc(map, nowMs = Date.now(), ttlMs = PENDING_ATC_TTL_MS)
export function pruneUpsellChoices(map, nowMs = Date.now(), ttlMs = UPSELL_TTL_MS)
export function getUrlHost(url)
export function normalizeAmazonHost(host)
export function sameAmazonHost(a, b)
export function isAmazonCartUrl(url)
export function isAmazonUrl(url)
export function isUpsellUrl(url)
export function normalizeUrlForWait(url)
export function buildBulkAddUrl(host, items, associateTag)
export function chunkItemsForBulk(items, size = 30)
export const ENTITLEMENT_KEY = "mc.entitlement.v1";
export const DEV_FLAG_KEY = "mc.dev.v1";
export const FREE_CART_LIMIT = 3;
export const PREMIUM_CART_LIMIT = 20;
export const DEFAULT_ENTITLEMENT = Object.freeze({ tier: "free", // "free" | "premium" premiumUntil: null, // epoch ms, or null for lifetime premium / free autoRenew: …
export function isPremiumActive(ent, nowMs = Date.now())
export function cartLimitFor(ent, nowMs = Date.now())
export function topNCartIdsByLastUsed(carts, n)
export function computeCartAccess(carts, ent, nowMs = Date.now())
export function canCreateSavedCart(carts, ent, nowMs = Date.now())
export function canEditCart(cartId, carts, ent, nowMs = Date.now())
export function computeListAccess(lists, ent, nowMs = Date.now())
export function backfillLastUsedAt(carts)
export function backfillCartSyncFields(carts)
export function parseAmazonListId(href)
export function amazonListUrl(host, listId)
```

### `lib/native-sync.js`
```js
export const NATIVE_PREMIUM_BUFFER_MS = 3 * 24 * 60 * 60 * 1000;
export function nativeEntitlementToPatch(native, current, nowMs)
```

### `lib/scrape.js`
```js
export function pageGetCartCountDetailed()
export function pageGetCartCount()
export async function pageScrapeCart()
```

### `lib/storage.js`
```js
import { STORAGE_KEY, SETTINGS_KEY, UPSELL_CHOICES_KEY, ENTITLEMENT_KEY, DEV_FLAG_KEY, DEFAULT_SETTINGS, DEFAULT_ENTITLEMENT, pruneUpsellChoices, backfillLastUs…
export async function readCarts()
export async function writeCarts(carts)
export async function readSettings()
export async function writeSettings(patch)
export async function getUpsellChoices()
export async function recordUpsellChoice(asin, entry)
export async function getRecordedUpsellChoice(asin)
export async function readEntitlement()
export async function writeEntitlement(patch)
export async function touchCartLastUsed(cartId, nowMs = Date.now())
export async function isDevModeEnabled()
```

### `safari/README.md`
```md
# Safari / App Store scaffold
## What's here
## Local testing on macOS Safari
## App Store submission
```

### `safari/Styx Multi-Cart/StyxMultiCart.storekit`
```storekit
{
  "identifier" : "A1B2C3D4-0001-0001-0001-STYXMULTICART",
  "nonRenewingSubscriptions" : [],
  "products" : [
    {
      "displayPrice" : "14.99",
      "familyShareable" : false,
      "internalID" : "STYX0002",
      "localizations" : [
        {
          "description" : "Unlock unlimited saved carts forever. One-time purchase.",
          "displayName" : "Styx Multi-Cart Premium (Lifetime)",
          "locale" : "en_US"
        }
      ],
      "productID" : "com.jaredgoolsby.styx.multicart.pro.lifetime",
      "referenceName" : "Premium Lifetime",
      "type" : "NonConsumable"
    }
  ],
… (44 more non-blank lines elided)
```

### `safari/Styx Multi-Cart/Shared (App)/StoreManager.swift`
```swift
import Foundation
import StoreKit
@available(macOS 12.0, iOS 15.0, *) final class StoreManager {
  static let shared = StoreManager()
  static let annualID = "com.jaredgoolsby.styx.multicart.pro.annual"
  static let lifetimeID = "com.jaredgoolsby.styx.multicart.pro.lifetime"
  static let productIDs = [annualID, lifetimeID]
  static let appGroupID = "group.com.jaredgoolsby.styx.multicart"
  static let entitlementKey = "entitlement"
  private(set) var products: [Product] = []
  private var updatesTask: Task<Void, Never>?
  func start()
  func loadProducts() async
  func purchase(planNickname: String) async
  func restore() async
  private func listenForTransactions() -> Task<Void, Never>
  func refreshEntitlement() async
  private func annualWillAutoRenew() async -> Bool
  private func writeEntitlement( entitled: Bool, productType: String, expiresAt: Double, willAutoRenew: Bool, productId: String )
}
```

### `safari/Styx Multi-Cart/Shared (App)/ViewController.swift`
```swift
import WebKit
import UIKit
import Cocoa
import SafariServices
class ViewController: PlatformViewController, WKNavigationDelegate, WKScriptMessageHandler {
  @IBOutlet var webView: WKWebView!
  override func viewDidLoad()
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!)
  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage)
}
```

### `safari/Styx Multi-Cart/Shared (App)/Assets.xcassets/Contents.json`
```json
{
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
```

### `safari/Styx Multi-Cart/Shared (App)/Assets.xcassets/AccentColor.colorset/Contents.json`
```json
{
  "colors" : [
    {
      "idiom" : "universal"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
```

### `safari/Styx Multi-Cart/Shared (App)/Assets.xcassets/AppIcon.appiconset/Contents.json`
```json
{
  "images" : [
  ],
  "info" : {
  }
}
… (values elided; request full file if needed)
```

### `safari/Styx Multi-Cart/Shared (App)/Assets.xcassets/LargeIcon.imageset/Contents.json`
```json
{
  "images" : [
    {
      "idiom" : "universal",
      "scale" : "1x",
      "filename" : "icon128.png"
    },
    {
      "idiom" : "universal",
      "scale" : "2x"
    },
    {
      "idiom" : "universal",
      "scale" : "3x"
    }
  ],
  "info" : {
    "version" : 1,
    "author" : "xcode"
  }
}
```

### `safari/Styx Multi-Cart/Shared (App)/Resources/Script.js`
```js
function show(platform, enabled, useSettingsInsteadOfPreferences)
function openPreferences()
function sendController(action)
```

### `safari/Styx Multi-Cart/Shared (App)/Resources/Style.css`
```css
* {
    -webkit-user-select: none;
    -webkit-user-drag: none;
    cursor: default;
}
:root {
    color-scheme: light dark;
    --spacing: 20px;
}
html {
    height: 100%;
}
body {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: var(--spacing);
    margin: 0 calc(var(--spacing) * 2);
    height: 100%;
… (27 more non-blank lines elided)
```

### `safari/Styx Multi-Cart/Shared (App)/Resources/Base.lproj/Main.html`
```html
<!DOCTYPE html>
<html>
<head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'">
    <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
    <link rel="stylesheet" href="../Style.css">
    <script src="../Script.js" defer></script>
</head>
<body>
    <img src="../Icon.png" width="128" height="128" alt="Styx Multi-Cart Icon">
    <p class="platform-ios">You can turn on Styx Multi-Cart’s Safari extension in Settings.</p>
    <p class="platform-mac state-unknown">You can turn on Styx Multi-Cart’s extension in Safari Extensions preferences.</p>
    <p class="platform-mac state-on">Styx Multi-Cart’s extension is currently on. You can turn it off in Safari Extensions preferences.</p>
    <p class="platform-mac state-off">Styx Multi-Cart’s extension is currently off. You can turn it on in Safari Extensions preferences.</p>
    <button class="platform-mac open-preferences">Quit and Open Safari Extensions Preferences…</button>
    <div class="platform-mac premium-section">
        <hr>
        <p>Styx Multi-Cart Premium — unlimited saved carts.</p>
        <button class="buy-annual">Subscribe (Annual)</button>
… (5 more non-blank lines elided)
```

### `safari/Styx Multi-Cart/Shared (Extension)/SafariWebExtensionHandler.swift`
```swift
import SafariServices
import os.log
class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
  func beginRequest(with context: NSExtensionContext)
  private func readEntitlement() -> [String: Any]
}
```

### `safari/Styx Multi-Cart/Shared (Extension)/Resources/content.js`
```js
/**
 * content.js — runs on Amazon cart pages.
 *
 * Two responsibilities:
 *   1. Scrape the current cart (ASIN, title, qty, price, image).
 *   2. Clear the current cart by clicking each item's "Delete" link.
 *
 * The popup talks to this script through chrome.runtime.sendMessage,
 * relayed by the background service worker.
 */
(function () {
  "use strict";
  // Re-injection guard. Besides the manifest declaration, background.js
  // injects this file on demand when a tab has no listener (Safari's "Ask"
  // site-access level blocks manifest content scripts while the activeTab
  // grant still allows scripting). A second evaluation must not register a
  // second onMessage listener or every request would get double responses.
  if (window.__styxMcContentLoaded) return;
  window.__styxMcContentLoaded = true;
  // Diagnostic logging — mirrors the popup's Developer mode switch (the
… (678 more non-blank lines elided)
```

### `safari/Styx Multi-Cart/Shared (Extension)/Resources/manifest.json`
```json
{
  "manifest_version": 3,
  "name": "Styx Multi-Cart",
  "version": "1.0.1",
  "author": "Jared Goolsby",
  "homepage_url": "https://allballbearings.github.io/styx-multi-cart/",
  "description": "Save, switch, and restore multiple Amazon shopping carts. Local-only storage, no t…
  "permissions": [
  ],
  "host_permissions": [
  ],
  "background": {
  },
  "action": {
  },
  "icons": {
  },
  "content_scripts": [
  ]
}
… (values elided; request full file if needed)
```

### `safari/Styx Multi-Cart/Shared (Extension)/Resources/observer.js`
```js
/**
 * observer.js — runs on Amazon product pages and upsell/attach pages.
 *
 * Two jobs:
 *  1. On a product page (/dp/, /gp/product/), when the user clicks
 *     "Add to Cart", tell background.js the ASIN + title so the next
 *     upsell observation can be linked to it.
 *  2. On an upsell/attach surface, when the user picks a coverage option
 *     or declines, tell background.js so it can store the choice
 *     (24 h TTL) for later replay during cart restore.
 *
 * This script is intentionally read-only — it never auto-clicks anything.
 * Replay happens inside restoreCart via chrome.scripting.executeScript.
 */
(function () {
  "use strict";
  // Diagnostic logging — mirrors the popup's Developer mode switch (the
  // mc.dev.v1 flag in chrome.storage.local). When it's on, dlog/dwarn print to
  // this page's console AND forward to the service worker's in-memory ring
  // buffer, so the popup's "Copy diagnostic logs" button can gather logs from
… (2537 more non-blank lines elided)
```

### `safari/Styx Multi-Cart/Shared (Extension)/Resources/popup.css`
```css
/* Amazon Multi-Cart — popup styles
   Aim: feels native to Amazon (warm, slightly serif headline, the iconic
   yellow-orange CTA) without literally copying their identity. */
/* Author rules like .mc-tier-strip { display: flex } override the user-agent
   default [hidden] { display: none }. Force the attribute to win globally so
   element.hidden = true actually hides things. */
[hidden] { display: none !important; }
:root {
  --mc-bg: #ffffff;
  --mc-bg-soft: #f7f3ec;
  --mc-bg-sunk: #ece7dd;
  --mc-fg: #131a22;
  --mc-fg-soft: #4a5360;
  --mc-fg-muted: #7a8492;
  --mc-line: #e0d9cc;
  --mc-line-strong: #c9bfae;
  --mc-accent: #ff9900;       /* Amazon-ish amber */
  --mc-accent-strong: #e88a00;
  --mc-accent-ink: #1a1209;
  --mc-link: #0066c0;
… (1820 more non-blank lines elided)
```

### `safari/Styx Multi-Cart/Shared (Extension)/Resources/popup.html`
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Styx Multi-Cart</title>
    <link rel="stylesheet" href="popup.css" />
  </head>
  <body>
    <header class="mc-header">
      <div class="mc-brand">
        <svg
          class="mc-logo"
          viewBox="0 0 32 32"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <!-- Background tile -->
          <rect width="32" height="32" rx="7" fill="#131a22" />
          <!-- Top cart (apex of the pyramid) -->
… (1034 more non-blank lines elided)
```

### `safari/Styx Multi-Cart/Shared (Extension)/Resources/popup.js`
```js
/**
 * popup.js — drives the extension popup.
 *
 * All real work happens in the background service worker;
 * this file just renders state and forwards button clicks.
 */
(function () {
  "use strict";
  // The native Chrome side panel loads this page with ?surface=sidepanel so
  // it can fill the panel's width/height instead of the fixed popup size.
  // ("panel" is the legacy in-page-iframe value, kept for safety.)
  const _surface = new URLSearchParams(location.search).get("surface");
  if (_surface === "sidepanel" || _surface === "panel") {
    document.documentElement.dataset.surface = _surface;
  }
  // In the side panel, window.close() tears the entire panel down — the user
  // then has to reopen it from the toolbar. Only the fixed-size popup should
  // auto-dismiss to "get out of the way" after an op; the panel sits beside
  // the page and never covers it. Guard every close() call with this.
  const IS_PANEL_SURFACE = _surface === "sidepanel" || _surface === "panel";
… (2439 more non-blank lines elided)
```

### `safari/Styx Multi-Cart/Shared (Extension)/Resources/status.css`
```css
/* Styx Multi-Cart — status window */
:root {
  --sc-bg:        #ffffff;
  --sc-bg-soft:   #f7f3ec;
  --sc-fg:        #131a22;
  --sc-fg-soft:   #4a5360;
  --sc-fg-muted:  #7a8492;
  --sc-line:      #e0d9cc;
  --sc-accent:    #ff9900;
  --sc-accent-dk: #e88a00;
  --sc-done:      #1e7e34;
  --sc-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --sc-bg:       #161a1f;
    --sc-bg-soft:  #1f242b;
    --sc-fg:       #f3efe6;
    --sc-fg-soft:  #c2cbd6;
… (119 more non-blank lines elided)
```

### `safari/Styx Multi-Cart/Shared (Extension)/Resources/status.html`
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Styx Multi-Cart</title>
    <link rel="stylesheet" href="status.css" />
  </head>
  <body>
    <header class="sc-header">
      <svg class="sc-logo" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect width="32" height="32" rx="7" fill="#131a22" />
        <g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none">
          <path d="M12 5.5 L19 5.5 L18.3 8.7 L12.7 8.7 Z" />
          <path d="M12 5.5 L10.5 4.2" />
        </g>
        <circle cx="13.7" cy="10.2" r="0.9" fill="#ff9900" />
        <circle cx="17.3" cy="10.2" r="0.9" fill="#ff9900" />
        <g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none">
          <path d="M4 12 L11 12 L10.3 15.2 L4.7 15.2 Z" />
          <path d="M4 12 L2.5 10.7" />
… (31 more non-blank lines elided)
```

### `safari/Styx Multi-Cart/Shared (Extension)/Resources/status.js`
```js
/**
 * status.js — drives the live operation status window.
 *
 * Polls background.js for the current operation state every 350 ms and
 * renders it with a cycling "..." animation. Closes itself 3.5 s after
 * the background reports the operation is done.
 */
(function () {
  "use strict";
  const $titleText = document.getElementById("sc-title-text");
  const $dots      = document.getElementById("sc-dots");
  const $detail    = document.getElementById("sc-detail");
  // ---- Blinking dots -------------------------------------------------------
  // Cycles independently of the poll loop so it never pauses even when
  // poll responses are slow.
  let dotCount = 0;
  const dotTimer = setInterval(() => {
    dotCount = (dotCount + 1) % 4;
    $dots.textContent = ".".repeat(dotCount);
  }, 350);
… (45 more non-blank lines elided)
```

### `safari/Styx Multi-Cart/Shared (Extension)/Resources/icons/_render.py`
```py
import os
from PIL import Image, ImageDraw
ICON_DIR = os.path.dirname(os.path.abspath(__file__))
SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 4
def hex_rgba(h, alpha=255): ...
def trace_wave_points(width, y_center, amp, segments=4, samples_per_segment=24): ...  # "Sample points along the chained quadratic-Bezier wave."
def draw_icon(target_size): ...
def main(): ...
```

### `safari/Styx Multi-Cart/Styx Multi-Cart.xcodeproj/project.pbxproj`
```pbxproj
// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 77;
	objects = {
/* Begin PBXBuildFile section */
		C1B0B1852FBBB5B5006F37EF /* AppDelegate.swift in Sources */ = {isa = PBXBuildFile; fileRef = C1B0B1842FBBB5B5006F37EF /* AppDelegate.swift */; };
		C1B0B1872FBBB5B5006F37EF /* SceneDelegate.swift in Sources */ = {isa = PBXBuildFile; fileRef = C1B0B1862FBBB5B5006F37EF /* SceneDelegate.swift */; };
		C1B0B18A2FBBB5B5006F37EF /* LaunchScreen.storyboard in Resources */ = {isa = PBXBuildFile; fileRef = C1B0B1882FBBB5B5006F37EF /* LaunchScreen.storyboard */; };
		C1B0B18D2FBBB5B5006F37EF /* Main.storyboard in Resources */ = {isa = PBXBuildFile; fileRef = C1B0B18B2FBBB5B5006F37EF /* Main.storyboard */; };
		C1B0B1962FBBB5B5006F37EF /* AppDelegate.swift in Sources */ = {isa = PBXBuildFile; fileRef = C1B0B1952FBBB5B5006F37EF /* AppDelegate.swift */; };
		C1B0B1992FBBB5B5006F37EF /* Main.storyboard in Resources */ = {isa = PBXBuildFile; fileRef = C1B0B1972FBBB5B5006F37EF /* Main.storyboard */; };
		C1B0B1A02FBBB5B5006F37EF /* Styx Multi-Cart Extension.appex in Embed Foundation Extensions */ = {isa = PBXBuildFile; fileRef = C1B0B19F2FBBB5B5006F37EF /* Styx Multi-Cart Extension.appex */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };
		C1B0B1AA2FBBB5B5006F37EF /* Styx Multi-Cart Extension.appex in Embed Foundation Extensions */ = {isa = PBXBuildFile; fileRef = C1B0B1A92FBBB5B5006F37EF /* Styx Multi-Cart Extension.appex */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };
		C1B0B1AF2FBBB5B5006F37EF /* Main.html in Resources */ = {isa = PBXBuildFile; fileRef = C1B0B1742FBBB5B3006F37EF /* Main.html */; };
		C1B0B1B02FBBB5B5006F37EF /* Main.html in Resources */ = {isa = PBXBuildFile; fileRef = C1B0B1742FBBB5B3006F37EF /* Main.html */; };
		C1B0B1B12FBBB5B5006F37EF /* Icon.png in Resources */ = {isa = PBXBuildFile; fileRef = C1B0B1762FBBB5B3006F37EF /* Icon.png */; };
		C1B0B1B22FBBB5B5006F37EF /* Icon.png in Resources */ = {isa = PBXBuildFile; fileRef = C1B0B1762FBBB5B3006F37EF /* Icon.png */; };
… (1001 more non-blank lines elided)
```

### `safari/Styx Multi-Cart/Styx Multi-Cart.xcodeproj/project.xcworkspace/contents.xcworkspacedata`
```xcworkspacedata
<?xml version="1.0" encoding="UTF-8"?>
<Workspace
   version = "1.0">
   <FileRef
      location = "self:">
   </FileRef>
</Workspace>
```

### `safari/Styx Multi-Cart/Styx Multi-Cart.xcodeproj/xcuserdata/jaredgoolsby.xcuserdatad/xcschemes/xcschememanagement.plist`
```plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>SchemeUserState</key>
	<dict>
		<key>Styx Multi-Cart (iOS).xcscheme_^#shared#^_</key>
		<dict>
			<key>orderHint</key>
			<integer>1</integer>
		</dict>
		<key>Styx Multi-Cart (macOS).xcscheme_^#shared#^_</key>
		<dict>
			<key>orderHint</key>
			<integer>0</integer>
		</dict>
	</dict>
</dict>
</plist>
```

### `safari/Styx Multi-Cart/iOS (App)/AppDelegate.swift`
```swift
import UIKit
@main class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool
  func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UIScene…
}
```

### `safari/Styx Multi-Cart/iOS (App)/Info.plist`
```plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>SFSafariWebExtensionConverterVersion</key>
	<string>26.0.1</string>
	<key>UIApplicationSceneManifest</key>
	<dict>
		<key>UIApplicationSupportsMultipleScenes</key>
		<false/>
		<key>UISceneConfigurations</key>
		<dict>
			<key>UIWindowSceneSessionRoleApplication</key>
			<array>
				<dict>
					<key>UISceneConfigurationName</key>
					<string>Default Configuration</string>
					<key>UISceneDelegateClassName</key>
					<string>$(PRODUCT_MODULE_NAME).SceneDelegate</string>
					<key>UISceneStoryboardFile</key>
… (7 more non-blank lines elided)
```

### `safari/Styx Multi-Cart/iOS (App)/SceneDelegate.swift`
```swift
import UIKit
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions)
}
```

### `safari/Styx Multi-Cart/iOS (App)/Base.lproj/LaunchScreen.storyboard`
```storyboard
<?xml version="1.0" encoding="UTF-8"?>
<document type="com.apple.InterfaceBuilder3.CocoaTouch.Storyboard.XIB" version="3.0" toolsVersion="19085" targetRuntime="iOS.CocoaTouch" propertyAccessControl="none" useAutolayout="YES" launchScreen="YES" useTraitCollections="YES" useSafeAreas="YES" colorMatched="YES" initialViewController="01J-lp-oVM">
    <dependencies>
        <plugIn identifier="com.apple.InterfaceBuilder.IBCocoaTouchPlugin" version="19082"/>
        <capability name="Image references" minToolsVersion="12.0"/>
        <capability name="Safe area layout guides" minToolsVersion="9.0"/>
        <capability name="documents saved in the Xcode 8 format" minToolsVersion="8.0"/>
    </dependencies>
    <scenes>
        <!--View Controller-->
        <scene sceneID="EHf-IW-A2E">
            <objects>
                <viewController id="01J-lp-oVM" sceneMemberID="viewController">
                    <view key="view" contentMode="scaleToFill" id="Ze5-6b-2t3">
                        <rect key="frame" x="0.0" y="0.0" width="414" height="896"/>
                        <autoresizingMask key="autoresizingMask" widthSizable="YES" heightSizable="YES"/>
                        <subviews>
                            <imageView clipsSubviews="YES" userInteractionEnabled="NO" contentMode="scaleToFill" horizontalHuggingPriority="251" verticalHuggingPriority="251" fixedFrame="YES" translatesAutoresizingMaskIntoConstraints="NO" id="6HG-Um-bch">
                                <rect key="frame" x="142" y="385" width="128" height="128"/>
                                <autoresizingMask key="autoresizingMask" flexibleMinX="YES" flexibleMaxX="YES" flexibleMinY="YES" flexibleMaxY="YES"/>
… (16 more non-blank lines elided)
```

### `safari/Styx Multi-Cart/iOS (App)/Base.lproj/Main.storyboard`
```storyboard
<?xml version="1.0" encoding="UTF-8"?>
<document type="com.apple.InterfaceBuilder3.CocoaTouch.Storyboard.XIB" version="3.0" toolsVersion="18122" targetRuntime="iOS.CocoaTouch" propertyAccessControl="none" useAutolayout="YES" useTraitCollections="YES" useSafeAreas="YES" colorMatched="YES" initialViewController="BYZ-38-t0r">
    <device id="retina6_1" orientation="portrait" appearance="light"/>
    <dependencies>
        <plugIn identifier="com.apple.InterfaceBuilder.IBCocoaTouchPlugin" version="18093"/>
        <capability name="Safe area layout guides" minToolsVersion="9.0"/>
        <capability name="documents saved in the Xcode 8 format" minToolsVersion="8.0"/>
    </dependencies>
    <scenes>
        <!--View Controller-->
        <scene sceneID="tne-QT-ifu">
            <objects>
                <viewController id="BYZ-38-t0r" customClass="ViewController" customModuleProvider="target" sceneMemberID="viewController">
                    <view key="view" contentMode="scaleToFill" id="8bC-Xf-vdC">
                        <rect key="frame" x="0.0" y="0.0" width="414" height="896"/>
                        <autoresizingMask key="autoresizingMask" widthSizable="YES" heightSizable="YES"/>
                        <subviews>
                            <wkWebView contentMode="scaleToFill" fixedFrame="YES" translatesAutoresizingMaskIntoConstraints="NO" id="RDB-ib-igF">
                                <rect key="frame" x="0.0" y="0.0" width="414" height="896"/>
                                <autoresizingMask key="autoresizingMask" widthSizable="YES" heightSizable="YES"/>
… (18 more non-blank lines elided)
```

### `safari/Styx Multi-Cart/iOS (Extension)/Info.plist`
```plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSExtension</key>
	<dict>
		<key>NSExtensionPointIdentifier</key>
		<string>com.apple.Safari.web-extension</string>
		<key>NSExtensionPrincipalClass</key>
		<string>$(PRODUCT_MODULE_NAME).SafariWebExtensionHandler</string>
	</dict>
</dict>
</plist>
```

### `safari/Styx Multi-Cart/macOS (App)/AppDelegate.swift`
```swift
import Cocoa
@main class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification)
  func application(_ application: NSApplication, open urls: [URL])
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool
}
```

### `safari/Styx Multi-Cart/macOS (App)/Info.plist`
```plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>SFSafariWebExtensionConverterVersion</key>
	<string>26.0.1</string>
	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleURLName</key>
			<string>com.jaredgoolsby.styx.multicart.purchase</string>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>styxmulticart</string>
			</array>
		</dict>
	</array>
	<key>ITSAppUsesNonExemptEncryption</key>
	<false/>
</dict>
</plist>
```

### `safari/Styx Multi-Cart/macOS (App)/Base.lproj/Main.storyboard`
```storyboard
<?xml version="1.0" encoding="UTF-8"?>
<document type="com.apple.InterfaceBuilder3.Cocoa.Storyboard.XIB" version="3.0" toolsVersion="19085" targetRuntime="MacOSX.Cocoa" propertyAccessControl="none" useAutolayout="YES" initialViewController="B8D-0N-5wS">
    <dependencies>
        <plugIn identifier="com.apple.InterfaceBuilder.CocoaPlugin" version="19085"/>
        <plugIn identifier="com.apple.WebKit2IBPlugin" version="19085"/>
        <capability name="documents saved in the Xcode 8 format" minToolsVersion="8.0"/>
    </dependencies>
    <scenes>
        <!--Application-->
        <scene sceneID="JPo-4y-FX3">
            <objects>
                <application id="hnw-xV-0zn" sceneMemberID="viewController">
                    <menu key="mainMenu" title="Main Menu" systemMenu="main" id="AYu-sK-qS6">
                        <items>
                            <menuItem title="Styx Multi-Cart" id="1Xt-HY-uBw">
                                <modifierMask key="keyEquivalentModifierMask"/>
                                <menu key="submenu" title="Styx Multi-Cart" systemMenu="apple" id="uQy-DD-JDr">
                                    <items>
                                        <menuItem title="About Styx Multi-Cart" id="5kV-Vb-QxS">
                                            <modifierMask key="keyEquivalentModifierMask"/>
… (104 more non-blank lines elided)
```

### `safari/Styx Multi-Cart/macOS (Extension)/Info.plist`
```plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSExtension</key>
	<dict>
		<key>NSExtensionPointIdentifier</key>
		<string>com.apple.Safari.web-extension</string>
		<key>NSExtensionPrincipalClass</key>
		<string>$(PRODUCT_MODULE_NAME).SafariWebExtensionHandler</string>
	</dict>
</dict>
</plist>
```

### `scripts/README.md`
```md
# scripts/
## `build-zip.sh`
### What's in the zip
### What's excluded
## Uploading to the Chrome Web Store
```

### `scripts/build-extension.mjs`
```mjs
import { build } from "esbuild";
const production = process.env.NODE_ENV === "production";
```

### `scripts/build-zip.sh`
```sh
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
… (78 more non-blank lines elided)
```

### `scripts/patch-safari-manifest.py`
```py
import json
import sys
def patch(path): ...
```

### `scripts/strip-debug-ent.py`
```py
import re
import sys
MARKER = ...
def strip_file(path): ...
def main(argv): ...
```

### `scripts/sync-safari-resources.sh`
```sh
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
… (41 more non-blank lines elided)
```

### `src/background/index.js`
```js
import { extpayUserToEntitlementPatch } from "../../lib/extpay-sync.js";
import { nativeEntitlementToPatch } from "../../lib/native-sync.js";
import { evaluateClearStep } from "../../lib/clear-cart.js";
let DEBUG = false;
const LOG_RING_MAX = 500;
const LOG_RING = [];
function mcStringifyArgs(args)
function pushLogEntry(entry)
const dlog = (...a) => { if (!DEBUG) return; console.log(...a); pushLogEntry({ ctx: "sw", level: "log", msg: mcStringifyArgs(a) }); };
const dinfo = (...a) => { if (!DEBUG) return; console.info(...a); pushLogEntry({ ctx: "sw", level: "info", msg: mcStringifyArgs(a) }); };
const dwarn = (...a) => { if (!DEBUG) return; console.warn(...a); pushLogEntry({ ctx: "sw", level: "warn", msg: mcStringifyArgs(a) }); };
const IS_SAFARI = chrome.runtime .getURL("") .startsWith("safari-web-extension://");
const STORAGE_KEY = "mc.carts.v1";
const SETTINGS_KEY = "mc.settings.v1";
const ENTITLEMENT_KEY = "mc.entitlement.v1";
const DEV_FLAG_KEY = "mc.dev.v1";
const PROMO_KEY = "mc.promos.v1";
const PROMO_HASHES = Object.freeze([ "47f0ec155e6bcfcdf6f63f88879a868a7dbaafdd1f95913eed6aa221fc7e9961", "848eebb65c9c41aac69fc477bc1945d549bae0a695424e82f7785b…
const PROMO_GRANT_MS = 90 * 24 * 60 * 60 * 1000;
const FREE_CART_LIMIT = 3;
const PREMIUM_CART_LIMIT = 20;
const DEFAULT_ENTITLEMENT = Object.freeze({ tier: "free", premiumUntil: null, // epoch ms, or null for lifetime premium / free autoRenew: false, source: null, l…
const DEFAULT_SETTINGS = { interceptAtc: true, // Relabel Amazon's wish-list surfaces as Styx "carts" ("Your Lists" → // "Your Styx Carts", custom list names "L…
async function readCarts()
async function writeCarts(carts)
async function readEntitlement()
async function writeEntitlement(patch)
async function isDevModeEnabled()
async function sha256Hex(input)
async function redeemPromoCode(rawCode)
const EXTPAY_ID = "styx-multi-cart";
const EXTPAY_SYNC_ALARM = "mc-extpay-sync";
const EXTPAY_SYNC_PERIOD_MIN = 60 * 24;
const extpay = !IS_SAFARI && typeof ExtPay === "function" ? ExtPay(EXTPAY_ID) : null;
function applyUiSurface(surface)
async function syncEntitlementFromExtPay()
async function syncEntitlementFromNative()
async function syncEntitlement()
function isPremiumActive(ent, nowMs = Date.now())
function cartLimitFor(ent, nowMs = Date.now())
function topNCartIdsByLastUsed(carts, n)
function computeCartAccess(carts, ent, nowMs = Date.now())
function canCreateSavedCart(carts, ent, nowMs = Date.now())
function canEditCart(cartId, carts, ent, nowMs = Date.now())
function computeListAccess(lists, ent, nowMs = Date.now())
let _lastListAccess = { byId: new Map(), at: 0 };
function rememberListAccess(annotatedLists)
async function touchCartLastUsed(cartId, nowMs = Date.now(), carts = null)
async function readSettings()
async function writeSettings(patch)
function makeId()
const UPSELL_CHOICES_KEY = "mc.upsell.choices.v1";
const UPSELL_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_ATC_TTL_MS = 5 * 60 * 1000;
const _pendingAtc = new Map();
function prunePendingAtc()
function pruneUpsellChoices(map)
async function getUpsellChoices()
async function recordUpsellChoice(asin, entry)
async function getRecordedUpsellChoice(asin)
async function applyUpsellChoice(tabId, recorded)
function pageApplyUpsellChoice(recorded)
let _opStatus = null;
let _statusWindowId = null;
function setOpStatus(title, detail = "")
function clearOpStatus(doneTitle = "Done")
async function setUiBusy(on)
function notifyTab(tabId, payload)
async function openStatusWindow()
const AMAZON_TLDS = [ "amazon.com", "amazon.co.uk", "amazon.ca", "amazon.com.au", "amazon.de", "amazon.fr", "amazon.it", "amazon.es", "amazon.co.jp", "amazon.in…
const AMAZON_CART_PATTERNS = AMAZON_TLDS.flatMap((tld) => [ `*://*.${tld}/gp/cart/*`, `*://*.${tld}/gp/cart*`, `*://*.${tld}/cart/*`, `*://*.${tld}/cart*`, `*:/…
function getUrlHost(url)
function normalizeAmazonHost(host)
function sameAmazonHost(a, b)
function isAmazonCartUrl(url)
function isAmazonUrl(url)
function parseAmazonListId(href)
function amazonListUrl(host, listId)
async function inferAmazonHost()
async function getActiveAmazonTab(preferredHost)
async function findAmazonCartTab(preferredHost)
async function scrapeCartInBackground(preferredHost)
async function clearAmazonCart(preferredHost, options = {})
async function clearAmazonCartImpl(preferredHost, options = {})
async function getActiveAmazonCartCount(preferredHost)
async function getAmazonCartCountDetailedFromTab(tabId)
async function getAmazonCartCountFromTab(tabId)
async function waitForCartSettleAfterDelete(tabId, before, timeoutMs = 15000)
async function sendToContent(tabId, message)
const STYX_ASSOCIATE_TAG = "styxmcart-20";
function buildBulkAddUrl(host, items, associateTag)
function chunkItemsForBulk(items, size = 30)
function pageMinimizeFloatingUi()
function pageHighlightBulkConfirm()
function pagePromptChoice(title, message, choices, theme)
async function waitForUserBulkConfirm(tabId, timeoutMs = 5 * 60 * 1000)
async function restoreCartBulk(savedCart)
async function restoreCart(savedCart, onProgress)
async function clearThenRestoreCart(target)
function pageAddAllFromList(targetAsins)
async function restoreViaListPage(target)
async function wishlistAddAllToCart(items, host, listId)
async function clearCurrentCartInBackground()
async function isUpsellTab(tabId)
async function waitForUserProductFormatChoice(tabId, item)
async function waitForUserUpsellChoice(tabId, item, host)
async function showRestoreUpsellNotice(tabId, item)
async function showStatus(tabId, message, type = 'loading')
function isUpsellUrl(url)
function sleep(ms)
function pageClassifyProductAvailability()
function pageAddToCart(qty)
function pageHasRestoreUpsell()
function pageShowStatus(message, type, theme, placement)
function pageGetCartCountDetailed()
async function pageScrapeCart()
const AMAZON_LISTS_PATH = "/hz/wishlist/ls";
const AMAZON_LIST_READ_CACHE_MS = 5 * 60 * 1000;
const amazonListReadCache = new Map();
async function runInAmazonTab(url, fn, { timeoutMs = 20000, keepOpen = false } = {})
async function listAmazonLists(preferredHost)
async function amazonListExists(host, listId)
async function readAmazonList(listId, preferredHost, forceRefresh = false)
async function importAmazonListToCart(listId, preferredHost)
async function createAmazonListFromPdp(host, name, firstAsin)
async function findAmazonListIdByName(host, name)
async function addItemToList(host, listId, asin)
async function setListQuantities(host, listId, items)
async function saveCartToAmazonList(cart, opts = {})
async function saveCartToAmazonListImpl(cart, opts = {})
function pageScrapeAmazonLists()
function pageScrapeSingleList()
function pageCreateListAndAdd(name)
function pageFindListByName(name)
function pageAddToList(listId)
function pageSetListQuantities(map)
async function waitForTabComplete(tabId, timeoutMs = 45000)
async function createTabAndWait(url, timeoutMs = 45000)
async function navigateTabAndWait(tabId, url, timeoutMs = 45000)
async function waitForTabNavigation(tabId, targetUrl, timeoutMs = 45000)
async function waitForTabReload(tabId, timeoutMs = 15000)
function normalizeUrlForWait(url)
```

### `tests/setup.js`
```js
import chromeStub from "sinon-chrome";
```

### `tests/e2e/fixtures.js`
```js
import { test as base, chromium, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
function buildInitScript(initial)
export const test = base.extend({ // Persistent context with the unpacked extension loaded. context: async ({}, use) => { const userDataDir = fs.mkdtempSync(path.join(…
export { expect };
```

### `tests/e2e/popup.spec.js`
```js
import { test, expect } from "./fixtures.js";
const amazonLists = [ { listId: "LISTONE", name: "Birthday Ideas", url: "https://www.amazon.com/hz/wishlist/ls/LISTONE", host: "www.amazon.com", items: [ { asin…
```

### `tests/fixtures/amazon/cart-empty.html`
```html
<!DOCTYPE html>
<html>
<head><title>Amazon Cart</title></head>
<body>
  <span id="nav-cart-count">0</span>
  <div id="sc-active-cart">
    <div data-name="Active Items">
      <p>Your Amazon Cart is empty.</p>
    </div>
  </div>
</body>
</html>
```

### `tests/fixtures/amazon/cart-fallback-permissive.html`
```html
<!DOCTYPE html>
<html>
<head><title>Amazon Cart (legacy markup)</title></head>
<body>
  <!-- Markup that has neither data-itemtype='active' nor .sc-list-item,
       forcing the scraper into its most permissive [data-asin] fallback.
       Also tests dedup: the same ASIN appears twice and should be emitted once. -->
  <span id="nav-cart-count">1</span>
  <div id="ewc-content">
    <div data-asin="B000LEGACY">
      <a href="/dp/B000LEGACY">
        <span class="sc-product-title">Legacy Item</span>
      </a>
      <span class="sc-product-price">$1.00</span>
    </div>
    <div data-asin="B000LEGACY">
      <span class="sc-product-title">Duplicate (should be skipped)</span>
    </div>
  </div>
</body>
</html>
```

### `tests/fixtures/amazon/cart-flyout-ewc.html`
```html
<!DOCTYPE html>
<html>
<head><title>Amazon Home (cart flyout)</title></head>
<body>
  <!-- nav-cart-count present but markup uses EWC (cart flyout) shape.
       pageGetCartCount should fall through to the .ewc-quantity text
       since there are no live rows visible. -->
  <span id="nav-cart-count">3</span>

  <div id="nav-flyout-ewc">
    <span class="ewc-quantity">3 items</span>
    <ul>
      <li class="ewc-item" data-asin="B000EWCITEM">
        <a class="sc-product-link" href="/dp/B000EWCITEM">
          <img class="sc-product-image" src="https://m.media-amazon.com/images/I/ewc.jpg" />
          <span class="sc-product-title">Flyout Item</span>
        </a>
      </li>
    </ul>
  </div>
</body>
</html>
```

### `tests/fixtures/amazon/cart-multi-item.html`
```html
<!DOCTYPE html>
<html>
<head><title>Amazon Cart</title></head>
<body>
  <span id="nav-cart-count" class="nav-cart-count">5</span>
  <div id="sc-active-cart">
    <div data-name="Active Items">
      <!-- Row 1: standard select-based quantity -->
      <div data-asin="B000AAAAAA" data-itemtype="active" class="sc-list-item">
        <a class="sc-product-link" href="/dp/B000AAAAAA">
          <img class="sc-product-image" src="https://m.media-amazon.com/images/I/aaa.jpg" />
          <span class="sc-product-title">Alpha Widget</span>
        </a>
        <select name="quantity">
          <option value="2" selected>2</option>
        </select>
        <span class="a-price">
          <span class="a-offscreen">$9.99</span>
        </span>
      </div>
… (24 more non-blank lines elided)
```

### `tests/fixtures/amazon/cart-single-item.html`
```html
<!DOCTYPE html>
<html>
<head><title>Amazon Cart</title></head>
<body>
  <span id="nav-cart-count" class="nav-cart-count">1</span>
  <div id="sc-active-cart">
    <div data-name="Active Items">
      <div data-asin="B000ABCDEF" data-itemtype="active" data-itemid="i1" class="sc-list-item">
        <a class="sc-product-link" href="/dp/B000ABCDEF/ref=cart">
          <div class="sc-list-item-spinner">
            <img src="https://images-na.ssl-images-amazon.com/images/G/01/loadIndicators/loading._CB.gif" />
          </div>
          <img class="sc-product-image"
               src="https://m.media-amazon.com/images/I/single-item.jpg"
               data-a-dynamic-image='{"https://m.media-amazon.com/images/I/single-item-large.jpg":[300,300],"https://m.media-amazon.com/images/I/single-item-small.jpg":[150,150]}' />
          <span class="sc-product-title">
            <span class="a-truncate-full">Test Product One</span>
          </span>
        </a>
        <select name="quantity">
… (10 more non-blank lines elided)
```

### `tests/fixtures/amazon/cart-spinner-image.html`
```html
<!DOCTYPE html>
<html>
<head><title>Amazon Cart</title></head>
<body>
  <span id="nav-cart-count">1</span>
  <div id="sc-active-cart">
    <div data-name="Active Items">
      <!-- The row has a spinner img first; the scraper must skip it and pick
           the real .sc-product-image, never the loadIndicators URL. -->
      <div data-asin="B000SPINNER" data-itemtype="active" class="sc-list-item">
        <a class="sc-product-link" href="/dp/B000SPINNER">
          <div class="sc-list-item-spinner">
            <img src="https://images-na.ssl-images-amazon.com/images/G/01/loadIndicators/loading._CB.gif" />
          </div>
          <img class="sc-product-image"
               src="https://m.media-amazon.com/images/I/real-product.jpg" />
          <span class="sc-product-title">Spinner Edge Case</span>
        </a>
        <select name="quantity"><option value="1" selected>1</option></select>
        <span class="sc-product-price">$3.00</span>
… (15 more non-blank lines elided)
```

### `tests/fixtures/amazon/cart-with-saved-for-later.html`
```html
<!DOCTYPE html>
<html>
<head><title>Amazon Cart</title></head>
<body>
  <span id="nav-cart-count">1</span>
  <div id="sc-active-cart">
    <div data-name="Active Items">
      <div data-asin="B000ACTIVE" data-itemtype="active" class="sc-list-item">
        <a class="sc-product-link" href="/dp/B000ACTIVE">
          <img class="sc-product-image" src="https://m.media-amazon.com/images/I/active.jpg" />
          <span class="sc-product-title">Active Item</span>
        </a>
        <select name="quantity"><option value="1" selected>1</option></select>
        <span class="sc-product-price">$10.00</span>
      </div>
    </div>
  </div>
  <!-- Save For Later items must be skipped. The active-scope query above
       narrows to [data-name='Active Items'] so these should be invisible
       to the scraper regardless of markup. -->
… (10 more non-blank lines elided)
```

### `tests/scrape/scrape.test.js`
```js
import { describe, it, expect, beforeEach, afterEach, vi, } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { pageScrapeCart, pageGetCartCount, pageGetCartCountDetailed, } from "../../lib/scrape.js";
const FIXTURE_DIR = path.join( path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "amazon" );
function mountFixture(filename, { url = "https://www.amazon.com/gp/cart/view.html" } = {})
async function runScrape()
let teardown = null;
```

### `tests/unit/amazon-list-scraper.test.js`
```js
import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../../src/background/index.js"), "utf8");
function extractFunction(name)
const pageScrapeAmazonLists = new Function( `${extractFunction("pageScrapeAmazonLists")}; return pageScrapeAmazonLists;` )();
const pageScrapeSingleList = new Function( `${extractFunction("pageScrapeSingleList")}; return pageScrapeSingleList;` )();
const pageClassifyProductAvailability = new Function( `${extractFunction("pageClassifyProductAvailability")}; return pageClassifyProductAvailability;` )();
```

### `tests/unit/bulk-confirm-page.test.js`
```js
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../../src/background/index.js"), "utf8");
function extractFunction(name)
const pageHighlightBulkConfirm = new Function( `${extractFunction("pageHighlightBulkConfirm")}; return pageHighlightBulkConfirm;` )();
```

### `tests/unit/clear-cart-step.test.js`
```js
import { describe, it, expect } from "vitest";
import { evaluateClearStep } from "../../lib/clear-cart.js";
const step = (overrides = {}) => evaluateClearStep({ settled: { rows: null, quantity: null, changed: false }, beforeRows: null, beforeQuantity: null, stalledDel…
```

### `tests/unit/debug-ent-strip.test.js`
```js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(__dirname, "../../", rel), "utf8");
const MARKER = /[ \t]*(?:<!--|\/\*)\s*MC_DEBUG_ENT_START\s*(?:-->|\*\/)[\s\S]*?(?:<!--|\/\*)\s*MC_DEBUG_ENT_END\s*(?:-->|\*\/)[ \t]*\n?/g;
const popupJs = read("popup.js");
const popupHtml = read("popup.html");
```

### `tests/unit/devmode-logging-wiring.test.js`
```js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(__dirname, "../../", rel), "utf8");
const CONTEXTS = [ { name: "observer.js", src: read("observer.js") }, { name: "content.js", src: read("content.js") }, ];
```

### `tests/unit/entitlement.test.js`
```js
import { describe, it, expect } from "vitest";
import { isPremiumActive, cartLimitFor, topNCartIdsByLastUsed, computeCartAccess, canCreateSavedCart, canEditCart, backfillLastUsedAt, FREE_CART_LIMIT, PREMIUM_…
const NOW = 1_700_000_000_000;
const ONE_DAY = 86_400_000;
function freeEnt()
function activePremium()
function lapsedPremium()
function cart(id, lastUsedAt, savedAt = lastUsedAt)
```

### `tests/unit/extpay-sync.test.js`
```js
import { describe, it, expect } from "vitest";
import { EXTPAY_PREMIUM_BUFFER_MS, extpayUserToEntitlementPatch, } from "../../lib/extpay-sync.js";
const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
```

### `tests/unit/helpers.test.js`
```js
import { describe, it, expect } from "vitest";
import { makeId, prunePendingAtc, pruneUpsellChoices, getUrlHost, normalizeAmazonHost, sameAmazonHost, isAmazonCartUrl, isAmazonUrl, isUpsellUrl, normalizeUrlFo…
```

### `tests/unit/list-access.test.js`
```js
import { describe, it, expect } from "vitest";
import { computeListAccess, FREE_CART_LIMIT } from "../../lib/helpers.js";
const FREE = { tier: "free", premiumUntil: null };
const PREMIUM = { tier: "premium", premiumUntil: null };
function lists(...kinds)
const accessOf = (res) => res.lists.map((l) => l.access);
```

### `tests/unit/list-page-add.test.js`
```js
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../../src/background/index.js"), "utf8");
function extractFunction(name)
const pageAddAllFromList = new Function( `${extractFunction("pageAddAllFromList")}; return pageAddAllFromList;` )();
function itemHtml(itemid, asin, { withStepper = false, label = "Add to Cart" } = {})
function withDom(html, fn)
```

### `tests/unit/manifest-floating.test.js`
```js
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse( fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8") );
const backgroundSrc = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
const backgroundSource = fs.readFileSync( path.join(ROOT, "src", "background", "index.js"), "utf8" );
const observerSrc = fs.readFileSync(path.join(ROOT, "observer.js"), "utf8");
const popupJsSrc = fs.readFileSync(path.join(ROOT, "popup.js"), "utf8");
const popupCssSrc = fs.readFileSync(path.join(ROOT, "popup.css"), "utf8");
```

### `tests/unit/native-sync.test.js`
```js
import { describe, it, expect } from "vitest";
import { NATIVE_PREMIUM_BUFFER_MS, nativeEntitlementToPatch, } from "../../lib/native-sync.js";
const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
```

### `tests/unit/observer-atc-intercept.test.js`
```js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { JSDOM } from "jsdom";
const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVER_PATH = resolve(__dirname, "../../observer.js");
const SRC = readFileSync(OBSERVER_PATH, "utf8");
function nextTick()
function delay(ms)
function loadObserver( html, { url = "https://www.amazon.com/dp/B111111111", settings = {}, storageDelayMs = 0, prepareWindow, } = {} )
```

### `tests/unit/page-injected-no-dlog.test.js`
```js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const BG_PATH = resolve(__dirname, "../../background.js");
const SRC = readFileSync(BG_PATH, "utf8");
const LINES = SRC.split("\n");
function findPageFunctions(src)
```

### `tests/unit/storage.test.js`
```js
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readCarts, writeCarts, readSettings, writeSettings, getUpsellChoices, recordUpsellChoice, getRecordedUpsellChoice, } from "../../lib/storage.js";
import { STORAGE_KEY, SETTINGS_KEY, UPSELL_CHOICES_KEY, DEFAULT_SETTINGS, UPSELL_TTL_MS, } from "../../lib/helpers.js";
function installStorageBackend()
```
