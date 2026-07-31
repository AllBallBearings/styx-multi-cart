# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Styx Multi-Cart is a Manifest V3 browser extension that turns Amazon **lists** into reusable **carts**. The current product model: every Amazon list *is* a cart, backed by the user's Amazon account and synced across devices. Older local saved-carts (`mc.carts.v1`) still exist but are de-emphasized. Free tier = 3 carts; Premium = unlimited ($9.99/yr or $19.99 lifetime). The live Amazon cart is always first-class and free, even if Premium lapses.

There is no server. The extension only stores settings/entitlement in `chrome.storage.local` and drives amazon.com on the user's behalf.

## Critical build facts

- **`background.js` (repo root) is GENERATED — never edit it.** It is an esbuild bundle of `src/background/index.js` plus the `lib/*.js` ESM modules. Edit `src/background/index.js`; run `npm run build` to regenerate. The manifest loads the bundled `background.js` as a classic service worker.
- **The `safari/**/Resources/*` web-extension files are also generated copies.** The repo-root files (`content.js`, `observer.js`, `popup.*`, `status.*`, generated `background.js`) are canonical; `npm run sync:safari` copies them into the Xcode project. Don't edit the Safari `Resources/` copies by hand.
- **Two build flavors: dev vs prod.** Dev builds keep debug entitlement presets (behind a Developer-mode unlock) so the paywall UI can be exercised locally. Prod strips them via `scripts/strip-debug-ent.py`, keyed on `MC_DEBUG_ENT_START`/`_END` comment markers in `popup.js`/`popup.html`. For day-to-day dev, just load the repo folder unpacked — no build needed.

## Commands

```bash
npm run build                  # regenerate background.js from src/background/index.js (esbuild)
npm test                       # vitest run — unit + integration (Node env)
npm run test:watch             # vitest watch
npm run test:e2e               # playwright — loads the unpacked extension
npm run test:all               # build + unit + e2e

npx vitest run tests/unit/entitlement.test.js   # single test file
npx vitest run -t "some name"                    # single test by name

bash scripts/build-zip.sh                        # Chrome Web Store zip → dist/ (debug controls STRIPPED)
STYX_KEEP_DEBUG_ENT=1 bash scripts/build-zip.sh  # dev-flavored zip (controls kept)

npm run sync:safari            # sync web-ext files into Xcode project — debug controls KEPT
npm run sync:safari -- --prod  # same, but debug controls STRIPPED (run right before archiving)
```

## Runtime architecture

Four contexts, message-passing over `chrome.runtime`:

- **Service worker** (`src/background/index.js` → bundled `background.js`) — does all real work. Cart CRUD, entitlement sync, and all Amazon automation. "Send All to Amazon Cart" opens one helper tab and walks it through each product page, clicking Amazon's *real* Add-to-Cart button (~3–5s/item) so auth, region locks, buy-box, and quantity caps are handled by Amazon's own page logic. Key paths: `restoreCart`, `restoreCartBulk`, `restoreViaListPage`, `wishlistAddAllToCart`, `saveCartToAmazonList`, `importAmazonListToCart`, `listAmazonLists`/`readAmazonList`.
- **`content.js`** — runs on Amazon cart pages. Scrapes items and clears the cart. Has a re-injection guard (`window.__styxMcContentLoaded`) because the SW injects it on demand when a tab has no listener (Safari "Ask" site access). Cart selectors live at the top of this file; Amazon A/B-tests its cart markup, so these break periodically.
- **`observer.js`** — runs on product/upsell pages. Intentionally **read-only** (never auto-clicks): reports Add-to-Cart clicks and upsell/protection-plan choices to the SW, and injects the "Add to a Styx cart" button + relocates Amazon's native Add-to-List widget next to Add-to-Cart.
- **`popup.js`/`.html`/`.css`** — the UI. Renders state and forwards clicks; no real logic. Loaded as popup, side panel (`?surface=sidepanel`), or floating in-page modal.
- **`status.js`/`.html`/`.css`** — live operation window; polls the SW every 350ms.

### `page*` functions — the injection convention

Functions named `page*` in `src/background/index.js` (e.g. `pageScrapeCart`, `pageAddToCart`, `pageAddAllFromList`, `pageScrapeAmazonLists`) are stringified and injected into Amazon tabs via `chrome.scripting.executeScript`. They run in the **page context**, so they must be fully self-contained — no `dlog`, no closure references, no imports. A test (`tests/unit/page-injected-no-dlog.test.js`) enforces that page-injected functions don't call `dlog`. This constraint is why they can't be `export`ed and are tested differently (see below).

## Entitlement / monetization

Pure entitlement logic lives in `lib/` so it's unit-testable, and is mirrored/imported by the service worker:

- `lib/helpers.js` — `isPremiumActive`, `cartLimitFor`, `computeCartAccess`, `computeListAccess`, `canCreateSavedCart`, `canEditCart`; constants `FREE_CART_LIMIT` (3), `PREMIUM_CART_LIMIT` (20), storage keys.
- `lib/extpay-sync.js` — Chrome billing via ExtensionPay (`ExtPay.js` is vendored at root, `EXTPAY_ID = "styx-multi-cart"`). `extpayUserToEntitlementPatch`.
- `lib/native-sync.js` — Safari/Apple billing via StoreKit. `StoreManager.swift` handles purchases; `SafariWebExtensionHandler.swift` passes the entitlement into JS, applied by `nativeEntitlementToPatch`.
- `IS_SAFARI` is detected at runtime (URL scheme `safari-web-extension://`); ExtPay is only wired on non-Safari.

Over-limit carts render grayed and open the upgrade screen — **list creation itself is never blocked**.

## Storage keys (`chrome.storage.local`)

`mc.carts.v1` (legacy local carts), `mc.settings.v1`, `mc.entitlement.v1`, `mc.dev.v1` (Developer-mode flag), `mc.upsell.choices.v1` (24h TTL), `mc.promos.v1`. Amazon lists themselves are the source of truth for the current cart model — read/written by driving Amazon list pages, not stored locally.

## Testing patterns

- **`lib/*` modules are imported normally** and unit-tested directly.
- **`page*` and other non-exported SW functions are tested by reading `src/background/index.js` (or `observer.js`) as text, extracting one function with a regex helper, and evaluating it via `new Function(...)` inside JSDOM.** See `tests/unit/amazon-list-scraper.test.js`, `list-page-add.test.js`, `bulk-confirm-page.test.js`, `observer-atc-intercept.test.js`. When you rename or reshape such a function, these extractors can silently miss it — check them.
- Cart-scrape logic is fixture-driven: `lib/scrape.js` against HTML in `tests/fixtures/amazon/` (empty, multi-item, spinner-image, saved-for-later, EWC flyout, permissive fallback).
- `tests/setup.js` stubs `chrome` with `sinon-chrome`. E2E (`tests/e2e/`) loads the real unpacked extension and stubs Amazon list data.

## Diagnostics

Settings gear → type `STYXDEV` → a Developer-mode switch appears → enables verbose logging. `dlog`/`dwarn`/`dinfo` in every context forward to the SW's in-memory ring buffer (`LOG_RING`, max 500), gathered by the popup's "Copy diagnostic logs". The unlock is a convenience, **not** a security boundary (it's in the source) — which is why the entitlement-forging debug controls are stripped from production builds.

## Repo map

`LLM_MAP.md` (repo root) is a token-efficient skeleton of the whole codebase. Read it before opening source files; regenerate it with the `context-distiller` skill when it goes stale. `background.js`, `ExtPay.js`, `test-results/`, and `store-assets/` are excluded via `.llmignore`.
