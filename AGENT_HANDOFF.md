# Agent Handoff

Last updated: 2026-05-15

---

## Performance Plan (in progress — 2026-05-11)

User reported the extension accumulating messages/errors and using excess memory
when running in the background. Goal: reduce background work, gate active
processing behind "Amazon tab in focus", and stop unbounded retry/poll loops.

### Findings

1. **observer.js manifest patterns too broad.** `*://*.{tld}/gp/*` loads
   observer.js on `/gp/help/`, `/gp/your-account/`, `/gp/orderhistory*`,
   `/gp/css/*`, `/gp/wishlist/*`, `/gp/registry/*`, `/gp/buy/payselect/*`, etc.
   The script early-exits on non-applicable pages but Chrome still creates the
   isolated V8 world per tab, which costs memory across many open Amazon tabs.

2. **10-minute upsell wait loop (`waitForUserUpsellChoice`, background.js:1021).**
   Polls the upsell tab every 1.5s for up to 10 min via `chrome.scripting.executeScript`.
   If the user walks away mid-restore, this keeps the service worker alive and
   injects scripts ~400 times. Probably the biggest leak during operations.

3. **status.js retry loop is unbounded (status.js:62).** On SW restart it
   retries indefinitely with no max-attempt cap. The dot-animation `setInterval`
   keeps firing even when the window is hidden/backgrounded.

4. **Errors mostly from `chrome.scripting.executeScript`** in
   `applyUpsellChoice` / `pageShowStatus` / `isUpsellTab` when tabs navigate
   mid-injection. Swallowed but surfaced in the extension console.

### Plan (in priority order)

- [x] **Step 1 — Narrow observer.js manifest matches.** Replaced `/gp/*` with
      explicit subpath list: `/dp/*`, `/gp/product/*`, `/gp/buy/*`, `/gp/sw/*`,
      `/gp/aw/*`, `/gp/coverage/*`, `/gp/cart/aws/*`. Keeps coverage for product
      pages and upsell flows; drops it from account/help/order/registry pages.
      observer.js's own `isProductPage()` / `isUpsellSurface()` checks remain as
      a second-stage filter — they handle DOM-detected sidesheet upsells on
      product pages and any path inconsistencies.

