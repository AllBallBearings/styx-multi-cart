# Handoff — "Add to List" buybox relocation (Part A)

**Branch:** `cart2list` (uncommitted as of this handoff)
**Date:** 2026-06-29
**Status:** Part A implemented + verified live. Not committed. Part B deferred.

---

## 1. Background / why this exists

Styx Multi-Cart already moves an Amazon **wish list → cart** in bulk (proven, shipping).
The reverse — pushing a saved Styx cart **→ a *named* Amazon wish list** — was attempted on
this branch and found **impossible to automate** (see `src/background/index.js` dead code below).

### The hard constraint (verified live, June 2026, against the owner's account)
Amazon blocks programmatic writes to a *chosen* list:
- `fetch POST /hz/wishlist/additemtolist` (and `/create/newlist`) → **403 "Dogs of Amazon"**
  with every scrapeable CSRF token (page input, popover fragment, module scope).
- The multi-list **chooser only opens on a trusted (`isTrusted`) click**. The extension's own
  `element.click()` is synthetic → Amazon's `atwl` JS ignores it. The add token lives in
  runtime JS state, never in the DOM.
- Only the **default Wish List** is writable fully-automatically (synthetic click on the main
  "Add to List" button lands there). Named/chosen lists cannot be written programmatically.

**Dead-but-present code that relies on the blocked approach** (do NOT trust / do NOT re-attempt):
- `pageAddItemsToList` — `src/background/index.js:3946` (fetch `additemtolist`, 403s live)
- `pageAddToList` — `src/background/index.js:4005` (synthetic chooser click, fires nothing)
- Orchestrators `saveCartToAmazonList` / `createAmazonList` etc. around `src/background/index.js:3567`+
- Messages `MC_SAVE_CART_TO_LIST`, `MC_LIST_AMAZON_LISTS`, `MC_IMPORT_AMAZON_LIST`
  (the **read/import** half works fine; only the **write-to-named-list** half is blocked).

### The unblock (this work)
Don't automate the gated click. **Surface Amazon's OWN "Add to List" control next to "Add to
Cart"** so the **real user** clicks it. A real click is `isTrusted` → the chooser opens → user
picks any named list. Sidesteps the anti-automation entirely. The manual list-pick step is
accepted as fine.

---

## 2. What was built (Part A)

**File:** `observer.js` (root, source of truth) — content script that runs on Amazon pages.
**Mirrored to:** `safari/Styx Multi-Cart/Shared (Extension)/Resources/observer.js` via
`npm run sync:safari` (script copies root files → Safari Resources; do NOT hand-edit the Safari
copy — edit root then sync).

