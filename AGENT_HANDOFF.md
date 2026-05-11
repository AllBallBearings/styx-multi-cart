# Agent Handoff

Last updated: 2026-05-09

## Project Overview

**Styx Multi-Cart** is a Chrome MV3 extension that lets users save, restore, and manage multiple Amazon shopping carts. It works by scraping the cart page DOM, storing cart snapshots in `chrome.storage.local`, and driving the real Amazon UI to add items back.

## Current State

All major features are implemented and believed to be working. The extension needs end-to-end testing after reloading in Chrome.

---

## What Was Built This Session

### 1. Save Cart from Any Amazon Page (`scrapeCartInBackground`)

**Problem**: Saving while on a non-cart Amazon page (search results, product page, etc.) caused:
> "Cannot access contents of the page. Extension manifest must request permission to access the respective host."

**Root cause**: The old code used `sendToContent` (message-passing) into a tab that might be at `about:blank` before navigation completed.

**Fix**: New `scrapeCartInBackground()` function in `background.js`:
- If the active tab IS the cart → scrapes directly
- If another open tab IS the cart → reuses it
- Otherwise opens `/gp/cart/view.html` as `active: false` (background, user stays on their page), waits for full load via `waitForTabReload`, scrapes via `chrome.scripting.executeScript` with the self-contained `pageScrapeCart` function, then closes the temp tab

`pageScrapeCart` is a self-contained `executeScript` function — no dependency on `content.js` being loaded.

---

### 2. Thumbnail Images Fixed

**Problem**: Saved cart thumbnails showed Amazon's orange spinner GIF instead of real product images.

**Root causes**:
- `querySelector("img.sc-product-image, img")` selected the spinner overlay (first in DOM) instead of the product image
- Amazon lazy-loads images via `IntersectionObserver` — images in hidden/background tabs never got real URLs
- Old stored carts had `loadIndicators` URLs baked into storage