- [ ] **Step 2 — Bound the upsell wait loop.** - Abort after N seconds of no observable progress (default 90s). - Pause polling when no Amazon tab is visible (`chrome.tabs.query` for the
      helper tab's window + visibility check via `executeScript`). - Increase poll interval from 1.5s → 3s while user is away.

- [ ] **Step 3 — Cap status.js retries; pause on `visibilitychange`.** - Hard max retry count (~20) for SW reconnects. - Pause both the polling and dot animation when `document.hidden`. - Resume on `visibilitychange` → visible.

---

## Roadmap to Public Launch (added 2026-05-11)

Three tracks: store readiness, monetization, and a new "Import list as cart"
feature. None of this is started yet — listed here so the next session can
pick up coherently.

### Track A — Store readiness (Chrome / Edge / Firefox / Safari)

#### A1. Production hygiene

- [ ] Strip / wrap all `console.error` and `console.warn` behind a `DEBUG`
      build flag. Web Store reviewers ding extensions that spam the console.
- [ ] Remove the in-popup Debug panel (`#mc-debug` in popup.html) or hide it
      behind a "developer mode" toggle.
- [ ] Add a `LICENSE` file (MIT or similar) and a real README with
      install/usage instructions and screenshots.
- [ ] Privacy policy page (hosted, e.g. GitHub Pages) — required by Chrome
      Web Store because we access amazon.com content. Must state explicitly
      that no data is collected/transmitted; everything stays in
      `chrome.storage.local`.
- [ ] Permissions justification doc — Web Store now asks per-permission. For
      `storage`, `activeTab`, `scripting`, `tabs`, and each amazon host
      pattern, write a one-line reason.
- [ ] Manifest: add `homepage_url`, `author`, and a long `description` that
      reads like a tagline ("Save and restore multiple Amazon shopping
      carts. Free for 2 carts; unlimited with Pro.").
- [ ] Bump version scheme: switch to `0.x.y` pre-launch, `1.0.0` on launch.

#### A2. Store listing assets

- [ ] Icon already done (128×128 from `icons/_render.py`).
- [ ] Small promo tile 440×280 (Chrome Web Store).
- [ ] Large promo tile 920×680 (optional, helps featured placement).
- [ ] Marquee 1400×560 (optional).
- [ ] 1–5 screenshots at 1280×800 OR 640×400 — popup with saved carts,
      mid-restore status overlay, post-restore confirmation.
- [ ] 30-second demo video (optional but boosts conversion).

#### A3. Cross-browser support

- **Edge**: Manifest V3 native. Should "just work"; need separate listing on
  Microsoft Partner Center.
- **Firefox**: Supports MV3 but with quirks. Must add
  `browser_specific_settings.gecko` block to manifest. `chrome.*` APIs
  work via Mozilla's polyfill; alternately, ship a thin `browser.*`
  shim. Service workers are supported but flaky on long-running
  operations — may need a fallback to event pages.
- **Safari**: Most painful. Requires converting via Xcode
  (`safari-web-extension-converter`), signing with an Apple Developer
  account ($99/yr), and submitting through App Store Connect. Defer
  until traction on Chrome/Edge/Firefox.

#### A4. Tests

- [ ] **Unit tests (Vitest or Jest)** — extract pure functions to a `lib/`
      directory and test: - `normalizeAmazonHost`, `sameAmazonHost`, `isAmazonCartUrl`,
      `isAmazonUrl` in [background.js](background.js). - `pruneUpsellChoices`, `prunePendingAtc`. - Coverage option scoring in `pageApplyUpsellChoice`
      ([background.js:157-224](background.js:157)). - `pickBestImage` in [content.js](content.js).
- [ ] **DOM fixture tests** — snapshot Amazon's cart HTML, run `scrapeCart`,
      `getActiveCartRows`, `findDeleteControl` against fixtures. Refresh
      fixtures any time Amazon's A/B test breaks selectors.
- [ ] **E2E tests with Playwright** — drives a real Chromium instance with
      the extension loaded. Two modes: - **Mocked Amazon**: a local Express server serving fake cart/product
      HTML. Fast, deterministic. Use for CI. - **Real Amazon**: a small smoke suite that logs in with a throwaway
      account and validates save/restore on staging carts. Manual or
      nightly only — Amazon will rate-limit/block CI.
- [ ] **Cross-browser CI** — GitHub Actions matrix:
      `{ chrome | edge | firefox } × { extension-load-test, popup-render-test }`.
      Playwright supports all three.

---

### Track B — Free vs Pro monetization

#### B1. Tier design

- **Free**: 2 saved carts. Save attempt when at limit → prompt to upgrade
  or delete an existing cart.
- **Pro**: 25 saved carts. (Round number, well above typical user need —
  keeps storage size reasonable since each cart is ~10–100 items.
  Unlimited is tempting but invites pathological cases like 500 carts
  that blow out `chrome.storage.local`'s 10 MB quota.)
- Pricing: $4.99 one-time or $1.49/month — TBD; one-time is friendlier and
  avoids subscription churn.

#### B2. Billing infrastructure

- **Recommended: ExtensionPay** (https://extensionpay.com). Built
  specifically for browser extensions, handles Stripe checkout in a
  popup, gives you a `extensionpay.user()` call returning paid status.
  ~5% fee, no monthly minimum, supports Chrome/Firefox/Edge.
- Alternative: roll your own with Stripe Checkout + license key + a tiny
  Cloudflare Worker for validation. More work, lower fees.
- **Do not** rely on Chrome Web Store payments — Google removed extension
  in-app purchases in 2020.

#### B3. Gating implementation sketch

- New helper `getProStatus()` in background.js: cached for 24 h in
  `chrome.storage.local`, refreshed via ExtensionPay SDK.
- `MC_SAVE_CURRENT` / `MC_SAVE_AND_CLEAR` handlers: count existing carts,
  reject with `{ ok: false, code: "FREE_LIMIT", error: "..." }` when at
  cap AND not Pro.
- Popup: show a small "X / 2 carts (Free)" badge near `#mc-list-count`;
  clicking opens an upgrade flow.
- Never silently truncate the user's data. If a paid user lapses, keep all
  saved carts read-only — let them restore and delete but not add new
  ones until they renew.

---

### Track C — Import Amazon Lists as Carts

User idea: let users convert their Amazon Wishlists / Lists into Styx carts
so they can one-click load a curated list to checkout.

#### C1. Feasibility

- List URLs: `/hz/wishlist/ls/{listId}` (modern) and
  `/gp/registry/wishlist/{listId}` (legacy). Both render server-side
  with `data-itemid` rows containing ASIN + title + price + image.
- DOM is materially different from the cart page — needs its own scraper
  function (`pageScrapeList` parallel to `pageScrapeCart`).
- Lists can be private (auth-gated) or public. Auth-gated ones work
  because we're in the user's session.
- Lists can be huge (100+ items). Need to handle pagination ("Page 2",
  `?page=2`) — list pages have a "Load more" button or numbered pages.

#### C2. UX sketch

- New section in popup or a separate "Import" button next to "Save".
- User flow:
  1. Click "Import from list"
  2. Popup prompts: paste a list URL, or pick from "Your lists" (we can
     scrape `/hz/wishlist/` to enumerate them).
  3. Background opens the list URL in a hidden tab, scrapes all pages,
     closes the tab.
  4. Saved as a cart with `name = list name`, `host`, `items[]` — same
     schema as a normal saved cart, so restore Just Works.

#### C3. Implementation steps

- [ ] New `MC_LIST_USER_LISTS` message + `pageScrapeUserLists` to enumerate
      the user's lists from `/hz/wishlist/`.
- [ ] New `MC_IMPORT_LIST` message + `pageScrapeList` to scrape a single
      list (handle pagination internally).
- [ ] Popup UI: list picker modal or URL input.
- [ ] Edge cases: out-of-stock items (Amazon shows but with no ATC button —
      `restoreCart` should treat as a soft failure and surface in the
      "N failed" tail), variant-only items (`/dp/B0...?th=1`), digital
      goods (no qty selector).
- [ ] Should imported carts be marked as "from list" so users can distinguish
      them from manually saved snapshots? Probably yes — small badge in the
      popup.

---

### Track D — Cart editing & merging

Two related features for power users who curate their saved carts over time.

**Status: D1 (remove + qty) and D2 (merge) shipped 2026-05-15 on `feat/editcarts`.**

#### D1. Edit a saved cart

- [ ] **Add current onscreen item to a saved cart.** While on a product
      page (`/dp/...` or `/gp/product/...`), let the user push that single
      ASIN into any saved cart without going through Amazon's actual cart. - New popup button "Add this item to…" (visible only when active tab
      is a product page). - Scrape ASIN + title + price + image from the current page (reuse
      the observer.js `getAsinFromPage` / `getProductTitle` helpers —
      promote them to a shared function). - New message `MC_ADD_ITEM_TO_CART { savedCartId, item }`. Background
      appends to the target cart's `items[]` if the ASIN isn't already
      there; if it is, bump `quantity`.
- [x] **Remove an item from a saved cart.** Each saved cart row has an
      **Edit** button (tooltip "Remove or Multiply Items") that toggles
      an inline panel listing every item with a thumbnail, title, ASIN,
      qty stepper, and × remove control. Removing the final item deletes
      the cart entirely. Handler: `MC_REMOVE_ITEM_FROM_CART { id, asin }`
      in [background.js](background.js).
- [x] **Edit item quantity.** Qty stepper (− / numeric input / +) in the
      same inline panel, clamped 1–99. Optimistic UI with rollback on
      error. Handler: `MC_UPDATE_ITEM_QUANTITY { id, asin, quantity }`.

Also shipped this round (UX polish around D1):

- Rename button removed; the cart name itself is now a clickable button
  (`<button class="mc-item-name" data-action="rename">`) — single-click
  to rename.
- Hover tooltips added to **Restore** ("Move all items to Amazon cart"),
  **Edit** ("Remove or Multiply Items"), and **Delete** ("Delete entire
  cart").

#### D2. Merge Carts

- [x] **Merge two carts** — shipped as "Merge Carts" mode (not "Combine"
      and not "new cart"). Differences from the original spec:
  - **Destination is one of the two source carts**, not a brand-new
    cart. The user picks 2 carts, then a modal asks which direction
    (e.g. "Move A into B" or "Move B into A"). The source cart is
    consumed; the target keeps its name + id.
  - **Merge rule: take max quantity** for duplicate ASINs (per user
    direction), not sum.
  - **Cross-region guard**: blocks the modal with a toast if the two
    carts have different normalized Amazon hosts.
  - UI flow: header **Merge Carts** button toggles selection mode →
    cart rows collapse to checkbox + name + meta → click a row to
    toggle (oldest selection drops if a 3rd is picked) → status bar
    shows "Pick 2 carts to combine." / "Pick 1 more." / "Ready to
    merge?" with Continue + Cancel → modal with two directional
    options, each showing the source + target pills and an animated
    dashed arrow flowing toward the target. Cancel / backdrop click /
    Escape close the modal.
  - Handler: `MC_COMBINE_CARTS { sourceId, targetId }` returns
    `{ ok, target, added, qtyBumped, sourceName, targetName }`.
- [ ] **Append vs replace option** — n/a as written: the current "merge"
      already appends the source into the target in place. The "create
      a new cart from the union" variant remains unimplemented; revisit
      if users ask for it.

---

### Track E — Status toast redesign (shipped 2026-05-12, commit 4cf5598)

- Navy pill with state-colored accent border + glow (amber loading / green
  done / red error).
- Styx logo SVG replaces the spinner; three carts cycle around the triangle
  vertices during loading. Done/error overlays a check or warn glyph.
- Long titles wrap to 2 lines with ellipsis; removed `width: max-content`
  so the pill respects max-width.
- Per-item title truncation in `restoreCart` tightened from 46 → 30 chars.

---

### Track F — Hybrid batch + reconciliation restore

**Status: shipped 2026-05-12 (commit 4cf5598).**

Two-phase restore: try Amazon's batched cart-add endpoint
(`/gp/aws/cart/add.html`) for speed, then verify the live cart against
the saved snapshot and per-item-drive anything the batch dropped. Closes
the reliability gap that historically pushed us toward the slower drive
approach (see existing comment at
[background.js:752-767](background.js:752)).

#### F1. Design

1. **Batch add**: build a URL like
   `/gp/aws/cart/add.html?ASIN.1=B0X&Quantity.1=1&ASIN.2=B0Y&Quantity.2=2…`
   and open it in the helper tab. The user lands on Amazon's "review
   additions" page with all items pre-staged and clicks "Add all" once.
2. **Wait for commit**: detect navigation to `/gp/cart/view.html`.
3. **Reconcile**: scrape the live cart via the existing
   `scrapeCartInBackground` ([background.js:517](background.js:517)) /
   `pageScrapeCart` ([background.js:1425](background.js:1425)), then diff
   against `savedCart.items[]`:
   - **Missing ASINs** → run the existing per-item drive
     (`pageAddToCart` at [background.js:1097](background.js:1097)) on
     just those items, so the normal ATC + upsell pipeline runs.
   - **Quantity drift** → record for the summary; do NOT auto-correct
     (per user direction).
4. **Summary report**: end-of-restore status entry listing dropped items,
   quantity drift, and any items whose seller/variant may differ from
   what was originally saved — so the user can review before checkout.

The existing "batch endpoint is unreliable, drive the UI instead" comment
becomes outdated — it's still unreliable on its own, but reconciliation
is the new reliability mechanism.

#### F2. Implementation checklist

- [x] Batch-URL builder helper; chunk into ≤50-ASIN batches if the saved
      cart is bigger than Amazon's URL-length limit allows.
- [x] Open the batch URL in the helper tab `active: true`; watch for
      landing on `/gp/cart/view.html` to know the user committed.
- [x] Reuse `scrapeCartInBackground` for the verification scrape.
- [x] New `reconcileCart(saved, live)` helper returning
      `{ missing: [...], quantityDrift: [{asin, expected, actual}], possibleVariantMismatch: [...] }`.
- [x] Refactor the per-item-drive loop inside `restoreCart`
      ([background.js:768](background.js:768)) to accept a filtered
      ASIN subset rather than the full saved cart.
- [x] Summary toast / status entry listing all issues, e.g.
      `2 items added with qty 1 instead of 3 — please adjust on the cart page`,
      `1 item came from a different seller — check before checkout`.
- [x] "Restore mode" toggle in the popup — `Quick (batch)` default vs
      `Reliable (drive)` (current behavior). Persist preference in
      `chrome.storage.local`.

#### F3. Decisions & edge cases

- **Quantity drift** → no auto-correct. Surface each affected item in the
  summary with expected vs actual qty; user adjusts on the cart page.
  _(Confirmed by user.)_
- **Variant / seller selection** → the batch endpoint uses Amazon's
  default seller/variant per ASIN, which may differ from what the user
  saw when the cart was originally saved. Don't override; surface in the
  summary so the user can review before checkout. _(Confirmed by user.)_
- **Upsells skip the batch path.** The 24 h upsell-choice replay
  (`getRecordedUpsellChoice` at [background.js:81](background.js:81))
  only fires during the per-item ATC click flow, so items added via batch
  won't get their recorded protection-plan / coverage choices applied.
  Two options:
  - (a) Accept that batch-loaded items skip upsells entirely.
  - (b) After batch + reconcile, run a third pass visiting each ASIN's
    product page just to apply recorded upsell choices.
  - **Recommendation**: ship (a) first; add (b) later if users complain.
- **Pre-clear** → continue using `clearThenRestoreCart`'s
  ([background.js:963](background.js:963)) existing pre-clear step.
  Hybrid path runs after the live cart is empty.
- **URL length limit** → Amazon's batch endpoint caps around 50–100 ASIN
  params. For oversized carts, chunk into multiple batch pages
  sequentially; reconciliation runs once at the very end.

---

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

| Location                                      | Message                                                 |
| --------------------------------------------- | ------------------------------------------------------- |
| `clearAmazonCart` — before loop               | "Clearing cart…"                                        |
| `clearAmazonCart` — after each page reload    | "Clearing cart — removed N of M…"                       |
| `clearAmazonCart` — after loop                | "Cart cleared — N items removed" (done)                 |
| `clearAmazonCart` — after returning to origin | Same done message on origin page                        |
| `clearThenRestoreCart` — 2s settle gap        | "Preparing to restore…"                                 |
| `restoreCart` — after each product page loads | "Restoring cart — adding N of M: [Title]"               |
| `restoreCart` — final cart view               | "Cart restored — N items added" (done) / "… (N failed)" |

---

## Important Files

| File            | Key functions                                                                                                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `background.js` | `scrapeCartInBackground()`, `pageScrapeCart()`, `clearAmazonCart()`, `clearCurrentCartInBackground()`, `restoreCart()`, `clearThenRestoreCart()`, `pageShowStatus()`, `showStatus()`, `waitForTabReload()`, `pageAddToCart()`, `pageGetCartCount()` |
| `content.js`    | `MC_CLEAR_ONE` handler, `pickBestImage()`, `findDeleteControl()`, `isDeletedRow()`, `diagnoseCart()`                                                                                                                                                |
| `popup.js`      | Renders saved carts, filters bad thumbnail URLs at render time, wires all button actions                                                                                                                                                            |
| `popup.css`     | Popup styles; thumbnail size is 44×44 with `object-fit: contain`                                                                                                                                                                                    |

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