### New code (`observer.js`, in the section before `// ---- Boot`)
- `injectPdpAddToListButton()` — relocates the native widget into the buybox:
  - Gate: requires `#add-to-cart-button` (skips audiobook/non-buyable PDPs that lack ATC).
  - Finds native `#wishlistButtonStack` (the split-button: `#wishListMainButton` = add to
    default list, `#wishListDropDown` = ▼ caret that opens the multi-list chooser).
  - Anchor: `#buy-now-button`.closest('.a-button-stack') (fallback to ATC's stack).
  - **Moves the real node** with `anchor.parentNode.insertBefore(stack, anchor.nextSibling)`.
    **Critical: MOVE, never clone** — a clone's click is trusted but has no Amazon handler bound
    (dead button). Moving preserves Amazon's `a-declarative` handler.
  - Idempotency: `stack.dataset.styxAtlRelocated = "1"` + position check.
  - Styling: outer-container only — `marginTop`, `padding`, `borderRadius`,
    `boxShadow: 0 0 0 2px #c45500` (orange ring). **No `transform`** on the widget — a transform
    shifts the chooser popover's anchor (observed in spike). Do not add transforms here.
- `initPdpAddToList()` — runs inject once, then a **debounced (250ms), idempotent**
  `MutationObserver` scoped to `#dp` (stable product container) so it re-relocates on hydration,
  variant changes, and soft navigations.
- Boot wiring: `if (onProduct) initPdpAddToList();` (added next to `if (isWishlistPage())
  initWishlist();`). `onProduct` = `isProductPage()` already defined at `observer.js:111`.

**No background changes.** No new message. The user's trusted click is the entire mechanism.

### Pattern reused
Mirrors the existing `injectWishlistButton()` / `initWishlist()` at `observer.js:2155` /
`observer.js:2222` (the list-page "Send All to Amazon Cart" button, commit `1ef3fad`). Note that
commit was mislabeled "addtolist button" but is actually a **list→cart** button — unrelated to
this product-page feature.

---

## 3. Verification done

- `node --check observer.js` → clean.
- `npm test` → **217 tests pass** (no new unit tests; no pure helper extracted to test).
- **Live, via Claude-in-Chrome MCP against the owner's logged-in Amazon** (the actual shipped
  function body injected + run on a physical PDP, ASIN `B00NTCH52W`):
  - Relocation renders correctly in the buybox under Add to cart / Buy Now, orange ring visible.
  - A trusted caret click opens the **full named-list chooser** (Wish List, Alexa List, Jared
    Shopping List, Jared's List, Mila Wish List, Shanti 2025, … + Create a List). `chooserOpen:true`.
  - Handler-survives-move proven independently via network: moved caret fires
    `GET /hz/wishlist/addtolist` + per-list `GET /hz/wishlist/listimage` (200s).

### Spike gotchas (automation artifacts, NOT feature bugs) — for the next agent re-testing live
- The ▼ caret is ~26px wide → CDP/ref clicks frequently **miss**. A single *landed* click opens
  the chooser; a **second** click **toggles it closed**. So "click twice then detect" falsely
  reads closed.
- `computer` clicks use **screenshot pixels**, not CSS pixels. Here DPR ≈ 1.04 and an in-page
  "alexa for shopping" side panel shifts layout. Compute `px = cssCenter * (1496 / innerWidth)`;
  beware scroll settling between measuring and clicking (caused a ~60px miss once).
- **Ground truth = network.** `read_network_requests` with `urlPattern: "wishlist"`; presence of
  `/hz/wishlist/addtolist` means the handler fired regardless of popover render/detection.
- Detecting the open chooser: `#atwl-dd-ul` (the list `<ul>`), inside `#a-popover-*` /
  `#atwl-popover-inner`. Do NOT use `#atwl-list-name-*` (stale selector, not present).

---

## 4. Decisions locked (by the owner)

- **Scope = Part A only.** Product-page "Add to List" repositioning.
- Cross-device persistence model: **"Part A button only, defer B"** — ship list-building first,
  decide cart-evacuation later based on adoption.

---

## 5. Open items / next steps

1. **Commit** (not yet done): `observer.js` + `safari/.../Resources/observer.js`
   (+ the `npm run sync:safari` byproducts: `safari/.../background.js`, `manifest.json`, etc.).
   Owner runs commits only when explicitly asked.
2. **Manual smoke test in the real extension** (the live spike injected the function manually; the
   built extension still needs a load):
   - Chrome: `chrome://extensions` → reload unpacked → open several PDPs (standard, variant, and
     a grocery/Fresh PDP) → confirm the button appears by ATC, real click opens the chooser, pick
     a list → item lands; confirm no double-inject on soft-nav / variant change.
   - Safari: rebuild in Xcode (`npm run sync:safari` already run; then
     `xcodebuild -scheme "Styx Multi-Cart (macOS)" -configuration Debug build` from
     `safari/Styx Multi-Cart/`) and uncheck/recheck the extension in Safari Settings → Extensions
     (Safari caches the appex in memory after every rebuild).
3. **Styling polish** — current accent is a conservative orange ring + spacing. Owner wants it
   "more appealing to click than Add to Cart." Safe levers: outer-container background/border,
   label emphasis. **Avoid** restyling the inner `a-button` classes or adding `transform`
   (breaks the chooser popover anchor).
4. **Edge cases to check live:** PDPs where the wishlist widget is absent or behind an accordion;
   logged-out state (chooser won't populate); non-US locales; mobile-web `/gp/aw/d/` PDPs.
5. **Part B (deferred)** — evacuate an existing Amazon cart into a preserved space. Reality map:
   categorization already works via Styx carts (scrape active cart → save named → clear). The only
   reliable *automated* Amazon-list write target is the **default Wish List** (single shared
   bucket); named lists stay blocked. Options were: default-Wish-List echo, guided per-item named
   lists (walk the Part-A button per item), or a Styx native/cloud sync layer. Save-for-later is a
   possible single-bucket automatable target (untested — likely not chooser-gated).

---

## 6. Cleanup note
During the live spike, AA batteries (`B00NTCH52W`) may have been added to the owner's Amazon cart
via stray clicks (cart had 12 items; uncertain which were pre-existing — left untouched). One
Buy-Now checkout was opened and **abandoned (no order placed)**. **No wishlist rows were ever
clicked** (only choosers opened), so no list pollution from this work.

---

## 7. Key file/line index
- `observer.js` — new `injectPdpAddToListButton` / `initPdpAddToList` (before `// ---- Boot`),
  boot call `if (onProduct) initPdpAddToList();`.
- `observer.js:111` — `onProduct` / `isProductPage()`.
- `observer.js:2155` / `:2222` — `injectWishlistButton` / `initWishlist` (pattern reused).
- `src/background/index.js:3946` / `:4005` — dead fetch + synthetic-click write code (do not trust).
- `scripts/sync-safari-resources.sh` — root → Safari mirror (`npm run sync:safari`).
- Memory: `addtolist-buybox-relocation.md`, `cart2list-amazon-sync.md` (under the project's
  `.../memory/` dir) — fuller context.