**Fix**:
- `isUsable()` helper skips any `img` inside `.sc-list-item-spinner`, and rejects `data:`, `loadIndicators`, and `transparent-pixel` URLs
- `img.sc-product-image` is targeted directly first; falls back to first non-spinner `img`
- `pageScrapeCart` dispatches `scroll` + `resize` events before scraping (triggers Amazon's IO even in hidden tabs), then waits 700ms
- Same `isUsable()` logic added to `pickBestImage()` in `content.js`
- `popup.js` filters out `loadIndicators` / `transparent-pixel` URLs from stored carts at render time (fixes old saves without re-saving)

---

### 3. Return to Origin After Clear

**Problem**: After clearing a cart, the user was left on the Amazon cart page instead of wherever they were when they clicked "Clear."

**Fix**: `clearAmazonCart(preferredHost, options)` now accepts:
- `options.returnToOrigin` (bool)
- `options.originUrl` (pre-captured URL string)

Origin URL is captured **before** any navigation. `MC_SAVE_AND_CLEAR` captures origin before scraping (scraping takes time and opens/closes tabs). After clearing completes, the tab navigates back to origin and `waitForTabReload` confirms it arrived.

---

### 4. On-Screen Status Overlay (Most Recent Feature)

**Problem**: During multi-second operations (clearing, restoring), the browser appeared to do nothing — no user feedback.

**Fix**: Added a floating status toast injected into the Amazon page via `chrome.scripting.executeScript`.

**New functions in `background.js`**:

#### `pageShowStatus(message, type)` (self-contained executeScript function)
- Creates/updates a `div#__styx-status-toast` in the page DOM
- Position: **top-center** (`top: 24px`, `left: 50%`, `transform: translateX(-50%)`)
- Types:
  - `'loading'` → amber (#ff9900) background, spinning circle icon, persists
  - `'done'` → green (#1e7e34) background, checkmark icon, auto-dismisses after 4s
  - `'error'` → red (#b1271b) background, warning icon, auto-dismisses after 5s
- Font size 19px, padding 14px 24px, max-width 560px, `pointer-events: none`
- Injects `@keyframes _styxSpin` once per page for the spinner

#### `showStatus(tabId, message, type)` (async helper)
- Wraps `chrome.scripting.executeScript({ func: pageShowStatus, args: [message, type] })`
- Swallows all errors — status is decorative, never blocks main flow

**Status call sites**:

| Location | Message |
|----------|---------|
| `clearAmazonCart` — before loop | "Clearing cart…" |
| `clearAmazonCart` — after each page reload | "Clearing cart — removed N of M…" |
| `clearAmazonCart` — after loop | "Cart cleared — N items removed" (done) |
| `clearAmazonCart` — after returning to origin | Same done message on origin page |
| `clearThenRestoreCart` — 2s settle gap | "Preparing to restore…" |
| `restoreCart` — after each product page loads | "Restoring cart — adding N of M: [Title]" |
| `restoreCart` — final cart view | "Cart restored — N items added" (done) / "… (N failed)" |

---

## Important Files

| File | Key functions |
|------|--------------|
| `background.js` | `scrapeCartInBackground()`, `pageScrapeCart()`, `clearAmazonCart()`, `clearCurrentCartInBackground()`, `restoreCart()`, `clearThenRestoreCart()`, `pageShowStatus()`, `showStatus()`, `waitForTabReload()`, `pageAddToCart()`, `pageGetCartCount()` |
| `content.js` | `MC_CLEAR_ONE` handler, `pickBestImage()`, `findDeleteControl()`, `isDeletedRow()`, `diagnoseCart()` |
| `popup.js` | Renders saved carts, filters bad thumbnail URLs at render time, wires all button actions |
| `popup.css` | Popup styles; thumbnail size is 44×44 with `object-fit: contain` |

## Known Good Selectors (confirmed 2026-05-09)

```
Active cart row:   div[data-asin][data-itemtype='active']
Delete button:     input[value='Delete'][data-action='delete-active']  (type=submit, in form#activeCartViewForm)
Add to Cart:       #add-to-cart-button  /  input[name='submit.add-to-cart']
Save For Later:    div[data-asin][data-itemtype='saved']
Product image:     img.sc-product-image  (inside a.sc-product-link — NOT the spinner inside .sc-list-item-spinner)
```

---

## Pending Test: Upsell Recording & 24h Replay

A new system records the user's protection-plan / warranty / coverage choices
when they add items to their Amazon cart normally, and replays those choices
when restoring a saved cart containing the same ASIN (24h TTL).

**Files involved:**
- `observer.js` — new content script on `/dp/*` and `/gp/*` pages. Watches ATC
  clicks on product pages and choice clicks on upsell surfaces.
- `background.js` — `recordUpsellChoice`, `getRecordedUpsellChoice`,
  `applyUpsellChoice`, `pageApplyUpsellChoice`, `_pendingAtc` map, plus
  `MC_OBSERVE_ATC` and `MC_OBSERVE_UPSELL_CHOICE` message handlers.
- `manifest.json` — added a second content_scripts entry for observer.js
  matching `*://*.{tld}/dp/*` and `*://*.{tld}/gp/*` across all 12 Amazon TLDs.

**Testing checklist:**
- [ ] Reload the extension after pulling the changes.
- [ ] Find an Amazon product that triggers a protection-plan upsell (most
      electronics, appliances, watches). Add it to cart normally.
- [ ] When the upsell shows, click "No thanks" (or pick a coverage tier and
      Continue). Both decline and accept paths need separate tests.
- [ ] Open the service worker console and confirm
      `chrome.storage.local` contains `mc.upsell.choices.v1` with the ASIN
      as a key and `recordedAt` timestamp.
- [ ] Save the cart, clear it, then restore it. During restore, the status
      window should show `Applying your choice earlier today: "No coverage"…`
      and the upsell page should auto-submit without prompting.
- [ ] Verify replay works for **decline** (easy: stable selectors).
- [ ] Verify replay works for **accept** when tiers haven't changed.
- [ ] Verify graceful fallback to manual prompt when the same ASIN's
      upsell tiers have changed (cannot score ≥50 confidently).
- [ ] Verify TTL: change a recorded entry's `recordedAt` to >24h ago in
      DevTools storage, then restore — should prompt manually, not replay.
- [ ] Verify the entry is auto-pruned from storage on next read.
- [ ] Verify nothing was flagged by Amazon (no CAPTCHA storm, no account
      warnings) after running through 10+ cart restores.

**Safety design notes:**
- Never auto-declines by default — only replays choices the user themselves
  made on the same product within the last 24h.
- 24h TTL keeps stale choices from being replayed when offered tiers shift.
- Accept replay requires confident match (≥50/100 score across label tokens,
  price within $1, duration within 2 months) or it falls back to manual.

## To Do / Testing Checklist

- [ ] Reload the unpacked extension in Chrome (`chrome://extensions` → reload icon)
- [ ] **Test Save** from a non-cart Amazon page (search or product page) — should save silently in background without navigating user
- [ ] **Test Clear** — each item should disappear one at a time; status overlay should update top-center on the cart tab; user should return to original page after done
- [ ] **Test Save & Clear** — popup toast says "Saved N items — clearing cart in background"; cart clears; user returns to origin
- [ ] **Test Restore** — status overlay should show "Restoring cart — adding N of M: [Title]" on each product page; ends on cart view with "Cart restored — N items added"
- [ ] **Test thumbnails** — new saves should show real product images, not spinners
- [ ] Re-save existing carts ("technology", "Mother's Day", "Graduation") to get fresh thumbnails (old stored data has spinner URLs; popup renders them blank, which is correct behavior)
- [ ] **Test protection-plan upsell** during Restore — Styx should pause and show alert; continue after user chooses

## Known Remaining Issues / Limitations

- MV3 service worker can be evicted mid-restore for very large carts (browser restarts the worker, losing in-progress state)
- Popup only shows fire-and-forget toast for `MC_CLEAR_CURRENT` ("Clearing your cart — check the Amazon tab") — final count not reported back to popup
- `navigateTabAndWait` and `createTabAndWait` are still present in `background.js` but only used for exact-URL cart navigation in `clearAmazonCart` (safe — that URL is one we control). Restore no longer uses them.
- Status overlay disappears on page navigation (expected — new page destroys DOM). It is re-injected after each page reload in the clear/restore loops.
