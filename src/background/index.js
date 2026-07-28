/**
 * background.js — service worker.
 *
 * Owns:
 *   - Storage layer (chrome.storage.local) for saved carts.
 *   - Restore logic: clears the active cart and drives product-page Add to Cart.
 *   - Tab discovery: finds (or opens) an Amazon cart tab to send messages to.
 *   - ExtensionPay entitlement sync (daily alarm + onPaid listener).
 *
 * Testing note: this source is bundled into the classic background.js that
 * the manifest loads. Prefer importing shared tested helpers from lib/ instead
 * of mirroring them here. Some helpers are still duplicated during migration;
 * remove those copies incrementally as the source tree is split up.
 */

// ExtensionPay SDK. Must come before any reference to `ExtPay(...)`.
// Vendored from `npm install extpay` → node_modules/extpay/dist/ExtPay.js.
import { extpayUserToEntitlementPatch } from "../../lib/extpay-sync.js";
import { nativeEntitlementToPatch } from "../../lib/native-sync.js";
import { evaluateClearStep } from "../../lib/clear-cart.js";

// Verbose service-worker logging. Controlled at runtime by the `mc.dev.v1`
// flag. The popup keeps that switch behind a private Settings unlock so normal
// users don't see developer tooling. This let is intentionally NOT a const:
// it's hydrated from storage at SW startup and updated live via the
// chrome.storage.onChanged listener farther down. console.error is always
// unconditional regardless of this flag.
//
// IMPORTANT: never hard-code `let DEBUG = true` and ship — the build script
// (scripts/build-zip.sh) refuses to package a zip when it sees that.
//
// ⚠️ DO NOT use these helpers inside any `function page*(...)` defined below
// — those run in an injected Amazon page context that has zero access to
// this scope, so a call like `dlog(...)` throws ReferenceError, rejects the
// wrapping Promise, and bubbles up as a generic failure with no visible
// diagnostic in the service-worker console. Inside page-injected functions
// always use raw `console.log` / `console.warn`.
let DEBUG = false;

// In-memory diagnostic log ring. Every extension context (this service worker,
// the content scripts, and the popup) funnels its dev-mode logs here via
// MC_LOG_PUSH, so the popup's "Copy diagnostic logs" button can assemble one
// paste-able report spanning all of them. In-memory only: it's wiped when the
// SW is evicted, which is fine — diagnostics are gathered live, right after the
// user reproduces the issue with Developer mode on.
const LOG_RING_MAX = 500;
const LOG_RING = [];
function mcStringifyArgs(args) {
  return args
    .map((v) => {
      if (typeof v === "string") return v;
      try {
        return JSON.stringify(v);
      } catch (_) {
        return String(v);
      }
    })
    .join(" ");
}
function pushLogEntry(entry) {
  if (!entry || typeof entry !== "object") return;
  LOG_RING.push({
    ts: typeof entry.ts === "number" ? entry.ts : Date.now(),
    ctx: typeof entry.ctx === "string" ? entry.ctx : "?",
    level: typeof entry.level === "string" ? entry.level : "log",
    url: typeof entry.url === "string" ? entry.url : "",
    msg: typeof entry.msg === "string" ? entry.msg : mcStringifyArgs([entry.msg]),
  });
  if (LOG_RING.length > LOG_RING_MAX) {
    LOG_RING.splice(0, LOG_RING.length - LOG_RING_MAX);
  }
}
const dlog = (...a) => {
  if (!DEBUG) return;
  console.log(...a);
  pushLogEntry({ ctx: "sw", level: "log", msg: mcStringifyArgs(a) });
};
const dinfo = (...a) => {
  if (!DEBUG) return;
  console.info(...a);
  pushLogEntry({ ctx: "sw", level: "info", msg: mcStringifyArgs(a) });
};
const dwarn = (...a) => {
  if (!DEBUG) return;
  console.warn(...a);
  pushLogEntry({ ctx: "sw", level: "warn", msg: mcStringifyArgs(a) });
};

// Runtime platform flag. Safari serves extension pages from a
// `safari-web-extension://` origin; Chrome/Edge/Firefox use other schemes.
// Drives the payment-source branch (App Store IAP on Safari, ExtensionPay
// elsewhere) plus a few Safari-only UI quirks further down.
const IS_SAFARI = chrome.runtime
  .getURL("")
  .startsWith("safari-web-extension://");

const STORAGE_KEY = "mc.carts.v1";
const SETTINGS_KEY = "mc.settings.v1";
const ENTITLEMENT_KEY = "mc.entitlement.v1";
const DEV_FLAG_KEY = "mc.dev.v1";
const PROMO_KEY = "mc.promos.v1"; // { [sha256(code)]: redeemedAtMs }

// SHA-256 hashes of valid friends-and-family promo codes. Each grants 90 days
// of Premium and is one-redemption-per-device (we record the hash in PROMO_KEY
// so re-entering on the same machine no-ops).
//
// Plaintext codes and the hash → code mapping live in
// docs/internal/PROMO-CODES.md (gitignored). DO NOT paste plaintext codes here,
// in trailing comments, or in placeholder text — anything in this file ships
// to every install and is readable by unzipping the .crx, which would defeat
// the entire point of hashing.
//
// To rotate, hash a new code locally and append it here:
//   printf %s 'YOUR-NEW-CODE' | shasum -a 256
const PROMO_HASHES = Object.freeze([
  "47f0ec155e6bcfcdf6f63f88879a868a7dbaafdd1f95913eed6aa221fc7e9961",
  "848eebb65c9c41aac69fc477bc1945d549bae0a695424e82f7785b26f44cbdd8",
  "e65b027f86e44c499b56389e48809f522b95f6db5cf03d60a36d6ebbcd12bb39",
  "81c7ad92980b69076455644934ebaf932c3bbcdfbedd28b867d98c2dfe0f6cf7",
  "e0a8d5a301195b7f3386f8b419ace9e8b55f1e7137ff0b5aa8e24753580a9b13",
]);
const PROMO_GRANT_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// Tier limits — keep in sync with lib/helpers.js. See docs/MONETIZATION_PLAN.md.
const FREE_CART_LIMIT = 3;
const PREMIUM_CART_LIMIT = 20;

const DEFAULT_ENTITLEMENT = Object.freeze({
  tier: "free",
  premiumUntil: null, // epoch ms, or null for lifetime premium / free
  autoRenew: false,
  source: null,
  lastChecked: 0,
});

// User-tunable feature toggles. Shape kept tiny on purpose — new fields
// merge with defaults so old stored shapes never block a launch.
const DEFAULT_SETTINGS = {
  interceptAtc: true,
  // Relabel Amazon's wish-list surfaces as Styx "carts" ("Your Lists" →
  // "Your Styx Carts", custom list names "List" → "Cart"). On by default;
  // read by observer.js, which reverts live when toggled off.
  relabelListsAsCarts: true,
  // Pulse the in-page floating Styx button (orange glow) as a reminder to use
  // it. On by default; read by observer.js, toggled from popup settings.
  fabPulse: true,
  // Which surface the toolbar icon opens on Chrome: "sidepanel" (default,
  // docked panel) or "popup" (compact popover). Ignored where chrome.sidePanel
  // is unavailable (e.g. Safari), which always uses the popup.
  uiSurface: "sidepanel",
  // Ephemeral flag — set to true for the duration of a cart restore so the
  // observer.js ATC intercept stands down. Cleared in a finally block so a
  // crash or early return can never leave interception permanently disabled.
  restoring: false,
  // Ephemeral flag — set to true while a multi-navigation operation (clearing
  // the cart, saving a cart to an Amazon list) drives one page load after
  // another. observer.js suppresses the floating window's auto-reopen while it
  // is set, so the popup doesn't rebuild and re-hit the lists API on every
  // navigation. Like `restoring`, it's cleared in a finally block.
  busy: false,
};

// ---- Storage helpers ------------------------------------------------------

async function readCarts() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const carts = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
  // Backfill lastUsedAt on carts saved before the entitlement layer existed.
  // Mirrored from lib/helpers.js#backfillLastUsedAt — keep in sync.
  for (const c of carts) {
    if (c && !Number.isFinite(c.lastUsedAt)) {
      const sa = Number(c.savedAt);
      c.lastUsedAt = Number.isFinite(sa) ? sa : 0;
    }
  }
  // Normalize the Amazon-list sync fields. Mirrored from
  // lib/helpers.js#backfillCartSyncFields — keep in sync.
  for (const c of carts) {
    if (!c || typeof c !== "object") continue;
    if (!("amazonListId" in c)) c.amazonListId = null;
    if (!("amazonListUrl" in c)) c.amazonListUrl = null;
    if (!("syncedAt" in c)) c.syncedAt = null;
  }
  return carts;
}

async function writeCarts(carts) {
  await chrome.storage.local.set({ [STORAGE_KEY]: carts });
}

// ---- Entitlement (mirrored from lib/helpers.js + lib/storage.js) ----------
// See docs/MONETIZATION_PLAN.md. This source is now bundled, so remaining
// mirrored helpers can be replaced with imports in follow-up refactors.

async function readEntitlement() {
  const result = await chrome.storage.local.get(ENTITLEMENT_KEY);
  const stored = result[ENTITLEMENT_KEY];
  return Object.assign(
    {},
    DEFAULT_ENTITLEMENT,
    stored && typeof stored === "object" ? stored : {}
  );
}

async function writeEntitlement(patch) {
  const current = await readEntitlement();
  const next = Object.assign({}, current, patch || {});
  await chrome.storage.local.set({ [ENTITLEMENT_KEY]: next });
  return next;
}

async function isDevModeEnabled() {
  const r = await chrome.storage.local.get(DEV_FLAG_KEY);
  return r[DEV_FLAG_KEY] === true;
}

// ---- Promo code redemption (friends-and-family trial) --------------------
// Pre-ExtensionPay path for granting Premium. The shipped bundle only
// contains SHA-256 hashes of valid codes (see PROMO_HASHES); a leaked code
// can be revoked in the next release by removing its hash.

async function sha256Hex(input) {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function redeemPromoCode(rawCode) {
  const norm = String(rawCode || "")
    .trim()
    .toUpperCase();
  if (!norm) return { ok: false, error: "Enter a code." };

  const hash = await sha256Hex(norm);
  if (!PROMO_HASHES.includes(hash)) {
    return { ok: false, error: "That code isn't valid." };
  }

  const got = await chrome.storage.local.get(PROMO_KEY);
  const redeemed = (got[PROMO_KEY] && typeof got[PROMO_KEY] === "object") ? got[PROMO_KEY] : {};
  if (redeemed[hash]) {
    return { ok: false, error: "This code has already been used on this device." };
  }

  const now = Date.now();
  const current = await readEntitlement();
  // If they already have a longer premium window (e.g. real subscription),
  // don't shorten it — extend from whichever is later.
  const baseline =
    typeof current.premiumUntil === "number" && current.premiumUntil > now
      ? current.premiumUntil
      : now;
  const premiumUntil = baseline + PROMO_GRANT_MS;

  const next = await writeEntitlement({
    tier: "premium",
    premiumUntil,
    autoRenew: false,
    source: "promo",
    lastChecked: now,
  });

  await chrome.storage.local.set({
    [PROMO_KEY]: { ...redeemed, [hash]: now },
  });

  return { ok: true, entitlement: next, premiumUntil };
}

// ---- ExtensionPay integration --------------------------------------------
// Extension ID assigned at extensionpay.com after registering this extension.
// See docs/internal/EXTENSIONPAY-SETUP.md. The guards below still check for the
// old "REPLACE_ME" placeholder so that resetting it to a dev value can't
// accidentally downgrade a paying user; with a real ID set they're inert.
const EXTPAY_ID = "styx-multi-cart";
const EXTPAY_SYNC_ALARM = "mc-extpay-sync";
const EXTPAY_SYNC_PERIOD_MIN = 60 * 24; // daily

// ExtensionPay is the payment source for Chrome/Edge/Firefox only. On Safari,
// Apple's App Store guideline 3.1.1 requires In-App Purchase for digital
// unlocks, so the Safari build buys via StoreKit in the native host app and
// reads the result over the native-message bridge (syncEntitlementFromNative).
// Keep ExtPay entirely inert on Safari — no SDK init, no network, no console
// noise for App Review.
const extpay =
  !IS_SAFARI && typeof ExtPay === "function" ? ExtPay(EXTPAY_ID) : null;
if (IS_SAFARI) {
  // No-op: native StoreKit path is wired in below.
} else if (!extpay) {
  // ExtPay.js failed to load — shouldn't happen in production but might in
  // a half-broken dev unpack. The rest of the extension keeps working;
  // upgrades and license-sync are just no-ops until reload.
  console.error("[Styx Multi-Cart] ExtPay SDK not available — payment paths disabled.");
} else {
  // Required: makes the SDK listen for postMessage from extensionpay.com so
  // a successful checkout actually flips the user to paid in storage.
  extpay.startBackground();
  if (EXTPAY_ID === "REPLACE_ME") {
    console.error(
      "[Styx Multi-Cart] EXTPAY_ID is still 'REPLACE_ME' — set it before " +
        "publishing. See docs/internal/EXTENSIONPAY-SETUP.md.",
    );
  }
}

// ---- Native side panel --------------------------------------------------
//
// Styx's UI is a native Chrome side panel (manifest `side_panel`). Unlike
// the old in-page iframe overlay, the browser genuinely shrinks the page
// viewport, so Amazon's responsive layout stays intact. Clicking the
// toolbar icon toggles the panel. Chrome forbids opening it without a user
// gesture, so there is no auto-open on page load — once the user opens it,
// Chrome keeps it open across tabs/navigation in that window.
// Apply the user's chosen toolbar surface (Chrome only). "popup" sets an
// action popup so the icon opens a compact popover; "sidepanel" clears the
// popup so the icon toggles the docked side panel. No-op where chrome.sidePanel
// is unavailable (Safari) — that path always falls back to the popup.
function applyUiSurface(surface) {
  if (!(chrome.sidePanel && chrome.sidePanel.setPanelBehavior)) return;
  const wantPopup = surface === "popup";
  Promise.resolve(
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: !wantPopup })
  ).catch((e) => console.error("[Styx Multi-Cart] sidePanel setup failed:", e));
  if (chrome.action && chrome.action.setPopup) {
    try {
      chrome.action.setPopup({
        popup: wantPopup ? "popup.html?surface=popup" : "",
      });
    } catch (e) {
      console.error("[Styx Multi-Cart] action.setPopup failed:", e);
    }
  }
}

if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  readSettings()
    .then((s) => applyUiSurface(s.uiSurface))
    .catch(() => applyUiSurface("sidepanel"));
}

// The UI is now an in-page floating modal (injected by observer.js on Amazon
// pages) rather than a native side panel. With no default_popup and no
// side_panel, clicking the toolbar icon fires action.onClicked — forward it to
// the active tab's content script to toggle the modal. On tabs without
// observer.js (non-Amazon) there's no receiver, so the message just no-ops.
if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    if (!tab || tab.id == null) return;
    try {
      chrome.tabs.sendMessage(tab.id, { type: "MC_TOGGLE_FLOATING" }, () => {
        // Swallow "Receiving end does not exist" on tabs without the observer.
        void chrome.runtime.lastError;
      });
    } catch (_e) {
      /* ignore */
    }
  });
}

/**
 * Pull the current ExtPay user, translate to an entitlement patch, write.
 * Safe to call freely — on network/SDK error, leaves entitlement untouched
 * so a user with active premium doesn't get downgraded by a flaky network.
 */
async function syncEntitlementFromExtPay() {
  if (!extpay) return;
  // ExtPay isn't wired up yet (placeholder ID). Calling getUser would hit a
  // non-existent extension and report "unpaid", which must not downgrade a
  // promo/dev grant. Skip entirely until a real EXTPAY_ID is set.
  if (EXTPAY_ID === "REPLACE_ME") return;
  let user;
  try {
    user = await extpay.getUser();
  } catch (err) {
    dwarn("[Styx Multi-Cart] ExtPay getUser failed; leaving entitlement alone:", err);
    return;
  }
  // DEBUG-only: dump the full raw user object so we can confirm exactly which
  // fields ExtPay returns for each plan (esp. the lifetime/one-time plan, whose
  // shape determines whether premiumUntil must be set to "never expires"). Safe
  // to leave in — gated behind Developer mode, stripped in production builds.
  dlog("[Styx Multi-Cart] ExtPay getUser() raw object:", JSON.stringify(user, null, 2));
  const current = await readEntitlement();
  const patch = extpayUserToEntitlementPatch(user, current, Date.now());
  await writeEntitlement(patch);
  dlog("[Styx Multi-Cart] entitlement synced from ExtPay:", patch);
}

/**
 * Safari only. Ask the native host (SafariWebExtensionHandler) for the current
 * App Store entitlement — which the Swift StoreManager keeps in a shared App
 * Group after each StoreKit purchase / Transaction.update — and translate it to
 * an entitlement patch. Safe to call freely: on bridge error we leave the
 * stored entitlement untouched so a paying user is never downgraded by a flaky
 * read.
 */
async function syncEntitlementFromNative() {
  if (!IS_SAFARI) return;
  let native;
  try {
    // Safari exposes the promise-style sendNativeMessage on `browser`; fall
    // back to `chrome` defensively. The message routes to the extension's
    // SafariWebExtensionHandler (no application id needed on Safari).
    const runtime =
      typeof browser !== "undefined" &&
      browser.runtime &&
      typeof browser.runtime.sendNativeMessage === "function"
        ? browser.runtime
        : chrome.runtime;
    native = await runtime.sendNativeMessage({ action: "getEntitlement" });
  } catch (err) {
    dwarn(
      "[Styx Multi-Cart] native getEntitlement failed; leaving entitlement alone:",
      err,
    );
    return;
  }
  dlog("[Styx Multi-Cart] native getEntitlement raw object:", JSON.stringify(native));
  const current = await readEntitlement();
  const patch = nativeEntitlementToPatch(native, current, Date.now());
  await writeEntitlement(patch);
  dlog("[Styx Multi-Cart] entitlement synced from App Store:", patch);
}

/**
 * Refresh the entitlement from whichever payment source this build uses:
 * StoreKit/App Store on Safari, ExtensionPay everywhere else.
 */
async function syncEntitlement() {
  return IS_SAFARI ? syncEntitlementFromNative() : syncEntitlementFromExtPay();
}

// Daily alarm wakes the service worker even if the popup is never opened.
// (Alarm name is historical — it now drives the active payment source for the
// build, ExtPay or App Store.)
chrome.alarms.create(EXTPAY_SYNC_ALARM, {
  periodInMinutes: EXTPAY_SYNC_PERIOD_MIN,
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === EXTPAY_SYNC_ALARM) syncEntitlement();
});

// Sync once when the service worker spins up (e.g. on browser startup, on
// install/update, or after the worker has been suspended). Doesn't block
// other event registration because top-level awaits aren't allowed here.
syncEntitlement();

// Clear the ephemeral operation flags on SW startup. They're set in try/finally
// around multi-navigation ops, but a hard SW kill mid-op can't run finally and
// would leave them stuck true on disk — permanently suppressing the floating
// window (busy) or the ATC intercept (restoring). A fresh SW means no op is in
// flight, so resetting both is always safe. Fire-and-forget.
writeSettings({ busy: false, restoring: false }).catch(() => {});

// Hydrate the DEBUG flag from storage at SW startup, and keep it in sync
// when the user flips Settings → Developer mode in the popup. mc.dev.v1
// is the single source of truth for both the debug panel UI and verbose
// background logging.
chrome.storage.local.get(DEV_FLAG_KEY).then((r) => {
  DEBUG = r[DEV_FLAG_KEY] === true;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (Object.prototype.hasOwnProperty.call(changes, DEV_FLAG_KEY)) {
    DEBUG = changes[DEV_FLAG_KEY].newValue === true;
  }
});

// Capture uncaught service-worker errors into the diagnostic ring while
// Developer mode is on, so they surface in "Copy diagnostic logs" too.
self.addEventListener("error", (e) => {
  if (!DEBUG) return;
  pushLogEntry({ ctx: "sw", level: "error", msg: `uncaught: ${e && e.message}` });
});
self.addEventListener("unhandledrejection", (e) => {
  if (!DEBUG) return;
  const reason = e && e.reason;
  pushLogEntry({
    ctx: "sw",
    level: "error",
    msg: `unhandledrejection: ${(reason && reason.message) || reason}`,
  });
});

// Immediate flip when the user completes checkout — ExtPay fires onPaid
// when paidAt transitions from null to set. Re-sync to populate the rest
// of the entitlement record consistently.
if (extpay) {
  extpay.onPaid.addListener(() => {
    dinfo("[Styx Multi-Cart] ExtPay onPaid fired; refreshing entitlement.");
    syncEntitlementFromExtPay();
  });
}

function isPremiumActive(ent, nowMs = Date.now()) {
  if (!ent || ent.tier !== "premium") return false;
  if (ent.premiumUntil == null) return true;
  return nowMs < Number(ent.premiumUntil);
}

function cartLimitFor(ent, nowMs = Date.now()) {
  return isPremiumActive(ent, nowMs) ? PREMIUM_CART_LIMIT : FREE_CART_LIMIT;
}

function topNCartIdsByLastUsed(carts, n) {
  if (!Array.isArray(carts) || n <= 0) return [];
  const sorted = [...carts].sort((a, b) => {
    const lu = (Number(b.lastUsedAt) || 0) - (Number(a.lastUsedAt) || 0);
    if (lu !== 0) return lu;
    const sa = (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0);
    if (sa !== 0) return sa;
    return String(a.id).localeCompare(String(b.id));
  });
  return sorted.slice(0, n).map((c) => c.id);
}

function computeCartAccess(carts, ent, nowMs = Date.now()) {
  const limit = cartLimitFor(ent, nowMs);
  const editableIds = new Set(topNCartIdsByLastUsed(carts, limit));
  const readOnlyIds = new Set();
  for (const c of carts || []) {
    if (c && c.id && !editableIds.has(c.id)) readOnlyIds.add(c.id);
  }
  return { editableIds, readOnlyIds, limit };
}

function canCreateSavedCart(carts, ent, nowMs = Date.now()) {
  const current = Array.isArray(carts) ? carts.length : 0;
  const limit = cartLimitFor(ent, nowMs);
  const premium = isPremiumActive(ent, nowMs);
  if (current < limit) {
    return { allowed: true, current, limit, remaining: limit - current, tier: premium ? "premium" : "free" };
  }
  return {
    allowed: false,
    code: premium ? "PREMIUM_LIMIT_REACHED" : "FREE_LIMIT_REACHED",
    reason: premium
      ? `You've reached the maximum of ${limit} saved carts.`
      : `Free plan is limited to ${limit} saved carts. Upgrade to Premium for up to ${PREMIUM_CART_LIMIT}.`,
    current,
    limit,
    remaining: 0,
    tier: premium ? "premium" : "free",
  };
}

function canEditCart(cartId, carts, ent, nowMs = Date.now()) {
  const { editableIds } = computeCartAccess(carts, ent, nowMs);
  if (editableIds.has(cartId)) return { allowed: true };
  return {
    allowed: false,
    code: "CART_LOCKED",
    reason: isPremiumActive(ent, nowMs)
      ? "This cart exceeds your plan's limit."
      : "Renew Premium to edit this cart, or delete other carts to free up a slot.",
  };
}

// ---- Amazon-list tier access -------------------------------------------------
//
// The product treats Amazon lists as "carts". On the free tier only the first
// FREE_CART_LIMIT lists (Amazon order) are usable; the rest are locked (grayed
// in the UI, click → paywall). Every list counts toward the limit — Amazon does
// not auto-create any list for new accounts, so there are no default lists to
// exclude (the "Wish List" is just a user-created list like any other). Premium
// unlocks every list.
//
// `lists` are the {listId,name,url,count,kind} objects from listAmazonLists().
function computeListAccess(lists, ent, nowMs = Date.now()) {
  const premium = isPremiumActive(ent, nowMs);
  const limit = premium ? Infinity : FREE_CART_LIMIT;
  let seen = 0;
  const annotated = (Array.isArray(lists) ? lists : []).map((l) => {
    const kind = l && l.kind ? l.kind : "custom";
    seen += 1;
    return Object.assign({}, l, {
      kind,
      access: seen <= limit ? "editable" : "locked",
    });
  });
  return { lists: annotated, isPremium: premium, limit, customCount: seen };
}

// Snapshot of the last computed list access, keyed by listId. Lets the on-page
// wishlist button and the MC_WISHLIST_ADD_ALL gate check a list without paying
// for a fresh scrape. Refreshed by MC_LIST_AMAZON_LISTS / MC_GET_LIST_ACCESS.
let _lastListAccess = { byId: new Map(), at: 0 };
function rememberListAccess(annotatedLists) {
  const byId = new Map();
  for (const l of annotatedLists || []) {
    if (l && l.listId) byId.set(String(l.listId).toUpperCase(), l.access);
  }
  _lastListAccess = { byId, at: Date.now() };
}

/**
 * Bump lastUsedAt on a cart. Pass a pre-read carts array if you already have
 * one (avoids a redundant read). Returns true if the cart existed.
 */
async function touchCartLastUsed(cartId, nowMs = Date.now(), carts = null) {
  const list = carts || (await readCarts());
  const target = list.find((c) => c && c.id === cartId);
  if (!target) return false;
  target.lastUsedAt = nowMs;
  await writeCarts(list);
  return true;
}

async function readSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = result[SETTINGS_KEY];
  return Object.assign({}, DEFAULT_SETTINGS, stored && typeof stored === "object" ? stored : {});
}

async function writeSettings(patch) {
  const current = await readSettings();
  const next = Object.assign({}, current, patch || {});
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

function makeId() {
  return (
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8)
  );
}

// ---- Upsell choice memory (24 h TTL) --------------------------------------
//
// When the user adds an item to their cart normally and Amazon shows a
// protection-plan / warranty / coverage upsell, observer.js records what they
// chose. We replay that same choice during cart restore for 24 hours, after
// which the entry expires and the user is prompted manually again.

const UPSELL_CHOICES_KEY = "mc.upsell.choices.v1";
const UPSELL_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_ATC_TTL_MS = 5 * 60 * 1000;

// In-memory: pending ATC clicks waiting to be linked to an upsell choice
// when the same tab arrives at an attach page. Map<tabId, {asin,title,host,at}>.
const _pendingAtc = new Map();

function prunePendingAtc() {
  const now = Date.now();
  for (const [tabId, p] of _pendingAtc) {
    if (now - p.at > PENDING_ATC_TTL_MS) _pendingAtc.delete(tabId);
  }
}

function pruneUpsellChoices(map) {
  const now = Date.now();
  const out = {};
  for (const [asin, entry] of Object.entries(map || {})) {
    if (entry && entry.recordedAt && now - entry.recordedAt < UPSELL_TTL_MS) {
      out[asin] = entry;
    }
  }
  return out;
}

async function getUpsellChoices() {
  const obj = await chrome.storage.local.get(UPSELL_CHOICES_KEY);
  const map = obj[UPSELL_CHOICES_KEY] || {};
  // Prune-on-read so expired entries never get returned even if cleanup lagged.
  const pruned = pruneUpsellChoices(map);
  // Write back if anything was pruned so storage doesn't accumulate forever.
  if (Object.keys(pruned).length !== Object.keys(map).length) {
    await chrome.storage.local.set({ [UPSELL_CHOICES_KEY]: pruned });
  }
  return pruned;
}

async function recordUpsellChoice(asin, entry) {
  if (!asin) return;
  const map = await getUpsellChoices(); // already pruned
  map[asin] = { ...entry, recordedAt: Date.now() };
  await chrome.storage.local.set({ [UPSELL_CHOICES_KEY]: map });
}

async function getRecordedUpsellChoice(asin) {
  if (!asin) return null;
  const map = await getUpsellChoices();
  return map[asin] || null;
}

/**
 * Inject a script into a tab that finds the upsell control matching a
 * previously recorded choice and clicks it. Returns true only if a
 * confident match was clicked. False means the caller should fall back
 * to the manual prompt.
 */
async function applyUpsellChoice(tabId, recorded) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageApplyUpsellChoice,
      args: [recorded],
    });
    const r = result && result[0] && result[0].result;
    return Boolean(r && r.ok);
  } catch (_e) {
    return false;
  }
}

/**
 * Runs in the upsell page's context. Finds and clicks the option matching
 * the recorded choice (decline -> "no thanks" button; accept -> the radio
 * matching label+duration+price, then the continue button). Returns
 * { ok: bool, error?, choice? }. Self-contained: no closures, no imports.
 */
function pageApplyUpsellChoice(recorded) {
  return new Promise((resolve) => {
    function isVisible(el) {
      if (!el || !el.isConnected) return false;
      if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function findDeclineControl() {
      const sels = [
        "input[name='submit.attach-warranty-handler-no-warranty']",
        "input[name='submit.attach-sidesheet-no-coverage']",
        "input[name='submit.add-to-cart-no-warranty']",
        "input[name='submit.no-thanks']",
        "input[type='radio']#attachSiNoCoverage",
        "input[type='radio']#siNoCoverage",
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && isVisible(el)) return el;
      }
      // Fallback: any visible button labeled "No thanks" / "No coverage".
      const candidates = document.querySelectorAll(
        "input[type='submit'], input[type='button'], button, a"
      );
      for (const b of candidates) {
        const t = (b.value || b.textContent || b.getAttribute("aria-label") || "")
          .toLowerCase()
          .trim();
        if (
          (t === "no thanks" ||
            t === "no, thanks" ||
            t === "no coverage" ||
            t === "skip" ||
            t === "skip protection") &&
          isVisible(b)
        ) {
          return b;
        }
      }
      return null;
    }

    function findAcceptRadio(recorded) {
      const radios = Array.from(
        document.querySelectorAll(
          "input[type='radio'][name='attachSiCoverageName'], " +
            "input[type='radio'][name*='coverage' i], " +
            "input[type='radio'][name*='warranty' i], " +
            "input[type='radio'][name*='protection' i]"
        )
      ).filter(isVisible);
      if (!radios.length) return null;

      function scoreRadio(radio) {
        const container =
          radio.closest(
            "[data-coverage-option], .a-row, .a-section, label, li"
          ) || radio.parentElement;
        if (!container) return -1;
        const text = (container.innerText || container.textContent || "")
          .trim()
          .toLowerCase();
        let score = 0;

        // Label token overlap (worth up to 50 pts).
        if (recorded.optionLabel) {
          const recTokens = recorded.optionLabel
            .toLowerCase()
            .split(/\s+/)
            .filter((t) => t.length > 2);
          if (recTokens.length) {
            const matches = recTokens.filter((t) => text.includes(t)).length;
            score += (matches / recTokens.length) * 50;
          }
        }

        // Price match (up to 30 pts, with tolerance).
        if (recorded.optionPrice) {
          const recPrice = parseFloat(
            String(recorded.optionPrice).replace(/[^\d.]/g, "")
          );
          const txtPriceMatch = text.match(/\$\s?(\d+(?:\.\d{2})?)/);
          if (txtPriceMatch && !Number.isNaN(recPrice)) {
            const txtPrice = parseFloat(txtPriceMatch[1]);
            const diff = Math.abs(recPrice - txtPrice);
            if (diff < 0.01) score += 30;
            else if (diff < 1) score += 22;
            else if (diff < 3) score += 8;
          }
        }

        // Duration match (up to 30 pts).
        if (recorded.optionDuration) {
          const durMatch = text.match(/(\d+)\s*[-\s]?(year|yr|month|mo)\b/i);
          if (durMatch) {
            const n = parseInt(durMatch[1], 10);
            const dur = /year|yr/i.test(durMatch[0]) ? n * 12 : n;
            if (dur === recorded.optionDuration) score += 30;
            else if (Math.abs(dur - recorded.optionDuration) <= 2) score += 10;
          }
        }
        return score;
      }

      const scored = radios.map((r) => ({ radio: r, score: scoreRadio(r) }));
      scored.sort((a, b) => b.score - a.score);
      // Require a confident match — 50/100 minimum. Otherwise fall back.
      if (scored[0] && scored[0].score >= 50) return scored[0].radio;
      return null;
    }

    function findContinueControl() {
      const sels = [
        "input[type='submit'][name*='attach' i]",
        "input[type='submit'][name*='continue' i]",
        "input[type='submit'][value*='Continue' i]",
        "input[type='submit'][value*='Add to' i]",
        "button[name*='attach' i]",
        "button[name*='continue' i]",
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && isVisible(el)) return el;
      }
      const candidates = document.querySelectorAll(
        "input[type='submit'], button[type='submit'], button"
      );
      for (const b of candidates) {
        const t = (b.value || b.textContent || "").toLowerCase().trim();
        if (
          (t.includes("continue") ||
            t.includes("add to cart") ||
            t.includes("proceed")) &&
          isVisible(b)
        ) {
          return b;
        }
      }
      return null;
    }

    try {
      if (!recorded || !recorded.choice) {
        resolve({ ok: false, error: "no recorded choice" });
        return;
      }

      if (recorded.choice === "declined") {
        const btn = findDeclineControl();
        if (!btn) {
          resolve({ ok: false, error: "decline control not found" });
          return;
        }
        try { btn.click(); } catch (e) {
          resolve({ ok: false, error: "click threw: " + String(e) });
          return;
        }
        resolve({ ok: true, choice: "declined" });
        return;
      }

      if (recorded.choice === "accepted") {
        const radio = findAcceptRadio(recorded);
        if (!radio) {
          resolve({ ok: false, error: "no confident coverage option match" });
          return;
        }
        try {
          radio.click();
          if (!radio.checked) radio.checked = true;
          radio.dispatchEvent(new Event("change", { bubbles: true }));
        } catch (e) {
          resolve({ ok: false, error: "radio click threw: " + String(e) });
          return;
        }
        // Brief pause so the page can react (some pages enable Continue async).
        setTimeout(() => {
          const cont = findContinueControl();
          if (!cont) {
            resolve({ ok: false, error: "continue control not found" });
            return;
          }
          try { cont.click(); } catch (e) {
            resolve({ ok: false, error: "continue click threw: " + String(e) });
            return;
          }
          resolve({ ok: true, choice: "accepted", matched: recorded.optionLabel || "" });
        }, 700);
        return;
      }

      resolve({ ok: false, error: "unknown choice type: " + recorded.choice });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message) || String(e) });
    }
  });
}

// ---- Live operation status ------------------------------------------------
//
// A small popup window (status.html) polls MC_GET_STATUS every 350 ms to
// display what the extension is doing during long background operations.
// The window opens automatically at the start of each operation and closes
// itself once the operation finishes.

let _opStatus = null;        // { active, title, detail } | null
let _statusWindowId = null;  // chrome.windows id of the status popup

// NOTE: IS_SAFARI is defined near the top of the file (needed earlier for the
// payment-source branch). Safari ignores chrome.windows.create's type:"popup"
// and opens a full-size blank window that never renders status.html (so it
// never self-closes), leaking one untitled window per operation. The on-page
// toast carries the same progress there, so the status window is Chrome-only.

/** Set the current in-progress status shown in the status window. */
function setOpStatus(title, detail = "") {
  _opStatus = { active: true, title, detail };
}

/**
 * Mark the operation done. The status window will show a green check +
 * doneTitle for 3.5 s, then close itself. _opStatus is nulled after that.
 */
function clearOpStatus(doneTitle = "Done") {
  _opStatus = { active: false, title: doneTitle, detail: "" };
  setTimeout(() => {
    // Only null it out if it hasn't been replaced by a new operation.
    if (_opStatus && !_opStatus.active) _opStatus = null;
  }, 5000);
}

/**
 * Toggle the persisted `busy` flag that tells observer.js to stop auto-
 * reopening the floating window while a multi-navigation operation runs (so
 * the popup doesn't rebuild and re-hit the lists API on every page load).
 * Fire-and-forget writes; callers pair setUiBusy(true) with a finally
 * setUiBusy(false). Cheap enough to call directly. See DEFAULT_SETTINGS.busy.
 */
async function setUiBusy(on) {
  try {
    await writeSettings({ busy: !!on });
  } catch (_e) { /* settings write failed — non-fatal */ }
}

/**
 * Fire-and-forget message to a specific tab's content script. Used to drive
 * the on-page Styx toast during long list-save operations. Swallows errors
 * (tab closed / navigated / no listener) — progress UI is best-effort.
 */
function notifyTab(tabId, payload) {
  if (tabId == null) return;
  try {
    chrome.tabs.sendMessage(tabId, payload, () => void chrome.runtime.lastError);
  } catch (_e) { /* tab gone — non-fatal */ }
}

/** Open (or focus) the floating status window. Non-blocking — call without await. */
async function openStatusWindow() {
  if (IS_SAFARI) return;
  // If the window is still open, just bring it to front.
  if (_statusWindowId !== null) {
    try {
      await chrome.windows.update(_statusWindowId, { focused: true });
      return;
    } catch (_e) {
      _statusWindowId = null; // window was closed by the user
    }
  }
  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL("status.html"),
      type: "popup",
      width: 400,
      height: 190,
      focused: false, // don't steal focus from the Amazon tab
    });
    _statusWindowId = win.id;
    // Null out the id when the user manually closes the window.
    const onRemoved = (wid) => {
      if (wid === _statusWindowId) {
        _statusWindowId = null;
        chrome.windows.onRemoved.removeListener(onRemoved);
      }
    };
    chrome.windows.onRemoved.addListener(onRemoved);
  } catch (_e) {
    _statusWindowId = null;
  }
}

// ---- Tab helpers ----------------------------------------------------------

// Chrome's match-pattern syntax accepts a leading `*.` host wildcard but not
// `amazon.*` — we have to list every TLD we care about explicitly.
const AMAZON_TLDS = [
  "amazon.com",
  "amazon.co.uk",
  "amazon.ca",
  "amazon.com.au",
  "amazon.de",
  "amazon.fr",
  "amazon.it",
  "amazon.es",
  "amazon.co.jp",
  "amazon.in",
  "amazon.com.mx",
  "amazon.com.br",
];

const AMAZON_CART_PATTERNS = AMAZON_TLDS.flatMap((tld) => [
  `*://*.${tld}/gp/cart/*`,
  `*://*.${tld}/gp/cart*`,
  `*://*.${tld}/cart/*`,
  `*://*.${tld}/cart*`,
  `*://${tld}/gp/cart/*`,
  `*://${tld}/gp/cart*`,
  `*://${tld}/cart/*`,
  `*://${tld}/cart*`,
]);

function getUrlHost(url) {
  try {
    return new URL(url).hostname;
  } catch (_e) {
    return "";
  }
}

function normalizeAmazonHost(host) {
  return String(host || "www.amazon.com")
    .toLowerCase()
    .replace(/^www\./, "");
}

function sameAmazonHost(a, b) {
  return normalizeAmazonHost(a) === normalizeAmazonHost(b);
}

function isAmazonCartUrl(url) {
  return /amazon\.[a-z.]+\/(gp\/)?cart(?:[/?#]|$)/i.test(url || "");
}

function isAmazonUrl(url) {
  return /(^|\.)amazon\.[a-z.]+\//i.test(url || "");
}

// Amazon wish-list helpers. Mirrored from lib/helpers.js — keep in sync.
function parseAmazonListId(href) {
  if (!href) return null;
  const s = String(href);
  const m =
    s.match(/\/hz\/wishlist\/ls\/([A-Z0-9]+)/i) ||
    s.match(/\/gp\/registry\/wishlist\/([A-Z0-9]+)/i) ||
    s.match(/[?&]listId=([A-Z0-9]+)/i);
  return m ? m[1] : null;
}

function amazonListUrl(host, listId) {
  const h = normalizeAmazonHost(host);
  const full = h.startsWith("amazon.") ? `www.${h}` : h;
  return `https://${full}/hz/wishlist/ls/${listId}`;
}

async function inferAmazonHost() {
  const [active] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (active && active.url && isAmazonUrl(active.url)) {
    return getUrlHost(active.url);
  }

  const cartTabs = await chrome.tabs.query({ url: AMAZON_CART_PATTERNS });
  if (cartTabs.length) {
    return getUrlHost(cartTabs[0].url);
  }

  return "www.amazon.com";
}

async function getActiveAmazonTab(preferredHost) {
  const [active] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!active || !active.url || !isAmazonUrl(active.url)) return null;
  if (preferredHost && !sameAmazonHost(getUrlHost(active.url), preferredHost)) {
    return null;
  }
  return active;
}

async function findAmazonCartTab(preferredHost) {
  const matchesPreferredHost = (tab) =>
    !preferredHost || sameAmazonHost(getUrlHost(tab.url), preferredHost);

  const [active] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (active && isAmazonCartUrl(active.url) && matchesPreferredHost(active)) {
    return active;
  }

  const cartTabs = await chrome.tabs.query({ url: AMAZON_CART_PATTERNS });
  if (preferredHost) {
    const matchingTab = cartTabs.find(matchesPreferredHost);
    if (matchingTab) return matchingTab;
  } else if (cartTabs.length) {
    return cartTabs[0];
  }

  // Open one.
  const host = preferredHost || "www.amazon.com";
  const tab = await chrome.tabs.create({
    url: `https://${host}/gp/cart/view.html`,
    active: true,
  });
  await waitForTabComplete(tab.id);
  try {
    return await chrome.tabs.get(tab.id);
  } catch (_e) {
    return tab;
  }
}

/**
 * Scrape the Amazon cart without navigating the user's active tab.
 *
 * Opens /gp/cart/view.html in a background tab (active: false so the user
 * stays on whatever page they're on), waits for a full load cycle with
 * waitForTabReload (never resolves prematurely on about:blank), gives
 * content.js 600 ms to register its message listener, scrapes, then
 * immediately closes the temporary tab.
 *
 * Returns the scraped cart object, or throws on failure.
 */
/**
 * Scrape the Amazon cart without navigating the user's active tab.
 *
 * Uses chrome.scripting.executeScript with the self-contained pageScrapeCart
 * function — no dependency on content.js being loaded or its message listener
 * being registered. This eliminates the race condition that caused:
 * "Cannot access contents of the page. Extension manifest must request
 * permission to access the respective host."
 *
 * Strategy:
 *   1. If the active tab or an already-open tab IS the cart → scrape directly.
 *   2. Otherwise open /gp/cart/view.html as active:false (background tab),
 *      wait for a full load cycle, scrape, then close the temp tab.
 */
async function scrapeCartInBackground(preferredHost) {
  const host = preferredHost || (await inferAmazonHost());
  const cartUrl = `https://${host}/gp/cart/view.html`;

  async function runScrape(tabId) {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageScrapeCart,
    });
    const cart = result && result[0] && result[0].result;
    if (!cart) {
      throw new Error("pageScrapeCart returned nothing.");
    }
    if (cart.error) {
      throw new Error(cart.error);
    }
    return cart;
  }

  /**
   * A scrape result is "trustworthy" only if either we found items OR the
   * page itself agrees the cart is empty (nav cart count == 0). If items
   * is empty but nav count says there ARE items, the page is either still
   * hydrating or isn't the real cart — caller should try a different tab.
   */
  function isTrustworthy(cart) {
    if (cart.items && cart.items.length > 0) return true;
    if (cart.navCartCount === 0) return true;
    return false;
  }

  // Fast path: already on the cart page.
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && isAmazonCartUrl(active.url) && sameAmazonHost(getUrlHost(active.url), host)) {
    const cart = await runScrape(active.id);
    if (isTrustworthy(cart)) return cart;
    // Active cart tab returned 0 but nav says items exist — fall through to fresh tab.
  }

  // Reuse an existing cart tab if one is open. Filter through isAmazonCartUrl
  // (regex-based, stricter than match patterns) so we don't grab tabs at URLs
  // like /cart-purchase-conditions/ that match the broad chrome.tabs.query glob.
  const existingCartTabs = await chrome.tabs.query({ url: AMAZON_CART_PATTERNS });
  const realCartTabs = existingCartTabs.filter((t) => isAmazonCartUrl(t.url));
  const existingMatch = realCartTabs.find((t) => sameAmazonHost(getUrlHost(t.url), host));
  if (existingMatch) {
    try {
      const cart = await runScrape(existingMatch.id);
      if (isTrustworthy(cart)) return cart;
      // Existing cart tab returned 0 but nav says items exist — it may be stale
      // or showing a non-cart state. Fall through to opening a fresh tab.
    } catch (_e) {
      // Existing tab failed (e.g. navigated away) — open a fresh one below.
    }
  }

  // Open a silent background tab, wait for it to fully load, scrape, close.
  // If the first scrape comes back empty but nav-cart-count indicates items,
  // wait a bit more (cart contents may be hydrating via XHR) and retry once.
  const tempTab = await chrome.tabs.create({ url: cartUrl, active: false });
  try {
    await waitForTabReload(tempTab.id, 20000);
    let cart = await runScrape(tempTab.id);
    if (!isTrustworthy(cart)) {
      // Give Amazon another 2.5 s to finish hydrating the cart panel, then retry.
      await sleep(2500);
      cart = await runScrape(tempTab.id);
    }
    return cart;
  } finally {
    try { await chrome.tabs.remove(tempTab.id); } catch (_e) { /* already closed */ }
  }
}

/**
 * Clear all active items from the Amazon cart.
 *
 * @param {string}  [preferredHost]        - Amazon host (e.g. "www.amazon.com").
 * @param {object}  [options]
 * @param {boolean} [options.returnToOrigin=false]
 *   When true, navigate the tab back to wherever the user was before the
 *   clear started (e.g. the product page they were on when they clicked
 *   "Clear Amazon Cart"). Has no effect when the user was already on the cart page.
 * @param {string}  [options.originUrl]
 *   Pre-captured return URL. If omitted and returnToOrigin is true, the
 *   function queries the active tab itself.
 */
async function clearAmazonCart(preferredHost, options = {}) {
  // Clearing deletes items one by one, reloading the cart page each time. Hold
  // the `busy` flag across the whole run so observer.js doesn't auto-reopen the
  // floating window (and re-hit the lists API) on every reload. finally clears
  // it even on early-return/throw.
  await setUiBusy(true);
  try {
    return await clearAmazonCartImpl(preferredHost, options);
  } finally {
    await setUiBusy(false);
  }
}

async function clearAmazonCartImpl(preferredHost, options = {}) {
  const { returnToOrigin = false, originUrl: providedOriginUrl = null } = options;
  const host = preferredHost || (await inferAmazonHost());
  const cartUrl = `https://${host}/gp/cart/view.html`;

  const currentCount = await getActiveAmazonCartCount(host);
  if (currentCount === 0) {
    return { ok: true, removed: 0, remaining: 0, alreadyEmpty: true };
  }
  // Used in progress messages; may be null if we couldn't count remotely.
  const totalToRemove = (typeof currentCount === 'number' && currentCount > 0) ? currentCount : null;

  // Always drive the full cart page. Prefer the active Amazon tab so the user
  // sees the navigation; otherwise find or open a dedicated cart tab.
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  let tabId;

  // Capture the page to return to BEFORE navigating away from it.
  // Only meaningful when the user is on a non-cart Amazon page.
  let originUrl = providedOriginUrl;
  if (!originUrl && returnToOrigin && active && active.url &&
      isAmazonUrl(active.url) && !isAmazonCartUrl(active.url)) {
    originUrl = active.url;
  }

  if (active && active.url && isAmazonUrl(active.url)) {
    tabId = active.id;
    if (!isAmazonCartUrl(active.url) || !sameAmazonHost(getUrlHost(active.url), host)) {
      await navigateTabAndWait(tabId, cartUrl);
    }
  } else {
    const cartTabs = await chrome.tabs.query({ url: AMAZON_CART_PATTERNS });
    const match = cartTabs.find((t) => sameAmazonHost(getUrlHost(t.url), host));
    if (match) {
      tabId = match.id;
      await chrome.tabs.update(tabId, { active: true });
      await waitForTabComplete(tabId);
    } else {
      const newTab = await chrome.tabs.create({ url: cartUrl, active: true });
      await waitForTabComplete(newTab.id);
      tabId = newTab.id;
    }
  }

  // Delete items one at a time using MC_CLEAR_ONE. Amazon often submits a real
  // form POST, but Safari can also complete the delete via in-page DOM/XHR.
  // MC_CLEAR_ONE responds BEFORE activating the control, then we wait for
  // either a reload or a verified cart-count drop before continuing.
  let removed = 0;
  let lastKnownCount = Number.isFinite(currentCount) ? currentCount : null;
  let sawEmpty = false;
  let stalledDeletes = 0;

  // Show initial status on the cart tab and in the status window.
  setOpStatus("Clearing cart");
  await showStatus(tabId, 'Clearing cart…', 'loading');

  for (let attempt = 0; attempt < 50; attempt++) {
    let result;
    try {
      result = await sendToContent(tabId, { type: "MC_CLEAR_ONE" });
    } catch (_err) {
      // Message port closed before response — page navigated unexpectedly.
      // Wait for the tab to settle and try again.
      await waitForTabReload(tabId, 15000);
      const after = await getAmazonCartCountDetailedFromTab(tabId);
      if (after) {
        if (after.count === 0) {
          // Zero means empty no matter which signal produced it.
          sawEmpty = true;
          lastKnownCount = 0;
          break;
        }
        // Only row readings update the row-based bookkeeping — the quantity
        // badge counts units, not rows, and the two diverge on
        // multi-quantity items.
        if (after.source === "rows") {
          if (Number.isFinite(lastKnownCount) && after.count < lastKnownCount) {
            removed += lastKnownCount - after.count;
          }
          lastKnownCount = after.count;
        }
      }
      // Re-show status after page reload (the old toast was destroyed).
      const retryMsg = totalToRemove
        ? `Removed ${removed} of ${totalToRemove}…`
        : `${removed} removed so far…`;
      setOpStatus("Clearing cart", retryMsg);
      await showStatus(tabId, totalToRemove
        ? `Clearing cart — removed ${removed} of ${totalToRemove}…`
        : `Clearing cart — ${removed} removed so far…`, 'loading');
      continue;
    }

    if (!result) break;
    if (result.empty) {
      // Trust the content script's direct observation of an empty cart over a
      // stale cached count — the final injection check below can fail on
      // Safari, and a stale lastKnownCount would then report a false failure.
      const contentRemaining = Number.isFinite(result.remaining) ? result.remaining : null;
      if (
        (contentRemaining === 0 && result.sawCartSurface) ||
        !Number.isFinite(lastKnownCount) ||
        lastKnownCount === 0
      ) {
        sawEmpty = true;
        lastKnownCount = 0;
      } else if (contentRemaining != null) {
        // Content saw no rows but its quantity fallback still reports items;
        // leave the verdict to the final verification below.
        lastKnownCount = contentRemaining;
      }
      break;
    }
    if (!result.ok) break;     // unrecoverable error

    // Pre-delete baselines in both units. rowCount comes straight from the
    // rows the content script saw; quantityCount is the nav-badge reading,
    // which sums per-item quantities. The settle watcher compares each unit
    // only against its own baseline.
    const beforeRows = Number.isFinite(result.rowCount)
      ? result.rowCount
      : lastKnownCount;
    const beforeQuantity = Number.isFinite(result.quantityCount)
      ? result.quantityCount
      : null;
    const settled = await waitForCartSettleAfterDelete(
      tabId,
      { rows: beforeRows, quantity: beforeQuantity },
      15000
    );

    const step = evaluateClearStep({ settled, beforeRows, beforeQuantity, stalledDeletes });
    if (step.action === "stuck") break;
    if (step.action === "retry") {
      // Amazon sometimes swallows the first activation (e.g. EWC mid-update
      // spinner) — retry the same row once before treating the cart as stuck.
      stalledDeletes++;
      continue;
    }
    removed += step.removedDelta;
    if (step.action === "progress") {
      stalledDeletes = 0;
      if (step.lastKnownRows != null) lastKnownCount = step.lastKnownRows;
      if (step.empty) {
        sawEmpty = true;
        lastKnownCount = 0;
        break;
      }
    }

    await sleep(300);
    // Re-show status on the freshly-loaded page (previous toast was destroyed).
    const progressMsg = totalToRemove
      ? `Removed ${removed} of ${totalToRemove}…`
      : `${removed} removed so far…`;
    setOpStatus("Clearing cart", progressMsg);
    await showStatus(tabId, totalToRemove
      ? `Clearing cart — removed ${removed} of ${totalToRemove}…`
      : `Clearing cart — ${removed} removed so far…`, 'loading');
  }

  // Final verification. A rows-sourced reading is authoritative; a
  // quantity-sourced one is the nav badge, which lags behind delete POSTs —
  // it must not override the loop's own evidence that the cart emptied.
  const verified = await getAmazonCartCountDetailedFromTab(tabId);
  const remaining =
    verified && (verified.source === "rows" || verified.count === 0)
      ? verified.count
      : sawEmpty
        ? 0
        : verified
          ? verified.count
          : Number.isFinite(lastKnownCount)
            ? lastKnownCount
            : null;
  if (Number.isFinite(remaining) && remaining > 0) {
    const errorMsg = `Could not clear cart — ${remaining} item${remaining === 1 ? '' : 's'} still in cart`;
    clearOpStatus(errorMsg);
    await showStatus(tabId, errorMsg, 'error');
    return { ok: false, removed, remaining, sawCartSurface: true };
  }

  // Show completion state.
  const doneMsg = `Cart cleared — ${removed} item${removed === 1 ? '' : 's'} removed`;
  clearOpStatus(doneMsg);
  await showStatus(tabId, doneMsg, 'done');

  // Return the user to where they were before the clear started.
  if (returnToOrigin && originUrl && tabId) {
    // Pause briefly so they see the "done" flash, then navigate back.
    await sleep(1200);
    try {
      await chrome.tabs.update(tabId, { url: originUrl, active: true });
      await waitForTabReload(tabId, 15000);
      // Show the same done message on the page they're returned to.
      await showStatus(tabId, doneMsg, 'done');
    } catch (_e) { /* tab may have been closed */ }
  }

  return { ok: true, removed, remaining: 0, sawCartSurface: true };
}

async function getActiveAmazonCartCount(preferredHost) {
  const active = await getActiveAmazonTab(preferredHost);
  if (!active) return null;

  return getAmazonCartCountFromTab(active.id);
}

async function getAmazonCartCountDetailedFromTab(tabId) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageGetCartCountDetailed,
    });
    const value = result && result[0] && result[0].result;
    if (value && Number.isFinite(value.count)) return value;
    return null;
  } catch (_e) {
    return null;
  }
}

async function getAmazonCartCountFromTab(tabId) {
  const detailed = await getAmazonCartCountDetailedFromTab(tabId);
  return detailed ? detailed.count : null;
}

/**
 * Wait for the cart to settle after a delete: either a count drops against
 * its own pre-delete baseline, or a reload completes with the cart unchanged,
 * or we time out. `before` carries baselines in both units ({ rows,
 * quantity }); resolves { rows, quantity, changed } with the latest reading
 * observed in each unit.
 */
async function waitForCartSettleAfterDelete(tabId, before, timeoutMs = 15000) {
  const beforeRows = before && Number.isFinite(before.rows) ? before.rows : null;
  const beforeQuantity =
    before && Number.isFinite(before.quantity) ? before.quantity : null;
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let pollTimer = null;
    let polling = false;
    let latestRows = null;
    let latestQuantity = null;
    let sawLoading = false;
    let completedAfterLoading = false;

    const finish = (changed) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(pollTimer);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removedListener);
      resolve({ rows: latestRows, quantity: latestQuantity, changed });
    };

    // Single scheduler: always clears the pending timer before arming a new
    // one, so the listener and an in-flight poll can't fork parallel chains.
    const schedulePoll = (delay) => {
      if (done) return;
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, delay);
    };

    const poll = async () => {
      // If a poll is mid-await (executeScript can hang across a navigation),
      // skip — its tail call keeps the chain alive.
      if (done || polling) return;
      polling = true;
      try {
        const reading = await getAmazonCartCountDetailedFromTab(tabId);
        if (reading) {
          if (reading.source === "rows") latestRows = reading.count;
          else latestQuantity = reading.count;
          // Zero means empty no matter which signal produced it.
          if (reading.count === 0) {
            finish(true);
            return;
          }
          // Compare each unit only against its own baseline — rows count
          // line items, the nav badge counts quantity, and mid-reload the
          // badge renders before the rows do.
          if (
            (reading.source === "rows" &&
              beforeRows != null &&
              reading.count < beforeRows) ||
            (reading.source === "quantity" &&
              beforeQuantity != null &&
              reading.count < beforeQuantity)
          ) {
            finish(true);
            return;
          }
          // After a completed reload, a steady ROW reading means the delete
          // genuinely didn't land. A quantity reading proves nothing here:
          // the rows may simply not have rendered yet.
          if (completedAfterLoading && reading.source === "rows") {
            finish(false);
            return;
          }
        }
      } catch (_e) {
        // The page can be between unload/load here; keep polling until timeout.
      } finally {
        polling = false;
      }
      schedulePoll(350);
    };

    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "loading") sawLoading = true;
      if (info.status === "complete" && sawLoading) {
        completedAfterLoading = true;
        schedulePoll(500);
      }
    };

    const removedListener = (id) => {
      if (id === tabId) finish(false);
    };

    timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removedListener);
    schedulePoll(350);
  });
}

/**
 * Inject content.js into a tab if it isn't already there, then send a message.
 * Cart tabs always have content.js via manifest, but this is defensive — for
 * example if the user is on a cart subroute we didn't list, we can still work.
 */
async function sendToContent(tabId, message) {
  // Chrome rejects when the tab has no listener, but Safari RESOLVES with
  // undefined — e.g. when site access is "Ask", which blocks manifest
  // content scripts even though the popup's activeTab grant lets
  // executeScript work. Every content.js handler responds with an object,
  // so a falsy result means "nobody answered": fall through to injection.
  try {
    const result = await chrome.tabs.sendMessage(tabId, message);
    if (result !== undefined && result !== null) return result;
  } catch (_e) {
    // Content script not loaded yet — inject and retry.
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    const retry = await chrome.tabs.sendMessage(tabId, message);
    if (retry !== undefined && retry !== null) return retry;
  } catch (_e) {
    // Injection can fail on restricted pages; the bridge below still works
    // when an earlier injection (manifest or programmatic) is present.
  }
  // Safari never delivers tabs.sendMessage to content scripts injected via
  // scripting.executeScript({files}) — the listener registers, but the
  // message router ignores that world. executeScript({func}) DOES execute in
  // the same world, so call the bridge content.js exposes on window there.
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (m) => (window.__styxMcHandleMessage ? window.__styxMcHandleMessage(m) : null),
      args: [message],
    });
    const value = results && results[0] ? results[0].result : null;
    if (value !== undefined && value !== null) return value;
  } catch (_e) {
    // Fall through — callers treat undefined as "no content script".
  }
  return undefined;
}

// ---- Restore: batch endpoint + per-item fallback -------------------------

/**
 * Amazon's batch add endpoint (/gp/aws/cart/add.html) renders a single
 * "Add to Shopping Cart" confirmation page listing every ASIN in the
 * querystring, with one yellow "Add To Cart" button that commits all of
 * them at once. We use this as the fast path: one navigation, one click,
 * everything lands.
 *
 * Critical: the endpoint silently drops items unless an `AssociateTag`
 * is present in the URL. That's why earlier attempts concluded the page
 * was broken — they were hitting it without a tag and getting an empty
 * cart view with a "Go To Cart" link. With any tag value the page
 * renders correctly. We bake in a placeholder tag below; swap it for
 * your own Associates tag if you want affiliate credit on restores.
 *
 * Anything the batch endpoint misses (login redirect, captcha, dropped
 * items, page format change) falls through to restoreCart() — the
 * proven per-item engine, which also handles upsell pages, region
 * locks, and buy-box selection. That's strictly slower but reliable.
 */

// Associate tag baked into bulk-add URLs. The page won't render items
// without a tag (Amazon's anti-scraping). The value doesn't have to be
// a registered associate — any well-formed `xxxxxxxx-20` string works.
// Replace with your own tag to claim affiliate credit on restores.
const STYX_ASSOCIATE_TAG = "styxmcart-20";

/**
 * Build a bulk-add URL. The endpoint expects pairs of `ASIN.N` and
 * `Quantity.N` where N is 1-based. Caller is responsible for chunking
 * if the item list would blow the URL length limit.
 */
function buildBulkAddUrl(host, items, associateTag) {
  const params = new URLSearchParams();
  items.forEach((it, i) => {
    const n = i + 1;
    params.set(`ASIN.${n}`, String(it.asin).toUpperCase());
    const qty = Math.max(1, Math.min(99, Number(it.quantity) || 1));
    params.set(`Quantity.${n}`, String(qty));
  });
  if (associateTag) {
    params.set("tag", associateTag);
    params.set("AssociateTag", associateTag);
  }
  return `https://${host}/gp/aws/cart/add.html?${params.toString()}`;
}

function chunkItemsForBulk(items, size = 30) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Runs in the page context. Minimizes the floating Styx modal (observer.js)
 * down to its FAB so it can't cover the bulk-confirm "Add To Cart" button —
 * the modal restores its open state across navigations, so on the
 * /gp/aws/cart/add.html confirm page it would otherwise sit right on top of
 * the buybox we just highlighted. Element ids and the sessionStorage key
 * must match FAB_MODAL_ID / FAB_ID / FAB_OPEN_KEY in observer.js.
 */
function pageMinimizeFloatingUi() {
  const modal = document.getElementById("__styx-fab-modal");
  const fab = document.getElementById("__styx-fab");
  if (modal && !modal.hidden) {
    modal.hidden = true;
    if (fab) fab.hidden = false;
  }
  // Always clear the stored open flag: if this runs before observer.js has
  // initialized on the fresh page, clearing it prevents the modal from
  // re-opening itself a moment later.
  try { sessionStorage.setItem("styx.fab.open.v1", "0"); } catch (_e) { /* ignore */ }
}

/**
 * Runs in the page context. Locates the "Add To Cart" button on
 * /gp/aws/cart/add.html, scrolls it into view, and applies a pulsing
 * orange highlight so the user can find it at a glance. Does NOT click —
 * the user clicks themselves to confirm the bulk add (intentional human
 * checkpoint before items hit the live cart). Returns {ok:true} when the
 * button is found and decorated, {ok:false,error} if it never appears.
 *
 * The injected style and class are idempotent — calling this twice on
 * the same page (e.g. for a multi-chunk restore) is harmless.
 */
function pageHighlightBulkConfirm() {
  // NOTE: this function is INJECTED into the Amazon page via
  // chrome.scripting.executeScript. The page context has no access to the
  // service worker's scope, so service-worker helpers like dlog/dinfo/dwarn
  // are NOT defined here — calling one throws ReferenceError, which rejects
  // the wrapping Promise and bubbles up as a generic "highlight failed
  // (unknown)" in the caller, completely bypassing the selector loop. Use
  // raw console.log / console.warn inside this function.
  return new Promise((resolve) => {
    console.log("[Styx Multi-Cart] searching for bulk-confirm button…");

    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    // Tier 1: selector-based — fast path, covers Amazon's standard ATC
    // naming. Different surfaces use different conventions, so we cast wide.
    // /gp/aws/cart/add.html is a legacy surface and uses older naming than
    // modern PDPs, so the cart-form fallbacks below matter a lot.
    const SELECTORS = [
      // Modern PDP / newer surfaces
      "#add-to-cart-button",
      "input#add-to-cart-button",
      "input[name='submit.add-to-cart']",
      "input[name='submit.addToCart']",
      "input[name='submit.add-to-cart-button']",
      "button[name='submit.add-to-cart']",
      "input.a-button-input[aria-labelledby*='add-to-cart']",
      // Legacy bulk add page — these are the most likely hits on /gp/aws/cart/add.html
      "input[name='add']",
      "input[name='submit.add']",
      "form[action*='cart/add' i] input[type='submit']",
      "form[action*='cart/add' i] button[type='submit']",
      "form[action*='cart' i] input[type='submit']",
      "form[action*='cart' i] button[type='submit']",
      "form[action*='handle-buy-box' i] input[type='submit']",
      // Value-based — works even when name/id are unusual
      "input[type='submit'][value*='Add' i][value*='Cart' i]",
      "input.a-button-input[value*='Add' i][value*='Cart' i]",
    ];

    const labelsFor = (el) => {
      const labels = [
        el && el.value,
        el && el.textContent,
        el && el.getAttribute && el.getAttribute("aria-label"),
      ];
      try {
        const labelledBy = el && el.getAttribute && el.getAttribute("aria-labelledby");
        if (labelledBy) {
          for (const id of labelledBy.split(/\s+/)) {
            const labelEl = document.getElementById(id);
            if (labelEl) labels.push(labelEl.textContent);
          }
        }
        const wrap = el && el.closest && el.closest(".a-button");
        const visibleLabel = wrap && wrap.querySelector(".a-button-text");
        if (visibleLabel) labels.push(visibleLabel.textContent);
      } catch (_e) { /* use direct labels */ }
      return labels
        .filter(Boolean)
        .map((label) => String(label).trim().replace(/\s+/g, " ").toLowerCase());
    };

    const looksLikeAddToCart = (el) =>
      labelsFor(el).some(
        (label) =>
          label === "add to cart" ||
          label === "add to shopping cart" ||
          (label.startsWith("add") && label.includes("cart") && label.length < 40)
      );

    const looksLikeGoToCart = (el) =>
      labelsFor(el).some(
        (label) => label === "go to cart" || label === "view cart"
      );

    // The legacy endpoint also renders a yellow "Go To Cart" control when it
    // rejects every ASIN and has no products to submit. That is navigation,
    // not confirmation. Require evidence that at least one requested product
    // actually made it into the rendered bulk page before relabeling it.
    const hasRenderedBulkItems = () => {
      const requested = new Set();
      try {
        const params = new URLSearchParams(location.search || "");
        for (const [key, value] of params.entries()) {
          if (/^ASIN\.\d+$/i.test(key) && /^[A-Z0-9]{10}$/i.test(value || "")) {
            requested.add(String(value).toUpperCase());
          }
        }
      } catch (_e) { /* fall through to generic product evidence */ }

      const bodyText = (
        (document.body && (document.body.innerText || document.body.textContent)) || ""
      ).replace(/\s+/g, " ");
      if (/your (?:amazon )?cart is empty|your shopping cart is empty/i.test(bodyText)) {
        return false;
      }

      const candidates = document.querySelectorAll(
        "[data-asin], input[name^='ASIN.'], " +
          "a[href*='/dp/'], a[href*='/gp/product/'], a[href*='/gp/aw/d/']"
      );
      for (const el of candidates) {
        const values = [
          el.getAttribute && el.getAttribute("data-asin"),
          el.value,
          el.getAttribute && el.getAttribute("href"),
        ].filter(Boolean);
        for (const raw of values) {
          const text = String(raw).toUpperCase();
          if (requested.size) {
            for (const asin of requested) {
              if (text.includes(asin)) return true;
            }
          } else if (/\b[A-Z0-9]{10}\b/.test(text)) {
            return true;
          }
        }
      }
      return false;
    };

    // Tier 2: text-based fallback — find any visible <input type=submit>,
    // <button>, or Amazon's `.a-button-text` span whose label looks like
    // "Add to Cart" / "Add to Shopping Cart". Resolves the visible label
    // back to its clickable input via the wrapping `.a-button` when
    // needed (Amazon's button widget visually masks the actual <input>).
    const findByText = () => {
      const cands = document.querySelectorAll(
        "input[type='submit'], button, .a-button-text, span.a-button-text"
      );
      for (const el of cands) {
        if (!looksLikeAddToCart(el)) continue;

        // If the match is a label span, climb to the clickable input.
        let clickable = el;
        if (el.classList && el.classList.contains("a-button-text")) {
          const wrap = el.closest(".a-button");
          if (wrap) {
            const inp = wrap.querySelector("input, button");
            if (inp) clickable = inp;
          }
        }
        if (isVisible(clickable) || isVisible(el)) return clickable;
      }
      return null;
    };

    // The confirm page is ALWAYS /gp/aws/cart/add.html (buildBulkAddUrl). When
    // Amazon rejects every requested ASIN it redirects the bulk URL to the
    // regular cart page, which renders sponsored "Products related to items in
    // your cart" cards — each with a real "Add to cart" button. Highlighting
    // there would ring a random sponsored product (exactly the reported bug),
    // so the entire search is gated to the add page. Off it → treat as an
    // empty/rejected bulk result and let the caller fall back to per-item.
    const onAddPage = /\/gp\/aws\/cart\/add\.html/i.test(location.pathname || "");

    const findButton = () => {
      if (!onAddPage) return { emptyBulkPage: true };
      // On the add page but Amazon shows "cart is empty" / rendered none of the
      // requested ASINs → nothing legitimate to confirm; bail to per-item.
      if (!hasRenderedBulkItems()) return { emptyBulkPage: true };
      for (const sel of SELECTORS) {
        const matches = document.querySelectorAll(sel);
        for (const el of matches) {
          if (isVisible(el) && looksLikeAddToCart(el)) {
            console.log("[Styx Multi-Cart] confirm button matched selector:", sel);
            return el;
          }
        }
      }
      const byText = findByText();
      if (byText) {
        console.log("[Styx Multi-Cart] confirm button matched via text fallback");
        return byText;
      }
      // Amazon's current legacy bulk page labels the commit control "Go To
      // Cart" even though clicking it is what submits the listed ASINs. Only
      // accept that wording on the bulk-add endpoint; elsewhere it is merely
      // navigation and must not be treated as confirmation.
      if (/\/gp\/aws\/cart\/add\.html/i.test(location.pathname || "")) {
        const goToCart = findGoToCartButton();
        if (goToCart) {
          if (!hasRenderedBulkItems()) {
            console.warn(
              "[Styx Multi-Cart] Go To Cart found, but Amazon rendered no requested products"
            );
            return { emptyBulkPage: true };
          }
          console.log("[Styx Multi-Cart] bulk confirm matched Go To Cart variant");
          return { button: goToCart };
        }
      }
      return null;
    };

    const findGoToCartButton = () => {
      const cands = document.querySelectorAll(
        "input[type='submit'], button, a, .a-button-text, span.a-button-text"
      );
      for (const el of cands) {
        if (!looksLikeGoToCart(el)) continue;
        let clickable = el;
        if (el.classList && el.classList.contains("a-button-text")) {
          const wrap = el.closest(".a-button");
          const inp = wrap && wrap.querySelector("input, button, a");
          if (inp) clickable = inp;
        }
        if (isVisible(clickable) || isVisible(el)) return clickable;
      }
      return null;
    };

    const relabelGoToCart = (btn) => {
      const replacement = "Add All to Amazon Cart";
      try {
        const wrap = btn.closest && btn.closest(".a-button");
        const visibleLabel =
          (btn.classList && btn.classList.contains("a-button-text") && btn) ||
          (wrap && wrap.querySelector(".a-button-text"));
        if (visibleLabel) {
          visibleLabel.textContent = replacement;
        } else if (btn.tagName === "BUTTON" || btn.tagName === "A") {
          btn.textContent = replacement;
        }
        // Preserve an input's value: some legacy forms include it in the POST.
        // aria-label updates the accessible name without altering form data.
        btn.setAttribute("aria-label", replacement);
      } catch (_e) { /* highlighting still works if relabeling fails */ }
    };

    // Highlight via an overlay <div> positioned on top of the button. Bypasses
    // Amazon's CSS entirely (their button styles often include
    // `outline:none !important` which would eat any class-based outline).
    // The overlay tracks the button on scroll/resize.
    const applyOverlayRing = (btn) => {
      // Pick the visible target: if the matched element is an opacity-0
      // <input> mask, the .a-button wrapper is what the user actually sees.
      let target = btn;
      try {
        const op = parseFloat(getComputedStyle(btn).opacity || "1");
        if (op < 0.1) {
          const wrap = btn.closest(".a-button") || btn.parentElement;
          if (wrap) target = wrap;
        }
      } catch (_e) { /* fall through */ }

      if (!document.getElementById("__styx-bulk-ring-style")) {
        const s = document.createElement("style");
        s.id = "__styx-bulk-ring-style";
        s.textContent =
          "@keyframes __styxBulkRingPulse{" +
            "0%,100%{box-shadow:0 0 0 0 rgba(255,153,0,.95),0 0 24px 4px rgba(255,153,0,.4);transform:scale(1)}" +
            "50%{box-shadow:0 0 0 18px rgba(255,153,0,0),0 0 40px 12px rgba(255,153,0,.6);transform:scale(1.03)}" +
          "}" +
          ".__styx-bulk-ring{" +
            "position:fixed!important;pointer-events:none!important;" +
            "border:3px solid #ff9900!important;border-radius:10px!important;" +
            "background:transparent!important;" +
            "z-index:2147483645!important;" +
            "animation:__styxBulkRingPulse 1.2s ease-in-out infinite!important;" +
            "transform-origin:center!important;" +
          "}";
        document.head.appendChild(s);
      }

      const existing = document.getElementById("__styx-bulk-ring");
      if (existing) existing.remove();

      const ring = document.createElement("div");
      ring.id = "__styx-bulk-ring";
      ring.className = "__styx-bulk-ring";
      document.body.appendChild(ring);

      const reposition = () => {
        if (!target.isConnected) return;
        const r = target.getBoundingClientRect();
        ring.style.top = (r.top - 6) + "px";
        ring.style.left = (r.left - 6) + "px";
        ring.style.width = (r.width + 12) + "px";
        ring.style.height = (r.height + 12) + "px";
      };
      reposition();
      window.addEventListener("scroll", reposition, true);
      window.addEventListener("resize", reposition);

      try { target.scrollIntoView({ behavior: "smooth", block: "center" }); }
      catch (_e) { /* older browsers */ }
      // Re-position after the smooth-scroll animation finishes.
      setTimeout(reposition, 700);

      console.log("[Styx Multi-Cart] overlay ring placed over", target);
    };

    const deadline = Date.now() + 10000;
    const tick = () => {
      const found = findButton();
      if (found && found.emptyBulkPage) {
        resolve({
          ok: false,
          emptyBulkPage: true,
          error: "Amazon rendered no products on the bulk-add page",
        });
        return;
      }
      const btn = found && found.button ? found.button : found;
      if (btn) {
        try {
          const goToCartVariant = looksLikeGoToCart(btn);
          if (goToCartVariant) relabelGoToCart(btn);
          applyOverlayRing(btn);
          resolve({
            ok: true,
            confirmLabel: goToCartVariant
              ? "Add All to Amazon Cart"
              : "Add To Cart",
          });
        }
        catch (e) {
          console.error("[Styx Multi-Cart] applyOverlayRing failed:", e);
          resolve({ ok: false, error: String(e) });
        }
        return;
      }
      if (Date.now() > deadline) {
        // Dump diagnostic info so we can identify which selectors to add.
        const inputs = Array.from(document.querySelectorAll("input[type='submit'], button"));
        console.warn(
          "[Styx Multi-Cart] confirm button not found within 10s. Visible submits/buttons on page:",
          inputs.filter(isVisible).map((el) => ({
            tag: el.tagName,
            name: el.name || null,
            id: el.id || null,
            value: el.value || null,
            text: (el.textContent || "").trim().slice(0, 60),
            ariaLabel: el.getAttribute("aria-label"),
          }))
        );
        resolve({ ok: false, error: "Confirm button not found within 10s" });
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

/**
 * Runs in the page context. Renders a modal Yes/No prompt overlaying
 * whatever page the user is on, and resolves to "yes" | "no" | "dismissed"
 * (dismissed = clicked the backdrop outside the modal). Used to ask the
 * user whether to fall back to per-item restore when bulk doesn't land
 * every item. The title/message strings come from the extension — never
 * user input — but we still set them via textContent so a defensive
 * mistake doesn't open an XSS hole.
 */
function pagePromptChoice(title, message, choices, theme) {
  // choices: [{ label, value, style: 'primary'|'secondary'|'ghost' }]
  // Resolves with the chosen `value`, or "dismissed" if user clicks the backdrop.
  return new Promise((resolve) => {
    const ID = "__styx-prompt-modal";
    const existing = document.getElementById(ID);
    if (existing) existing.remove();

    const isDark =
      theme === "dark" ||
      (theme !== "light" &&
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    const palette = isDark
      ? {
          backdrop: "rgba(0,0,0,.55)",
          bg: "#131a22",
          fg: "#ffffff",
          sub: "rgba(255,255,255,.92)",
          line: "#ff9900",
          shadow: "0 0 0 1px #ff9900,0 6px 32px rgba(0,0,0,.6)",
          ghostLine: "#4b5563",
          ghostFg: "#ffffff",
        }
      : {
          backdrop: "rgba(15,17,21,.35)",
          bg: "#ffffff",
          fg: "#131a22",
          sub: "#4a5360",
          line: "#ff9900",
          shadow: "0 1px 2px rgba(15,17,21,.08),0 12px 32px rgba(15,17,21,.18)",
          ghostLine: "#c9bfae",
          ghostFg: "#4a5360",
        };

    const overlay = document.createElement("div");
    overlay.id = ID;
    overlay.style.cssText =
      "position:fixed;inset:0;background:" + palette.backdrop + ";" +
      "z-index:2147483646;display:flex;align-items:center;justify-content:center;" +
      "font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;";

    const modal = document.createElement("div");
    modal.style.cssText =
      "background:" + palette.bg + ";color:" + palette.fg + ";border:1px solid " + palette.line + ";" +
      "border-radius:14px;padding:22px 26px;max-width:480px;width:90%;" +
      "box-shadow:" + palette.shadow + ";";

    const h = document.createElement("div");
    h.style.cssText = "font-size:18px;font-weight:700;margin-bottom:10px;";
    h.textContent = title;
    modal.appendChild(h);

    const p = document.createElement("div");
    p.style.cssText = "font-size:15px;line-height:1.45;color:" + palette.sub + ";margin-bottom:22px;white-space:pre-wrap;";
    p.textContent = message;
    modal.appendChild(p);

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;";

    const styleFor = (style) => {
      if (style === "primary") {
        return "padding:9px 18px;border-radius:8px;border:1px solid #ff9900;" +
               "background:#ff9900;color:#131a22;cursor:pointer;font-size:14px;font-weight:700;";
      }
      if (style === "secondary") {
        return "padding:9px 16px;border-radius:8px;border:1px solid #ff9900;" +
               "background:transparent;color:#ff9900;cursor:pointer;font-size:14px;font-weight:600;";
      }
      // ghost
      return "padding:9px 16px;border-radius:8px;border:1px solid " + palette.ghostLine + ";" +
             "background:transparent;color:" + palette.ghostFg + ";cursor:pointer;font-size:14px;";
    };

    const cleanup = (answer) => { try { overlay.remove(); } catch (_e) {} resolve(answer); };

    for (const ch of (choices || [])) {
      const btn = document.createElement("button");
      btn.textContent = ch.label;
      btn.style.cssText = styleFor(ch.style || "ghost");
      btn.addEventListener("click", () => cleanup(ch.value));
      row.appendChild(btn);
    }

    modal.appendChild(row);
    overlay.appendChild(modal);
    (document.body || document.documentElement).appendChild(overlay);

    overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup("dismissed"); });
  });
}

/**
 * Wait until the user navigates the helper tab away from the bulk
 * confirmation page (the signal that they clicked "Add To Cart") OR
 * closes the tab OR the timeout expires. Resolves with the navigation
 * outcome so the caller can branch on success vs. abandon.
 */
async function waitForUserBulkConfirm(tabId, timeoutMs = 5 * 60 * 1000) {
  // The click POSTs and navigates away from add.html, so "user confirmed" ==
  // "tab URL is no longer add.html". Poll for the URL rather than trusting
  // tabs.onUpdated events: Safari fires spurious update events whose tab.url
  // doesn't reflect the real main-frame URL, which made this resolve before
  // the user ever clicked (reconciliation then read a cart the user hadn't
  // filled yet and raised a false "Bulk add incomplete").
  //
  // Two stale-metadata defenses: when tabs.get doesn't show add.html, ask the
  // page itself for location.href; and only accept "navigated away" after the
  // add page has been observed at least once.
  const isAddUrl = (u) => /\/gp\/aws\/cart\/add\.html/i.test(u || "");
  const deadline = Date.now() + timeoutMs;
  let sawAddPage = false;
  while (Date.now() < deadline) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (_e) {
      return { ok: false, error: "tab closed" };
    }
    let url = tab.url || "";
    if (!isAddUrl(url)) {
      try {
        const r = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => location.href,
        });
        const href = r && r[0] && r[0].result;
        if (href) url = href;
      } catch (_e) {
        // Mid-navigation or page not scriptable — keep the tabs.get URL.
      }
    }
    if (isAddUrl(url)) {
      sawAddPage = true;
    } else if (url && sawAddPage) {
      return { ok: true, url };
    }
    await sleep(400);
  }
  return { ok: false, error: "user did not confirm within timeout" };
}

/**
 * Fast-path restore via the batch endpoint. On success returns
 * { ok:true, missing:[…] } where `missing` is items that didn't land
 * with the requested quantity (caller falls back to per-item for those).
 * On failure returns { ok:false, error, missing: <all items> } so the
 * caller can run the full per-item engine.
 */
async function restoreCartBulk(savedCart) {
  const allItems = (savedCart.items || []).filter((it) => it && it.asin);
  if (!allItems.length) {
    return { ok: false, error: "no items", missing: [] };
  }

  await writeSettings({ restoring: true });
  const host = savedCart.host || "www.amazon.com";
  const cartLabel = savedCart.name ? `"${savedCart.name}"` : "cart";
  const chunks = chunkItemsForBulk(allItems, 30);

  let helperTab;
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active && isAmazonUrl(active.url)) helperTab = active;
  } catch (_e) { /* fall through */ }

  try {
    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c];
      const url = buildBulkAddUrl(host, chunk, STYX_ASSOCIATE_TAG);
      const batchLabel = chunks.length > 1
        ? `batch ${c + 1}/${chunks.length} (${chunk.length} items)`
        : `${chunk.length} items in one go`;
      setOpStatus(`Restoring ${cartLabel}`, `Loading bulk add for ${batchLabel}…`);

      if (!helperTab) {
        helperTab = await chrome.tabs.create({ url, active: true });
      } else {
        await chrome.tabs.update(helperTab.id, { url, active: true });
      }
      await waitForTabReload(helperTab.id, 25000);

      // Paint an immediate toast so the user always gets feedback that
      // bulk add is running, even before we know whether the confirm
      // page rendered. This used to be gated on the highlight succeeding,
      // which meant any selector miss = total UI silence.
      const loadingPrompt = chunks.length > 1
        ? `Loading bulk add — batch ${c + 1} of ${chunks.length} (${chunk.length} items)…`
        : `Loading bulk add for ${chunk.length} item${chunk.length === 1 ? '' : 's'}…`;
      await showStatus(helperTab.id, loadingPrompt, "loading");

      // Get the floating modal out of the way — it re-opens across
      // navigations and lands right on top of the confirm button's buybox.
      try {
        await chrome.scripting.executeScript({
          target: { tabId: helperTab.id },
          func: pageMinimizeFloatingUi,
        });
      } catch (_e) { /* best-effort — worst case the user drags it aside */ }

      // Try to highlight the confirm button. Two possible outcomes:
      //   (a) Confirm page rendered → button found → highlight + ask user to click.
      //   (b) Amazon redirected past it OR our selectors miss the button →
      //       skip the wait, proceed to reconciliation at the end of the loop.
      const hlRes = await chrome.scripting.executeScript({
        target: { tabId: helperTab.id },
        func: pageHighlightBulkConfirm,
      });
      const hr = hlRes && hlRes[0] && hlRes[0].result;

      // Amazon accepted the bulk URL but rejected every requested product.
      // There is nothing meaningful for the user to confirm or reconcile, so
      // return a hard bulk failure and let the caller immediately run the
      // reliable per-item engine. This deliberately skips the redundant
      // "bulk add incomplete" prompt.
      if (hr && hr.emptyBulkPage) {
        dinfo(
          `[Styx Multi-Cart] bulk chunk ${c + 1} rendered no products; ` +
            `switching directly to per-item restore.`
        );
        await showStatus(
          helperTab.id,
          "Amazon couldn't prepare these items in bulk — adding them one at a time…",
          "loading"
        );
        return {
          ok: false,
          error: hr.error || "Amazon rejected the bulk-add items",
          host,
          helperTabId: helperTab && helperTab.id,
          missing: allItems,
          bulkRejectedItems: true,
        };
      }

      if (hr && hr.ok) {
        // Path (a): user-confirm flow.
        const confirmLabel = hr.confirmLabel || "Add To Cart";
        const chunkPrompt = chunks.length > 1
          ? `Click the highlighted "${confirmLabel}" to confirm batch ${c + 1} of ${chunks.length} (${chunk.length} items)`
          : `Click the highlighted "${confirmLabel}" to add ${chunk.length} item${chunk.length === 1 ? '' : 's'} to your Amazon cart`;
        setOpStatus(`Restoring ${cartLabel}`, `Waiting for your confirmation…`);
        await showStatus(helperTab.id, chunkPrompt, "loading");

        const confirmRes = await waitForUserBulkConfirm(helperTab.id);
        if (!confirmRes.ok) {
          // User closed tab or didn't act within 5 min — treat as abandon.
          // No fallback prompt: the user explicitly walked away.
          return {
            ok: false,
            error: `User did not confirm bulk add: ${confirmRes.error}`,
            host,
            helperTabId: helperTab && helperTab.id,
            missing: allItems,
            userAbandoned: true,
          };
        }
        await waitForTabComplete(helperTab.id, 20000);
      } else {
        // Path (b): highlight failed. Tell the user we're falling through
        // to reconciliation rather than leaving the toast on "Loading…"
        // indefinitely. Console has the dump of visible buttons for debug.
        dinfo(
          `[Styx Multi-Cart] bulk chunk ${c + 1} highlight failed (${(hr && hr.error) || "unknown"}); ` +
            `proceeding to cart reconciliation.`
        );
        await showStatus(
          helperTab.id,
          "Couldn't find the confirm button — checking your cart…",
          "loading"
        );
      }
    }

    // Reconcile: scrape resulting cart, diff against what we sent.
    let cart = null;
    try { cart = await scrapeCartInBackground(host); } catch (_e) { /* treat as empty */ }
    const inCart = new Map();
    if (cart && Array.isArray(cart.items)) {
      for (const it of cart.items) {
        inCart.set(String(it.asin).toUpperCase(), Number(it.quantity) || 1);
      }
    }
    const missing = [];
    for (const want of allItems) {
      const wantQty = Math.max(1, Number(want.quantity) || 1);
      const have = inCart.get(String(want.asin).toUpperCase()) || 0;
      if (have < wantQty) {
        missing.push({ ...want, quantity: wantQty - have });
      }
    }

    // Full success: every item present in cart. No prompt — caller paints
    // the done toast.
    if (missing.length === 0) {
      return {
        ok: true,
        host,
        helperTabId: helperTab && helperTab.id,
        total: allItems.length,
        added: allItems.length,
        missing: [],
      };
    }

    // Partial / nothing landed. Ask the user before running the slow
    // per-item fallback — they're already on the cart page and may want
    // to see the partial result before committing to a long restore.
    const addedCount = allItems.length - missing.length;

    // Build a readable list of what didn't make it into the cart so the user
    // can decide whether the slow per-item restore is worth it. Titles are
    // truncated; a long tail is summarized as "…and N more" to keep the modal
    // from growing past the confirm buttons.
    const MISSING_LIST_MAX = 8;
    const missingLines = missing.slice(0, MISSING_LIST_MAX).map((it) => {
      let label = (it.title || it.asin || "item").trim();
      if (label.length > 70) label = label.slice(0, 69).trimEnd() + "…";
      const qty = Math.max(1, Number(it.quantity) || 1);
      return qty > 1 ? `• ${label} (×${qty})` : `• ${label}`;
    });
    if (missing.length > MISSING_LIST_MAX) {
      missingLines.push(`• …and ${missing.length - MISSING_LIST_MAX} more`);
    }
    const missingList = `\n\nStill missing:\n${missingLines.join("\n")}`;

    const summary = (addedCount > 0
      ? `Bulk add only got ${addedCount} of ${allItems.length} items into your cart.\n\nWould you like to restore the remaining ${missing.length} one at a time? This is slower but more reliable.`
      : `The bulk add didn't put any items in your cart — Amazon's batch endpoint may have silently dropped them (often because the associate tag isn't recognized).\n\nWould you like to restore all ${allItems.length} items one at a time instead?`)
      + missingList;

    // Detect whether the helper tab is still on the bulk confirm page.
    // If so, the user can still click the real "Add To Cart" themselves
    // — that's almost always preferable to per-item fallback when the
    // page is right there. Offer it as the primary choice.
    let stillOnConfirmPage = false;
    try {
      const tab = await chrome.tabs.get(helperTab.id);
      stillOnConfirmPage = /\/gp\/aws\/cart\/add\.html/i.test(tab.url || "");
    } catch (_e) { /* tab might be closed */ }

    const choices = [];
    if (stillOnConfirmPage) {
      choices.push({
        label: "I'll click \"Add To Cart\" myself",
        value: "manual",
        style: "primary",
      });
      choices.push({
        label: "Restore one by one",
        value: "fallback",
        style: "secondary",
      });
    } else {
      choices.push({
        label: "Restore one by one",
        value: "fallback",
        style: "primary",
      });
    }
    choices.push({ label: "Skip missed items", value: "cancel", style: "ghost" });

    let userChoice = "cancel";
    try {
      let promptTheme = null;
      try {
        const promptSettings = await readSettings();
        promptTheme = promptSettings.theme || null;
      } catch (_settingsErr) { /* fall back to system theme in the page */ }
      const promptRes = await chrome.scripting.executeScript({
        target: { tabId: helperTab.id },
        func: pagePromptChoice,
        args: ["Bulk add incomplete", summary, choices, promptTheme],
      });
      userChoice = (promptRes && promptRes[0] && promptRes[0].result) || "cancel";
    } catch (_e) {
      // Tab closed or injection failed — treat as cancel.
      userChoice = "cancel";
    }

    if (userChoice === "manual") {
      // User wants to click the button themselves. Help them by scrolling
      // any plausible submit into view (we know our selectors miss it,
      // so best-effort: scroll to the bottom of the form or page) then
      // wait for the same navigation signal the happy path uses.
      try {
        await chrome.scripting.executeScript({
          target: { tabId: helperTab.id },
          func: () => {
            const guesses = [
              "form[action*='cart' i] input[type='submit']",
              "form[action*='cart' i] button[type='submit']",
              "form[action*='cart' i] input.a-button-input",
              "input[type='submit']",
              "button[type='submit']",
            ];
            for (const sel of guesses) {
              const el = document.querySelector(sel);
              if (el && el.getBoundingClientRect().width > 0) {
                el.scrollIntoView({ behavior: "smooth", block: "center" });
                return;
              }
            }
            // Nothing matched — scroll to bottom so the user can see the
            // confirm button without hunting.
            window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
          },
        });
      } catch (_e) { /* best-effort */ }

      await showStatus(
        helperTab.id,
        "Click \"Add To Cart\" on the page when you're ready — restore continues automatically",
        "loading"
      );

      const manualRes = await waitForUserBulkConfirm(helperTab.id);
      if (!manualRes.ok) {
        // User closed tab / 5-min timeout.
        return {
          ok: false,
          error: `User did not confirm bulk add: ${manualRes.error}`,
          host,
          helperTabId: helperTab && helperTab.id,
          missing: allItems,
          userAbandoned: true,
        };
      }
      await waitForTabComplete(helperTab.id, 20000);

      // Re-reconcile against the live cart after their click.
      let cart2 = null;
      try { cart2 = await scrapeCartInBackground(host); } catch (_e) { /* treat as empty */ }
      const inCart2 = new Map();
      if (cart2 && Array.isArray(cart2.items)) {
        for (const it of cart2.items) {
          inCart2.set(String(it.asin).toUpperCase(), Number(it.quantity) || 1);
        }
      }
      const missing2 = [];
      for (const want of allItems) {
        const wantQty = Math.max(1, Number(want.quantity) || 1);
        const have = inCart2.get(String(want.asin).toUpperCase()) || 0;
        if (have < wantQty) missing2.push({ ...want, quantity: wantQty - have });
      }
      return {
        ok: true,
        host,
        helperTabId: helperTab && helperTab.id,
        total: allItems.length,
        added: allItems.length - missing2.length,
        missing: missing2,
      };
    }

    if (userChoice === "fallback") {
      // Caller will run restoreCart on the missing subset.
      return {
        ok: true,
        host,
        helperTabId: helperTab && helperTab.id,
        total: allItems.length,
        added: addedCount,
        missing,
      };
    }

    // userChoice === "cancel" or "dismissed". Return ok with empty
    // missing AND the userDeclinedFallback flag so the caller doesn't
    // run per-item AND doesn't paint the success-navigation flow.
    const partialMsg = addedCount > 0
      ? `Bulk restore added ${addedCount} of ${allItems.length} items — ${missing.length} skipped`
      : `Bulk restore added 0 items — try again or restore one by one`;
    clearOpStatus(partialMsg);
    try {
      await showStatus(helperTab.id, partialMsg, addedCount > 0 ? "done" : "error");
    } catch (_e) { /* tab may be gone */ }
    return {
      ok: true,
      host,
      helperTabId: helperTab && helperTab.id,
      total: allItems.length,
      added: addedCount,
      missing: [],
      userDeclinedFallback: true,
    };
  } finally {
    // restoreCart (the per-item fallback) re-sets restoring:true itself,
    // so it's safe to release the flag here regardless of fallback path.
    await writeSettings({ restoring: false });
  }
}

async function restoreCart(savedCart, onProgress) {
  const items = (savedCart.items || []).filter((it) => it && it.asin);
  if (!items.length) {
    return { ok: false, error: "This saved cart has no items." };
  }

  // Suspend the ATC intercept for the duration of the restore.
  // observer.js watches mc.settings.v1 via chrome.storage.onChanged and
  // hydrateCachesFromStorage(), so any page that loads during the restore
  // will see restoring:true and skip the cart-picker overlay entirely.
  // The finally block guarantees the flag is cleared even on error/throw.
  await writeSettings({ restoring: true });

  let _restoreResult;
  try {

  const host = savedCart.host || "www.amazon.com";
  const productUrl = (item) =>
    item.url && /^https?:\/\//.test(item.url)
      ? item.url
      : `https://${host}/dp/${item.asin}`;

  // Open the helper tab on the first product. Use waitForTabReload rather than
  // navigateTabAndWait / createTabAndWait: those use exact URL matching which
  // breaks when Amazon redirects /dp/ASIN → /Product-Title/dp/ASIN. We only
  // care that the page finished loading, not its exact final URL.
  const cartLabel = savedCart.name ? `"${savedCart.name}"` : "cart";
  setOpStatus(`Restoring ${cartLabel}`, `Loading first product…`);

  // Reuse the user's active Amazon tab if they have one — they were
  // almost certainly on the cart page when they clicked Restore, and
  // we're about to navigate it anyway. Spawning a second tab and
  // leaving the original on a stale "Preparing…" toast is just noise.
  // Fall back to a fresh tab only if no Amazon tab is foregrounded
  // (e.g. user triggered restore from a non-Amazon page).
  let helperTab;
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active && isAmazonUrl(active.url)) {
      await chrome.tabs.update(active.id, { url: productUrl(items[0]), active: true });
      helperTab = active;
    }
  } catch (_e) { /* fall through to create */ }
  if (!helperTab) {
    helperTab = await chrome.tabs.create({ url: productUrl(items[0]), active: true });
  }
  await waitForTabReload(helperTab.id, 20000);

  let added = 0;
  let failed = 0;
  const failures = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      // For all items after the first, navigate the same tab and wait for
      // the next load cycle (URL-agnostic).
      if (i > 0) {
        await chrome.tabs.update(helperTab.id, { url: productUrl(item), active: true });
        await waitForTabReload(helperTab.id, 20000);
      }

      // Deleted ASINs and explicitly unavailable products cannot recover by
      // waiting for an ATC button. Record them and continue immediately so a
      // single bad wishlist row never stops the rest of the restore.
      const availabilityResult = await chrome.scripting.executeScript({
        target: { tabId: helperTab.id },
        func: pageClassifyProductAvailability,
      });
      let availability =
        availabilityResult && availabilityResult[0] && availabilityResult[0].result;
      if (availability && availability.available === false) {
        const reason = availability.reason || "Product is unavailable";
        failed++;
        failures.push({
          asin: item.asin,
          title: item.title || "",
          reason,
          unavailable: true,
        });
        const raw = item.title || item.asin || "item";
        const shortTitle = raw.length > 30 ? raw.slice(0, 28) + "…" : raw;
        setOpStatus(
          `Restoring ${cartLabel}`,
          `Skipping unavailable item ${i + 1} of ${items.length}: ${shortTitle}`
        );
        await showStatus(
          helperTab.id,
          `Unavailable — skipped ${shortTitle}`,
          "error"
        );
        if (onProgress) onProgress({ done: i + 1, total: items.length });
        await sleep(350);
        continue;
      }

      // Books, recordings, and a few other Amazon categories can resolve a
      // wishlist ASIN to an edition that is no longer cartable while still
      // offering alternate formats on the same PDP. Clicking blindly here
      // just waits 15 seconds for an ATC button that will never appear. Pause
      // instead and let the user pick a cartable format; once Amazon exposes
      // its real Add to Cart button, the restore resumes automatically.
      if (availability && availability.needsUserChoice === true) {
        const choice = await waitForUserProductFormatChoice(
          helperTab.id,
          item
        );
        if (!choice.ok) {
          const reason = choice.reason || "A purchasable format was not selected";
          failed++;
          failures.push({
            asin: item.asin,
            title: item.title || "",
            reason,
            needsUserChoice: true,
          });
          if (onProgress) onProgress({ done: i + 1, total: items.length });
          continue;
        }
        availability = choice.availability || { available: true };
      }

      // Show per-item progress on the now-loaded product page and in the status window.
      {
        const raw = item.title || item.asin || '';
        const shortTitle = raw.length > 30 ? raw.slice(0, 28) + '…' : raw;
        setOpStatus(
          `Restoring ${cartLabel}`,
          `Item ${i + 1} of ${items.length}: ${shortTitle}`
        );
        await showStatus(
          helperTab.id,
          `Restoring cart — adding ${i + 1} of ${items.length}: ${shortTitle}`,
          'loading'
        );
      }
      await sleep(700);

      // Wire up a navigation detector BEFORE clicking. Some Amazon products
      // navigate to a confirmation or upsell page on ATC; others show an
      // in-page panel. We need to know which happened so we can wait correctly.
      // The listener must be active before the click so we can't miss the event.
      let pageNavigated = false;
      const navPromise = new Promise((resolve) => {
        let done = false;
        const finish = (v) => {
          if (done) return;
          done = true;
          chrome.tabs.onUpdated.removeListener(navListener);
          resolve(v);
        };
        const navListener = (id, info) => {
          if (id === helperTab.id && info.status === "loading") {
            pageNavigated = true;
            finish(true);
          }
        };
        chrome.tabs.onUpdated.addListener(navListener);
        // 2.5 s window — if no navigation by then, assume in-page panel.
        setTimeout(() => finish(false), 2500);
      });

      // Click the ATC button. pageAddToCart resolves immediately after the
      // click (before any page navigation can destroy the script context).
      const result = await chrome.scripting.executeScript({
        target: { tabId: helperTab.id },
        func: pageAddToCart,
        args: [Math.max(1, item.quantity || 1)],
      });
      const r = result && result[0] && result[0].result;

      if (!r || !r.ok) {
        // Genuine failure: ATC button not found or stayed disabled after retries.
        // Cancel navPromise (it will self-clean after its 2.5 s timeout).
        failed++;
        failures.push({
          asin: item.asin,
          title: item.title || "",
          reason: (r && r.error) || "ATC button not found",
        });
      } else {
        // Button was clicked. Wait to see whether Amazon navigates (confirmation
        // or upsell page) or keeps the user on the product page (slide-in panel).
        const navigated = await navPromise;

        if (navigated) {
          // Navigation detected — wait for the new page to finish loading.
          // Use waitForTabComplete (not waitForTabReload) because the page may
          // already be complete by the time navPromise resolved.
          await waitForTabComplete(helperTab.id, 12000);
        }

        // Check for upsell regardless of which path Amazon took.
        if (await isUpsellTab(helperTab.id)) {
          // First try to replay the user's previously recorded choice for
          // this ASIN (24 h TTL). Falls back to the manual prompt if no
          // recorded choice exists or the page doesn't match confidently.
          const recorded = await getRecordedUpsellChoice(item.asin);
          let autoHandled = false;
          if (recorded) {
            const ageMs = Date.now() - (recorded.recordedAt || 0);
            const ageLabel = ageMs < 60 * 60 * 1000
              ? "earlier today"
              : ageMs < 24 * 60 * 60 * 1000
                ? "recently"
                : "from before";
            const choiceDesc =
              recorded.choice === "declined"
                ? '"No coverage"'
                : `"${(recorded.optionLabel || "selected option").slice(0, 60)}"`;
            setOpStatus(
              `Restoring ${cartLabel}`,
              `Applying your choice ${ageLabel}: ${choiceDesc}…`
            );
            await showStatus(
              helperTab.id,
              `Applying your saved choice: ${choiceDesc}`,
              "loading"
            );
            autoHandled = await applyUpsellChoice(helperTab.id, recorded);
            if (autoHandled) {
              // Continue button submits a form → page navigates. Wait for it.
              await sleep(800);
              try {
                const tab = await chrome.tabs.get(helperTab.id);
                if (tab.status === "loading") {
                  await waitForTabComplete(helperTab.id, 12000);
                }
              } catch (_e) { /* tab might have closed */ }
            }
          }
          if (!autoHandled) {
            await waitForUserUpsellChoice(helperTab.id, item, host);
          }
        } else if (!navigated) {
          // In-page panel style — give Amazon a moment to register the add.
          await sleep(1200);
        }

        added++;
      }

      if (onProgress) onProgress({ done: i + 1, total: items.length });
    } catch (err) {
      // Unexpected: tab was closed mid-restore, permission error, etc.
      failed++;
      failures.push({
        asin: item.asin,
        title: item.title || "",
        reason: String(err && err.message) || String(err),
      });
      if (onProgress) onProgress({ done: i + 1, total: items.length });
    }
  }

  // Land on the cart view so the user can confirm what came through.
  try {
    await chrome.tabs.update(helperTab.id, {
      url: `https://${host}/gp/cart/view.html`,
      active: true,
    });
    await waitForTabReload(helperTab.id, 15000);
    // Show a summary on the final cart page and in the status window.
    const restoreDoneMsg = failed > 0
      ? `Cart restored — ${added} of ${items.length} added (${failed} failed)`
      : `Cart restored — ${added} item${added === 1 ? '' : 's'} added`;
    clearOpStatus(restoreDoneMsg);
    await showStatus(helperTab.id, restoreDoneMsg, added > 0 ? 'done' : 'error');
  } catch (_e) {
    // Tab may have been closed by the user mid-restore — fine.
  }

  _restoreResult = {
    ok: true,
    total: items.length,
    added,
    failed,
    failures,
  };

  } finally {
    // Always lift the interception suspension, regardless of how the
    // restore ends (success, thrown error, or tab-closed mid-restore).
    await writeSettings({ restoring: false });
  }

  return _restoreResult;
}

async function clearThenRestoreCart(target) {
  try {
    const currentCount = await getActiveAmazonCartCount(target.host);
    if (currentCount !== 0) {
      const cleared = await clearAmazonCart(target.host);
      if (!cleared || !cleared.ok) {
        dwarn(
          "[Styx Multi-Cart] restore could not clear existing cart",
          cleared
        );
        return;
      }
      // Let Amazon's servers settle before we start adding new items,
      // so restored items don't pile on top of a cart Amazon hasn't
      // finished emptying yet. Show a transitional status during this pause.
      setOpStatus(`Restoring "${target.name || 'cart'}"`, "Preparing…");
      try {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (active && isAmazonUrl(active.url)) {
          await showStatus(active.id, 'Preparing to restore…', 'loading');
        }
      } catch (_e) { /* best-effort */ }
      await sleep(2000);
    }

    // Fast path: hit Amazon's batch add endpoint, which renders a
    // confirmation page listing every ASIN and commits them all on a
    // single button click. Anything the batch endpoint can't add (login
    // redirect, captcha, dropped variant, page format change) falls
    // through to the per-item engine, which is slower but proven.
    const bulk = await restoreCartBulk(target);

    // User explicitly declined the per-item fallback in the bulk
    // reconciliation prompt — respect that and stop. Bulk already
    // painted a partial-result toast. Must come BEFORE the success path
    // because declined returns missing:[] too, but we don't want to
    // navigate them away from wherever they are.
    if (bulk.ok && bulk.userDeclinedFallback) {
      dinfo(
        `[Styx Multi-Cart] bulk added ${bulk.added}/${bulk.total}; ` +
          `user declined per-item fallback`
      );
      return;
    }

    // User abandoned the bulk confirm page (closed tab / 5-min timeout).
    // No automatic fallback — they walked away on purpose.
    if (!bulk.ok && bulk.userAbandoned) {
      dinfo("[Styx Multi-Cart] user abandoned bulk confirm — not falling back");
      return;
    }

    if (bulk.ok && bulk.missing.length === 0) {
      // Everything landed in one shot. Land the user on the cart view
      // and paint the done toast.
      const host = bulk.host || target.host || "www.amazon.com";
      const doneMsg = `Cart restored — ${bulk.added} item${bulk.added === 1 ? '' : 's'} added`;
      clearOpStatus(doneMsg);
      try {
        if (bulk.helperTabId) {
          await chrome.tabs.update(bulk.helperTabId, {
            url: `https://${host}/gp/cart/view.html`,
            active: true,
          });
          await waitForTabReload(bulk.helperTabId, 15000);
          await showStatus(bulk.helperTabId, doneMsg, 'done');
        }
      } catch (_e) { /* tab may have closed — fine */ }
      return;
    }

    // Otherwise: bulk had a hard failure (couldn't navigate, scripting
    // error, etc.) OR partial success where the user chose "Restore one
    // by one". Drive the remainder through the per-item engine.
    const fallbackItems = (bulk.missing && bulk.missing.length)
      ? bulk.missing
      : target.items;
    if (!bulk.ok) {
      dinfo(
        "[Styx Multi-Cart] bulk restore failed, falling back to per-item:",
        bulk.error
      );
    } else {
      dinfo(
        `[Styx Multi-Cart] bulk added ${bulk.added}/${bulk.total}; ` +
          `user opted to per-item-fill ${bulk.missing.length} missing`
      );
    }
    await restoreCart({ ...target, items: fallbackItems });
  } catch (err) {
    console.error("[Styx Multi-Cart] restore failed", err);
  }
}

// Add every item scraped from an Amazon wishlist page to the live Amazon
// cart. Unlike clearThenRestoreCart this is purely ADDITIVE — it never
// clears the existing cart — but it reuses the same proven bulk-add engine
// (and per-item fallback) that powers cart restore. Items arrive from
// observer.js as { asin, quantity, title, url }.
/**
 * Runs in the wishlist page's context (injected via executeScript). Clicks
 * each list item's NATIVE "Add to Cart" control for the requested ASINs —
 * Amazon adds 1 unit per click via AJAX with no page navigation, so this
 * replaces per-PDP navigation for the common qty-1 case and sidesteps PDP
 * protection-plan upsells entirely.
 *
 * Selectors are LIVE-VERIFIED (2026-07-24 spike):
 *   • item:   #g-items li[data-itemid]  (data-itemid = Amazon item id)
 *   • asin:   a.a-button-text[data-csa-c-item-id]  (asin sits on the anchor),
 *             falling back to the item's /dp/<ASIN> link
 *   • ATC:    #pab-declarative-<itemid> a.a-button-text  (the clickable <a>),
 *             wrapper span carries data-action="cta-add-to-cart"
 *   • added?: after a successful add the control is replaced by an a-stepper
 *             (button[data-action="a-stepper-increment"]) — used as the
 *             per-item "in cart" signal. NOTE: that stepper does NOT change
 *             cart quantity, so this only ever adds 1 unit per item; the
 *             caller reconciles against the real cart and sends any qty
 *             shortfall to the per-item (PDP) engine.
 *
 * Returns { added:[asin], alreadyInCart:[asin], notFound:[asin],
 *           notCartable:[asin], error? }.
 */
function pageAddAllFromList(targetAsins) {
  // Injected — no service-worker helpers (dlog/etc.) in this scope. Use
  // console.* only. executeScript awaits the returned Promise.
  return new Promise((resolve) => {
    const wanted = new Set(
      (targetAsins || []).map((a) => String(a).toUpperCase())
    );
    const results = {
      added: [],
      alreadyInCart: [],
      notFound: [],
      notCartable: [],
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const itemEls = () =>
      Array.from(document.querySelectorAll("#g-items li[data-itemid]"));

    const asinOf = (li) => {
      const a = li.querySelector("a.a-button-text[data-csa-c-item-id]");
      const fromAnchor = a && a.getAttribute("data-csa-c-item-id");
      if (fromAnchor && /^[A-Z0-9]{10}$/i.test(fromAnchor)) {
        return fromAnchor.toUpperCase();
      }
      const dp = li.querySelector("a[href*='/dp/'], a[href*='/gp/product/']");
      const m =
        dp &&
        (dp.getAttribute("href") || "").match(
          /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i
        );
      return m ? m[1].toUpperCase() : null;
    };

    const hasStepper = (li) =>
      !!li.querySelector("button[data-action='a-stepper-increment']");

    const atcAnchor = (li) => {
      const id = li.getAttribute("data-itemid");
      const a =
        li.querySelector("#pab-declarative-" + id + " a.a-button-text") ||
        li.querySelector("[data-action='cta-add-to-cart'] a.a-button-text");
      // Variation items render "See all buying options" in the SAME container —
      // clicking that navigates to the PDP and would abort this in-page loop.
      // Only treat a genuine add-to-cart anchor as clickable; everything else is
      // left for the caller's per-item (PDP) engine. Accept both Amazon's native
      // "Add to Cart" and our relabeled "Add to Amazon Cart" (observer.js), while
      // still rejecting "See all buying options" and friends.
      if (!a) return null;
      const t = (a.textContent || "").trim().toLowerCase();
      return t.startsWith("add to") && t.includes("cart") ? a : null;
    };

    // Amazon lazy-renders wishlist rows on scroll — force them all in before
    // we start matching, or later items simply won't exist in the DOM.
    async function scrollToLoadAll() {
      const scrollTo = (y) => {
        try { window.scrollTo(0, y); } catch (_e) { /* non-scrollable context */ }
      };
      let last = -1;
      let stable = 0;
      for (let i = 0; i < 40 && stable < 3; i++) {
        scrollTo(document.body.scrollHeight);
        await sleep(400);
        const n = itemEls().length;
        if (n === last) stable++;
        else {
          stable = 0;
          last = n;
        }
      }
      scrollTo(0);
      await sleep(200);
    }

    async function run() {
      await scrollToLoadAll();

      const byAsin = new Map();
      for (const li of itemEls()) {
        const asin = asinOf(li);
        if (asin && !byAsin.has(asin)) byAsin.set(asin, li);
      }

      for (const asin of wanted) {
        const li = byAsin.get(asin);
        if (!li) {
          results.notFound.push(asin);
          continue;
        }
        if (hasStepper(li)) {
          results.alreadyInCart.push(asin);
          continue;
        }
        const anchor = atcAnchor(li);
        if (!anchor) {
          results.notCartable.push(asin);
          continue;
        }
        try {
          anchor.scrollIntoView({ block: "center" });
        } catch (_e) { /* older browsers */ }
        await sleep(120);
        anchor.click();

        // Confirm the add by waiting for the stepper to replace the button.
        let ok = false;
        for (let t = 0; t < 12; t++) {
          await sleep(250);
          if (hasStepper(li)) {
            ok = true;
            break;
          }
        }
        (ok ? results.added : results.notCartable).push(asin);
        await sleep(300); // gentle pacing so Amazon's AJAX keeps up
      }
      resolve(results);
    }

    run().catch((e) => {
      console.warn("[Styx Multi-Cart] pageAddAllFromList error:", e);
      resolve({ ...results, error: String((e && e.message) || e) });
    });
  });
}

/**
 * Fallback restore path: add the given items to the Amazon cart by clicking
 * each one's native "Add to Cart" button ON THE LIST PAGE (via
 * pageAddAllFromList), then reconcile against the live cart. No per-item PDP
 * navigation. Returns { ok, host, helperTabId, missing } where `missing`
 * carries any qty shortfall (list adds only 1 unit each) or items the list
 * couldn't add — the caller routes those to the per-item PDP engine.
 *
 * Requires a listId; without one there's no list URL to drive, so it returns
 * ok:false with the full item set still "missing" for the caller to fall back.
 */
async function restoreViaListPage(target) {
  const host = target.host || "www.amazon.com";
  const listId = target.listId;
  const items = (target.items || []).filter((it) => it && it.asin);
  if (!listId || !items.length) {
    return { ok: false, error: "no listId or items", host, missing: items };
  }
  const targetAsins = items.map((it) => String(it.asin).toUpperCase());
  const listUrl = amazonListUrl(host, listId);

  // Suspend the on-page ATC intercept while we click Amazon's native buttons,
  // mirroring restoreCart. observer.js reads mc.settings.v1 via storage.onChanged.
  await writeSettings({ restoring: true });
  try {
    // Reuse the user's active Amazon tab (they were on the list); else spawn one.
    let helperTab;
    try {
      const [active] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (active && isAmazonUrl(active.url)) helperTab = active;
    } catch (_e) { /* fall through to create */ }

    if (!helperTab) {
      helperTab = await chrome.tabs.create({ url: listUrl, active: true });
    } else {
      await chrome.tabs.update(helperTab.id, { url: listUrl, active: true });
    }
    await waitForTabReload(helperTab.id, 25000);

    setOpStatus(
      "Adding wishlist to cart",
      `Adding ${items.length} item${items.length === 1 ? "" : "s"} from the list page…`
    );
    await showStatus(
      helperTab.id,
      `Adding ${items.length} item${items.length === 1 ? "" : "s"} from the list…`,
      "loading"
    );

    let res = {};
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId: helperTab.id },
        func: pageAddAllFromList,
        args: [targetAsins],
      });
      res = (r && r[0] && r[0].result) || {};
    } catch (e) {
      dinfo("[Styx Multi-Cart] list-page add-all injection failed:", e);
      res = { error: String(e) };
    }

    // Reconcile against the real cart — the on-page stepper is only a hint.
    let cart = null;
    try {
      cart = await scrapeCartInBackground(host);
    } catch (_e) { /* treat as empty → everything counts as missing */ }
    const inCart = new Map();
    if (cart && Array.isArray(cart.items)) {
      for (const it of cart.items) {
        inCart.set(String(it.asin).toUpperCase(), Number(it.quantity) || 1);
      }
    }
    const missing = [];
    for (const it of items) {
      const want = Math.max(1, Number(it.quantity) || 1);
      const have = inCart.get(String(it.asin).toUpperCase()) || 0;
      if (have < want) missing.push({ ...it, quantity: want - have });
    }

    return { ok: true, host, helperTabId: helperTab.id, listRes: res, missing };
  } finally {
    // restoreCart (if the caller runs it next) re-sets restoring:true itself,
    // so releasing here is safe regardless of what follows.
    await writeSettings({ restoring: false });
  }
}

async function wishlistAddAllToCart(items, host, listId) {
  try {
    const cleanItems = (items || []).filter(
      (it) => it && it.asin && it.unavailable !== true
    );
    if (!cleanItems.length) return;
    const target = {
      items: cleanItems,
      host: host || "www.amazon.com",
      name: "wishlist",
      listId: listId || null,
    };

    // Fast path: Amazon's batch add endpoint, same as cart restore.
    const bulk = await restoreCartBulk(target);

    // User declined the per-item fallback in the bulk reconciliation prompt.
    if (bulk.ok && bulk.userDeclinedFallback) return;
    // User abandoned the bulk confirm page (closed tab / timeout).
    if (!bulk.ok && bulk.userAbandoned) return;

    if (bulk.ok && bulk.missing.length === 0) {
      // Everything landed in one shot — land on the cart and toast.
      const h = bulk.host || target.host || "www.amazon.com";
      const doneMsg = `Added ${bulk.added} item${bulk.added === 1 ? "" : "s"} to your Amazon cart`;
      clearOpStatus(doneMsg);
      try {
        if (bulk.helperTabId) {
          await chrome.tabs.update(bulk.helperTabId, {
            url: `https://${h}/gp/cart/view.html`,
            active: true,
          });
          await waitForTabReload(bulk.helperTabId, 15000);
          await showStatus(bulk.helperTabId, doneMsg, "done");
        }
      } catch (_e) { /* tab may have closed — fine */ }
      return;
    }

    // Bulk didn't fully land (hard failure, or partial where the user chose to
    // continue). Remainder to recover:
    const fallbackItems = (bulk.missing && bulk.missing.length)
      ? bulk.missing
      : target.items;
    if (!bulk.ok) {
      dinfo(
        "[Styx Multi-Cart] wishlist bulk add failed, falling back to list-page add:",
        bulk.error
      );
    }

    // Preferred fallback: click each item's native "Add to Cart" ON THE LIST
    // PAGE — no per-PDP navigation, and it skips PDP upsells. Reconciliation
    // inside restoreViaListPage returns whatever the list couldn't fully add
    // (qty shortfalls, unavailable rows), which then goes to the PDP engine.
    let remainder = fallbackItems;
    if (target.listId) {
      const listOutcome = await restoreViaListPage({
        ...target,
        items: fallbackItems,
      });
      if (listOutcome && listOutcome.ok) {
        remainder = listOutcome.missing || [];
      }
    }

    if (remainder.length === 0) {
      // Everything landed via the list page → take the user to their cart.
      const addedMsg = `Added ${cleanItems.length} item${cleanItems.length === 1 ? "" : "s"} to your Amazon cart`;
      clearOpStatus(addedMsg);
      try {
        const [active] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        const cartTabId =
          active && isAmazonUrl(active.url)
            ? active.id
            : (await chrome.tabs.create({
                url: `https://${target.host}/gp/cart/view.html`,
                active: true,
              })).id;
        await chrome.tabs.update(cartTabId, {
          url: `https://${target.host}/gp/cart/view.html`,
          active: true,
        });
        await waitForTabReload(cartTabId, 15000);
        await showStatus(cartTabId, addedMsg, "done");
      } catch (_e) { /* tab may have closed — fine */ }
      return;
    }

    // Anything the list page couldn't fully add (multi-qty extras, unavailable,
    // format-choice items) → per-item PDP engine. It lands on the cart itself.
    dinfo(
      `[Styx Multi-Cart] list-page add left ${remainder.length} item(s); running per-item engine.`
    );
    await restoreCart({ ...target, items: remainder });
  } catch (err) {
    console.error("[Styx Multi-Cart] wishlist add-all failed", err);
  }
}

async function clearCurrentCartInBackground() {
  try {
    await clearAmazonCart(undefined, { returnToOrigin: true });
  } catch (err) {
    console.error("[Styx Multi-Cart] clear failed", err);
  }
}

async function isUpsellTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isUpsellUrl(tab.url)) return true;
  } catch (_e) {
    return false;
  }

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageHasRestoreUpsell,
    });
    return Boolean(result && result[0] && result[0].result);
  } catch (_e) {
    return false;
  }
}

async function waitForUserProductFormatChoice(tabId, item) {
  await chrome.tabs.update(tabId, { active: true });
  const raw = (item && item.title) || "this item";
  const shortTitle = raw.length > 60 ? raw.slice(0, 58) + "…" : raw;

  setOpStatus(
    "Amazon needs a format choice",
    `Choose a cartable format for "${shortTitle}" to continue adding the rest.`
  );

  let promptTheme = null;
  try {
    const settings = await readSettings();
    promptTheme = settings.theme || null;
  } catch (_e) { /* use the page's system theme */ }

  let answer = "skip";
  try {
    const promptResult = await chrome.scripting.executeScript({
      target: { tabId },
      func: pagePromptChoice,
      args: [
        "Choose a format on Amazon",
        `The saved format of "${shortTitle}" cannot be added to the cart. Choose another format or edition on this page that offers Add to Cart. Styx will resume automatically.`,
        [
          { label: "Choose a format", value: "choose", style: "primary" },
          { label: "Skip this item", value: "skip", style: "ghost" },
        ],
        promptTheme,
      ],
    });
    answer =
      (promptResult && promptResult[0] && promptResult[0].result) || "skip";
  } catch (_e) {
    return { ok: false, reason: "Could not show the format picker prompt" };
  }

  if (answer !== "choose") {
    return { ok: false, reason: "Skipped because the saved format is unavailable" };
  }

  await showStatus(
    tabId,
    `Choose a format for "${shortTitle}" that shows Add to Cart — Styx will resume automatically`,
    "loading"
  );

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(1000);
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab) return { ok: false, reason: "Amazon tab was closed" };
      if (tab.status === "loading") continue;

      const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: pageClassifyProductAvailability,
      });
      const availability = result && result[0] && result[0].result;
      if (availability && availability.available === false) {
        return {
          ok: false,
          reason: availability.reason || "The selected format is unavailable",
          availability,
        };
      }
      if (!availability || availability.needsUserChoice !== true) {
        return { ok: true, availability: availability || { available: true } };
      }
    } catch (_e) {
      // A format tile often navigates to another ASIN. Scripting can fail
      // during that transition; keep polling until the new PDP is ready.
    }
  }

  return { ok: false, reason: "No cartable format was selected within 10 minutes" };
}

async function waitForUserUpsellChoice(tabId, item, host) {
  await chrome.tabs.update(tabId, { active: true });
  const raw = (item && item.title) || "this item";
  const shortTitle = raw.length > 40 ? raw.slice(0, 38) + "…" : raw;
  setOpStatus(
    "Waiting on your choice",
    `Pick a protection option for "${shortTitle}" on the Amazon page — restore resumes automatically.`
  );
  await showRestoreUpsellNotice(tabId, item);

  const timeoutAt = Date.now() + 10 * 60 * 1000;
  while (Date.now() < timeoutAt) {
    await sleep(1500);
    // Re-paint the toast each poll — Amazon's protection-plan flow
    // sometimes swaps the page body mid-interaction, wiping our node.
    await showRestoreUpsellNotice(tabId, item);
    if (!(await isUpsellTab(tabId))) {
      await waitForTabComplete(tabId, 15000);
      await sleep(800);
      return true;
    }
  }

  await chrome.tabs.update(tabId, {
    url: `https://${host}/gp/cart/view.html`,
    active: true,
  });
  return false;
}

async function showRestoreUpsellNotice(tabId, item) {
  var raw = (item && item.title) || "this item";
  var shortTitle = raw.length > 50 ? raw.slice(0, 48) + "…" : raw;
  try {
    await showStatus(
      tabId,
      'Amazon needs your protection-plan choice for "' + shortTitle + '". Pick an option below — Styx will keep restoring the rest of your cart as soon as you choose.',
      "loading"
    );
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * Inject a floating status toast into the given tab's page.
 * Best-effort — errors are swallowed so they never block the main flow.
 *
 * @param {number} tabId
 * @param {string} message
 * @param {'loading'|'done'|'error'} [type='loading']
 */
async function showStatus(tabId, message, type = 'loading') {
  try {
    let theme = null;
    let placement = 'bottom';
    try {
      const settings = await readSettings();
      theme = settings.theme || null;
      // Side panel docks beside the page, so a top toast is uncovered and more
      // visible. A popup drops from the toolbar over the top of the page, so
      // there the toast stays at the bottom. Safari (no side panel) → bottom.
      const panelSupported = !!(chrome.sidePanel && chrome.sidePanel.setPanelBehavior);
      placement = panelSupported && settings.uiSurface !== 'popup' ? 'top' : 'bottom';
    } catch (_settingsErr) { /* fall back to system theme + bottom in the page */ }
    await chrome.scripting.executeScript({
      target: { tabId },
      func: pageShowStatus,
      args: [message, type, theme, placement],
    });
  } catch (_e) {
    // Status overlay is decorative — never block operations on failure.
  }
}

function isUpsellUrl(url) {
  return /\/gp\/.*attach|attach-warranty|warranty|protection|service-plan/i.test(
    url || ""
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Identify terminal product pages where an item cannot be added. */
function pageClassifyProductAvailability() {
  try {
    const bodyText = (
      (document.body && (document.body.innerText || document.body.textContent)) || ""
    )
      .replace(/\s+/g, " ")
      .trim();
    const title = String(document.title || "").trim();
    const combined = `${title} ${bodyText}`.toLowerCase();

    if (
      /sorry[,\s]*we\s+couldn['’]?t\s+find\s+that\s+page/i.test(combined) ||
      combined.includes("the web address you entered is not a functioning page")
    ) {
      return { available: false, reason: "Product page no longer exists" };
    }

    const availabilityEl = document.querySelector(
      "#availability, #outOfStock, [id^='availability'], [data-feature-name='availability']"
    );
    const availabilityText = (
      (availabilityEl && (availabilityEl.innerText || availabilityEl.textContent)) || ""
    )
      .replace(/\s+/g, " ")
      .trim();
    if (
      availabilityText &&
      /currently unavailable|no longer available|not available for purchase|item is unavailable/i.test(
        availabilityText
      )
    ) {
      return {
        available: false,
        reason: availabilityText || "Product is currently unavailable",
      };
    }

    const addToCartButton = document.querySelector(
      "#add-to-cart-button, " +
        "input[name='submit.add-to-cart'], " +
        "input[name='submit.addToCart'], " +
        "button[name='submit.add-to-cart']"
    );
    const hasUsableAddToCart = Boolean(
      addToCartButton &&
        !addToCartButton.disabled &&
        addToCartButton.getAttribute("aria-disabled") !== "true" &&
        addToCartButton.getAttribute("aria-hidden") !== "true"
    );

    // Amazon book/media PDPs keep the unavailable saved edition selected but
    // expose Kindle, paperback, audiobook, etc. as alternate ASIN tiles. This
    // is recoverable, but only the user can decide which product format they
    // actually want. Return a distinct state so restoreCart can pause rather
    // than misreporting it as a generic ATC failure.
    const formatRegion = document.querySelector(
      "#tmmSwatches, #tmmSwatches_feature_div, #formats, " +
        "#mediaTabs_tabSet, [data-feature-name='tmmSwatches']"
    );
    if (formatRegion && !hasUsableAddToCart) {
      const formatText = (
        formatRegion.innerText || formatRegion.textContent || ""
      )
        .replace(/\s+/g, " ")
        .trim();
      const formatControls = formatRegion.querySelectorAll(
        "a[href*='/dp/'], a[href*='/gp/product/'], button, input[type='radio']"
      );
      if (
        formatControls.length >= 2 &&
        /kindle|hardcover|paperback|audiobook|audio\s*cd|mp3\s*cd|mass market|spiral|format|edition/i.test(
          formatText
        )
      ) {
        return {
          available: true,
          needsUserChoice: true,
          reason: "The saved format is unavailable; choose another format",
        };
      }
    }

    return { available: true };
  } catch (e) {
    return { available: true, warning: String((e && e.message) || e) };
  }
}

/**
 * Runs in the product page's context (via chrome.scripting.executeScript).
 * Sets the quantity if there's a quantity dropdown, clicks the page's
 * real Add-to-Cart button, and reports any protection-plan upsell so the
 * background worker can pause for the user's choice.
 *
 * Returns { ok: bool, error?, needsUserChoice? }.
 */
function pageAddToCart(qty) {
  return new Promise((resolve) => {
    const ATC_SELECTORS = [
      "#add-to-cart-button",
      "input#add-to-cart-button",
      "input[name='submit.add-to-cart']",
      "input[name='submit.addToCart']",
      "button[name='submit.add-to-cart']",
      "#submit\\.add-to-cart input",
      "span#submit\\.add-to-cart input",
    ];

    const QTY_SELECTORS = [
      "select#quantity",
      "select[name='quantity']",
      "input#quantity",
      "input[name='quantity']",
    ];

    const findFirst = (sels) => {
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && isVisible(el)) return el;
      }
      return null;
    };

    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const hasRestoreUpsell = () => {
      if (
        /\/gp\/.*attach|attach-warranty|warranty|protection|service-plan/i.test(
          location.href
        )
      ) {
        return true;
      }

      if (
        document.querySelector(
          "input[type='radio']#attachSiNoCoverage, " +
            "input[type='radio']#siNoCoverage, " +
            "input[type='radio'][name='attachSiCoverageName'], " +
            "input[name='submit.attach-warranty-handler-no-warranty'], " +
            "input[name='submit.attach-sidesheet-no-coverage'], " +
            "input[name='submit.add-to-cart-no-warranty']"
        )
      ) {
        return true;
      }

      const text = (document.body && document.body.innerText
        ? document.body.innerText
        : ""
      ).toLowerCase();
      return (
        (text.includes("protection plan") ||
          text.includes("protect your purchase") ||
          text.includes("warranty")) &&
        (text.includes("no thanks") ||
          text.includes("add protection") ||
          text.includes("coverage"))
      );
    };

    const setQuantity = () => {
      if (qty <= 1) return;
      const qEl = findFirst(QTY_SELECTORS);
      if (!qEl) return;
      const target = String(qty);
      if (qEl.tagName === "SELECT") {
        const opts = Array.from(qEl.options || []);
        const match = opts.find((o) => o.value === target);
        if (match) {
          qEl.value = target;
          qEl.dispatchEvent(new Event("change", { bubbles: true }));
        }
        // If qty exceeds the dropdown's max (e.g., 30), Amazon usually
        // exposes a free-text input via the "10+" / "Quantity" option.
        // We accept whatever the dropdown caps at — better than failing.
      } else {
        qEl.value = target;
        qEl.dispatchEvent(new Event("input", { bubbles: true }));
        qEl.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };

    const tryClick = (attempt) => {
      const btn = findFirst(ATC_SELECTORS);
      if (!btn) {
        if (attempt < 30) {
          setTimeout(() => tryClick(attempt + 1), 500);
        } else {
          resolve({
            ok: false,
            error: "Add to Cart button not found or not visible",
            url: location.href,
            title: document.title || "",
          });
        }
        return;
      }

      // Some buttons are disabled until the page finishes hydrating.
      if (btn.disabled || btn.getAttribute("aria-disabled") === "true") {
        if (attempt < 30) {
          setTimeout(() => tryClick(attempt + 1), 500);
          return;
        }
        resolve({
          ok: false,
          error: "Add to Cart button stayed disabled",
          url: location.href,
          title: document.title || "",
        });
        return;
      }

      setQuantity();
      try {
        // Tell our own ATC intercept (observer.js) to let this click
        // pass through untouched. We're in the middle of a restore;
        // the item is meant to go to Amazon's live cart, not back into
        // a saved cart. The flag is consumed by the intercept listener
        // on the next click.
        try { btn.dataset.styxBypass = "1"; } catch (_e) { /* not an HTMLElement */ }
        btn.click();
      } catch (e) {
        resolve({ ok: false, error: "click threw: " + String(e) });
        return;
      }

      // Resolve IMMEDIATELY after the click — before yielding to the event
      // loop — so that any page navigation triggered by the click cannot
      // destroy this script's context before executeScript collects the result.
      // Post-click waiting and upsell detection are handled externally in
      // restoreCart using a pre-wired navigation monitor.
      resolve({ ok: true });
    };

    // Wait for the doc to be in a ready-ish state.
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => tryClick(0), {
        once: true,
      });
    } else {
      tryClick(0);
    }
  });
}

function pageHasRestoreUpsell() {
  if (
    /\/gp\/.*attach|attach-warranty|warranty|protection|service-plan/i.test(
      location.href
    )
  ) {
    return true;
  }

  if (
    document.querySelector(
      "input[type='radio']#attachSiNoCoverage, " +
        "input[type='radio']#siNoCoverage, " +
        "input[type='radio'][name='attachSiCoverageName'], " +
        "input[name='submit.attach-warranty-handler-no-warranty'], " +
        "input[name='submit.attach-sidesheet-no-coverage'], " +
        "input[name='submit.add-to-cart-no-warranty']"
    )
  ) {
    return true;
  }

  const text = (document.body && document.body.innerText
    ? document.body.innerText
    : ""
  ).toLowerCase();
  return (
    (text.includes("protection plan") ||
      text.includes("protect your purchase") ||
      text.includes("warranty")) &&
    (text.includes("no thanks") ||
      text.includes("add protection") ||
      text.includes("coverage"))
  );
}

/**
 * Runs in the page context via chrome.scripting.executeScript.
 * Creates or updates a floating status toast in the bottom-right corner.
 * Self-contained — no closures, no imports, no content.js dependency.
 *
 * @param {string} message
 * @param {'loading'|'done'|'error'} type
 *   loading: amber with spinner  (persists until next update)
 *   done:    green with checkmark (auto-dismisses after 4 s)
 *   error:   red with warning     (auto-dismisses after 5 s)
 */
function pageShowStatus(message, type, theme, placement) {
  var ID = '__styx-status-toast';
  var toast = document.getElementById(ID);
  if (!toast) {
    toast = document.createElement('div');
    toast.id = ID;
    (document.body || document.documentElement).appendChild(toast);
  }

  // Inject keyframes + animation classes once per page.
  if (!document.getElementById('__styx-kf')) {
    var s = document.createElement('style');
    s.id = '__styx-kf';
    // Three carts cycle through triangle vertices:
    //   TOP  ≈ (15.5, 10.2)   BL ≈ (7.5, 16)   BR ≈ (24.5, 16)
    // Each cart visits all 3 vertices; offset by 1/3 of the 2.4s cycle.
    s.textContent =
      '@keyframes _styxCartA{' +
        '0%,100%{transform:translate(0,0)}' +
        '33%{transform:translate(9px,5.8px)}' +
        '66%{transform:translate(-8px,5.8px)}' +
      '}' +
      '@keyframes _styxCartB{' +
        '0%,100%{transform:translate(0,0)}' +
        '33%{transform:translate(8px,-5.8px)}' +
        '66%{transform:translate(17px,0)}' +
      '}' +
      '@keyframes _styxCartC{' +
        '0%,100%{transform:translate(0,0)}' +
        '33%{transform:translate(-17px,0)}' +
        '66%{transform:translate(-9px,-5.8px)}' +
      '}' +
      '.__styx-toast-loading .__styx-cart-a{animation:_styxCartA 2.4s ease-in-out infinite;transform-box:fill-box;transform-origin:center}' +
      '.__styx-toast-loading .__styx-cart-b{animation:_styxCartB 2.4s ease-in-out infinite;transform-box:fill-box;transform-origin:center}' +
      '.__styx-toast-loading .__styx-cart-c{animation:_styxCartC 2.4s ease-in-out infinite;transform-box:fill-box;transform-origin:center}' +
      '@keyframes _styxFadeIn{from{opacity:0;transform:translate(-50%,-50%) scale(.6)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}';
    (document.head || document.body || document.documentElement).appendChild(s);
  }

  var isDark =
    theme === 'dark' ||
    (theme !== 'light' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  var accent = type === 'done' ? '#34d399' : type === 'error' ? '#ef4444' : '#ff9900';
  var glowRgb = type === 'done' ? '52,211,153' : type === 'error' ? '239,68,68' : '255,153,0';
  var bg = isDark ? '#131a22' : '#ffffff';
  var fg = isDark ? '#ffffff' : '#131a22';
  var shadow = isDark
    ? '0 0 0 1px ' + accent + ', 0 0 24px rgba(' + glowRgb + ',.35), 0 6px 24px rgba(0,0,0,.45)'
    : '0 0 0 1px ' + accent + ', 0 0 18px rgba(' + glowRgb + ',.22), 0 6px 24px rgba(15,17,21,.18)';

  var ts = toast.style;
  // Placement follows the UI surface (passed from showStatus): the side panel
  // docks beside the page so a top toast is uncovered and more visible; a popup
  // drops from the toolbar over the top of the page, so there the toast sits at
  // the bottom. The top offset clears Amazon's sticky header.
  ts.position = 'fixed'; ts.left = '50%';
  ts.transform = 'translateX(-50%)'; ts.right = '';
  if (placement === 'top') {
    ts.top = '72px'; ts.bottom = '';
  } else {
    ts.bottom = '24px'; ts.top = '';
  }
  ts.zIndex = '2147483647';
  ts.display = 'flex'; ts.alignItems = 'center'; ts.gap = '14px';
  ts.padding = '16px 22px'; ts.borderRadius = '14px';
  ts.border = '1px solid ' + accent;
  ts.background = bg; ts.color = fg;
  ts.fontFamily = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
  ts.fontSize = '18px'; ts.fontWeight = '600'; ts.lineHeight = '1.35';
  ts.boxShadow = shadow;
  ts.maxWidth = '720px'; ts.width = ''; ts.pointerEvents = 'none';
  ts.opacity = '1'; ts.transition = 'opacity .2s, box-shadow .25s, border-color .25s';

  toast.className = type === 'loading' ? '__styx-toast-loading' : '';

  if (toast._styxTimer) { clearTimeout(toast._styxTimer); toast._styxTimer = null; }

  // Styx logo (carts + river) — copied from popup.html, with class hooks
  // on each cart's <g> and its wheels for the cycling animation.
  var logoSvg =
    '<svg width="36" height="36" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block">' +
      '<rect width="32" height="32" rx="7" fill="' + bg + '"/>' +
      // Top cart (apex)
      '<g class="__styx-cart-a">' +
        '<g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none">' +
          '<path d="M12 8.6 L19 8.6 L18.3 11.8 L12.7 11.8 Z"/>' +
          '<path d="M12 8.6 L10.5 7.3"/>' +
        '</g>' +
        '<circle cx="13.7" cy="13.3" r="0.9" fill="#ff9900"/>' +
        '<circle cx="17.3" cy="13.3" r="0.9" fill="#ff9900"/>' +
      '</g>' +
      // Bottom-left cart
      '<g class="__styx-cart-b">' +
        '<g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none">' +
          '<path d="M4 14.4 L11 14.4 L10.3 17.6 L4.7 17.6 Z"/>' +
          '<path d="M4 14.4 L2.5 13.1"/>' +
        '</g>' +
        '<circle cx="5.9" cy="19.1" r="0.9" fill="#ff9900"/>' +
        '<circle cx="9.1" cy="19.1" r="0.9" fill="#ff9900"/>' +
      '</g>' +
      // Bottom-right cart
      '<g class="__styx-cart-c">' +
        '<g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none">' +
          '<path d="M21 14.4 L28 14.4 L27.3 17.6 L21.7 17.6 Z"/>' +
          '<path d="M21 14.4 L19.5 13.1"/>' +
        '</g>' +
        '<circle cx="22.9" cy="19.1" r="0.9" fill="#ff9900"/>' +
        '<circle cx="26.1" cy="19.1" r="0.9" fill="#ff9900"/>' +
      '</g>' +
      // River Styx
      '<path d="M0 19.8 Q 4 18.4, 8 19.8 T 16 19.8 T 24 19.8 T 32 19.8 L 32 32 L 0 32 Z" fill="#1a3a5c" opacity="0.55"/>' +
      '<path d="M0 19.8 Q 4 18.4, 8 19.8 T 16 19.8 T 24 19.8 T 32 19.8" stroke="#5db5ff" stroke-width="1" fill="none" stroke-linecap="round"/>' +
      '<path d="M0 23 Q 4 22, 8 23 T 16 23 T 24 23 T 32 23" stroke="#5db5ff" stroke-width="0.8" fill="none" stroke-linecap="round" opacity="0.55"/>' +
      '<path d="M0 25.9 Q 4 25, 8 25.9 T 16 25.9 T 24 25.9 T 32 25.9" stroke="#5db5ff" stroke-width="0.7" fill="none" stroke-linecap="round" opacity="0.38"/>' +
      '<path d="M0 28.5 Q 4 27.8, 8 28.5 T 16 28.5 T 24 28.5 T 32 28.5" stroke="#5db5ff" stroke-width="0.6" fill="none" stroke-linecap="round" opacity="0.25"/>' +
    '</svg>';

  // Apex overlay glyph for done/error states.
  var overlay = '';
  if (type === 'done') {
    overlay =
      '<div style="position:absolute;left:50%;top:32%;width:18px;height:18px;transform:translate(-50%,-50%) scale(1);' +
        'background:#34d399;border-radius:50%;display:flex;align-items:center;justify-content:center;' +
        'box-shadow:0 0 8px rgba(52,211,153,.7);animation:_styxFadeIn .2s ease-out">' +
        '<svg width="12" height="12" viewBox="0 0 21 21" fill="none"><path d="M3 10.5L8.5 16L18 5" stroke="#0b1a14" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '</div>';
  } else if (type === 'error') {
    overlay =
      '<div style="position:absolute;left:50%;top:32%;width:18px;height:18px;transform:translate(-50%,-50%) scale(1);' +
        'background:#ef4444;border-radius:50%;display:flex;align-items:center;justify-content:center;' +
        'color:#fff;font-size:13px;font-weight:800;line-height:1;' +
        'box-shadow:0 0 8px rgba(239,68,68,.7);animation:_styxFadeIn .2s ease-out">!</div>';
  }

  var icon = document.createElement('div');
  icon.style.cssText = 'position:relative;flex-shrink:0;width:36px;height:36px';
  icon.innerHTML = logoSvg + overlay;

  var span = document.createElement('span');
  span.style.cssText =
    'flex:1;min-width:0;word-break:break-word;overflow-wrap:anywhere;' +
    'display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden';
  span.textContent = message;

  toast.innerHTML = '';
  toast.appendChild(icon);
  toast.appendChild(span);

  var delay = type === 'done' ? 4000 : type === 'error' ? 5000 : 0;
  if (delay) {
    toast._styxTimer = setTimeout(function() {
      toast.style.opacity = '0';
      setTimeout(function() { try { toast.remove(); } catch(_) {} }, 250);
    }, delay);
  }
}

/**
 * Runs inside the cart page context via chrome.scripting.executeScript.
 * Self-contained — no closures, no imports, no content.js dependency.
 * Keep byte-identical with the copy in lib/scrape.js (which is unit-tested).
 */
function pageGetCartCountDetailed() {
  const parseCount = (value) => {
    const n = parseInt(String(value || "").replace(/[^\d]/g, ""), 10);
    return Number.isNaN(n) ? null : n;
  };

  const activeRows = document.querySelectorAll(
    "div[data-asin][data-itemtype='active'], " +
      ".ewc-item[data-asin], " +
      "div[data-asin].sc-list-item, " +
      "div[data-asin][data-itemid]"
  );
  const liveRows = Array.from(activeRows).filter((row) => {
    const asin = row.getAttribute("data-asin");
    const itemType = (row.getAttribute("data-itemtype") || "").toLowerCase();
    if (!asin || itemType.includes("saved")) return false;
    if (row.hidden || row.getAttribute("aria-hidden") === "true") return false;
    if (
      row.classList.contains("ewc-item-deleted") ||
      row.classList.contains("sc-list-item-removed")
    ) {
      return false;
    }
    // Amazon's "Coupon Clipped" confirmation box carries data-asin +
    // data-itemid but is not a cart item — it survives on the empty-cart
    // page and would read as one phantom row.
    if (row.closest(".sc-clipcoupon, .sc-clipcoupon-container")) return false;
    return true;
  });
  // "rows" counts cart line items; "quantity" sums per-item quantities (the
  // nav badge). Callers must never compare counts across the two sources —
  // a cart holding multi-quantity items makes them diverge.
  if (liveRows.length) return { count: liveRows.length, source: "rows" };

  // An explicit cart surface with zero rows is an authoritative empty — it
  // outranks the quantity fallbacks below, because the nav badge lags behind
  // delete POSTs and keeps reporting stale non-zero counts on the
  // "Your Amazon Cart is empty" page.
  if (
    document.querySelector(".sc-your-amazon-cart-is-empty") ||
    document.querySelector("#sc-empty-cart") ||
    document.querySelector("#sc-active-cart") ||
    document.querySelector("#sc-list-body")
  ) {
    return { count: 0, source: "rows" };
  }

  const quantityEl =
    document.querySelector("#nav-cart-count") ||
    document.querySelector("#ewc-total-quantity") ||
    document.querySelector("input[name='totalCartQuantity']");
  if (quantityEl) {
    const count = parseCount(quantityEl.value || quantityEl.textContent);
    if (count != null) return { count, source: "quantity" };
  }

  const quantityText = document.querySelector(
    "#nav-flyout-ewc .ewc-quantity, #ewc-content .ewc-quantity"
  );
  if (quantityText) {
    const match = (quantityText.textContent || "").match(/\b(\d+)\s+items?\b/i);
    if (match) {
      const count = parseCount(match[1]);
      if (count != null) return { count, source: "quantity" };
    }
  }

  return null;
}

/**
 * Runs inside the cart page context via chrome.scripting.executeScript.
 * Self-contained — no closures, no imports, no content.js dependency.
 * Returns { host, capturedAt, items[] } in the same shape as scrapeCart()
 * in content.js, or { error } on failure.
 */
async function pageScrapeCart() {
  // Trigger Amazon's IntersectionObserver so it loads real image URLs.
  // Dispatching scroll/resize causes Amazon's IO to re-evaluate element
  // visibility and fire its callback, which replaces the spinner src with
  // the real CDN URL. This works even in background (hidden) tabs.
  window.dispatchEvent(new Event("scroll"));
  window.dispatchEvent(new Event("resize"));
  await new Promise((r) => setTimeout(r, 700));

  try {
    function pickBestImg(row) {
      // Amazon's cart has two <img> elements per row:
      //   1. A spinner overlay inside .sc-list-item-spinner (comes first in DOM)
      //   2. The real product image: img.sc-product-image (inside a.sc-product-link)
      // Always prefer img.sc-product-image; never fall back to the spinner img.
      function isUsable(img) {
        if (!img) return false;
        if (img.closest(".sc-list-item-spinner")) return false;
        const s = img.currentSrc || img.src || "";
        return s && !s.startsWith("data:") && !s.includes("loadIndicators") && !s.includes("transparent-pixel");
      }

      // Best candidate: the explicit product image element.
      let img = row.querySelector("img.sc-product-image");
      if (!img || !isUsable(img)) {
        // Fallback: first non-spinner img with a real URL.
        img = Array.from(row.querySelectorAll("img")).find(isUsable) || null;
      }
      if (!img) return "";

      // Prefer data-a-dynamic-image (largest variant) if present.
      const dyn = img.getAttribute("data-a-dynamic-image");
      if (dyn) {
        try {
          const map = JSON.parse(dyn);
          const urls = Object.keys(map);
          if (urls.length) {
            let best = urls[0], bestArea = 0;
            for (const u of urls) {
              const d = map[u] || [0, 0];
              const a = (d[0] || 0) * (d[1] || 0);
              if (a > bestArea) { bestArea = a; best = u; }
            }
            return best;
          }
        } catch (_e) { /* fall through */ }
      }
      // currentSrc is higher-res (from srcset negotiation) when available.
      if (img.currentSrc && !img.currentSrc.includes("loadIndicators")) return img.currentSrc;
      const src = img.src || "";
      return isUsable(img) ? src : "";
    }

    // Read the nav cart count (the badge on the cart icon in the header).
    // This is the source of truth for whether the cart has items — if it
    // says > 0 but we find 0 rows, the page isn't really the cart or hasn't
    // finished hydrating, and the caller knows to retry / try another tab.
    function readNavCartCount() {
      const candidates = [
        document.getElementById("nav-cart-count"),
        document.getElementById("ewc-total-quantity"),
        document.querySelector("#nav-cart .nav-cart-count"),
      ];
      for (const el of candidates) {
        if (!el) continue;
        const t = (el.textContent || el.value || "").trim();
        const n = parseInt(t.replace(/[^\d]/g, ""), 10);
        if (Number.isFinite(n)) return n;
      }
      return null;
    }
    const navCartCount = readNavCartCount();

    const activeScope =
      document.querySelector("[data-name='Active Items']") ||
      document.querySelector("#sc-active-cart") ||
      document.querySelector("#ewc-content") ||
      document.querySelector("#nav-flyout-ewc") ||
      document.body;

    // Try selectors from most specific (typed active rows) to most permissive,
    // so legitimate cart layouts that don't have the data-itemtype attribute
    // still match. Stop at the first selector that finds any rows.
    let rows = activeScope.querySelectorAll(
      "div[data-asin][data-itemtype='active'], li[data-asin][data-itemtype='active']"
    );
    if (!rows.length) {
      rows = activeScope.querySelectorAll(
        "div[data-asin].sc-list-item, li[data-asin].sc-list-item, li[data-asin].ewc-item"
      );
    }
    if (!rows.length) {
      // Last-ditch: any element carrying a real ASIN that isn't explicitly
      // marked as Save-For-Later. Filtering happens in the loop below.
      rows = activeScope.querySelectorAll("[data-asin]");
    }

    const items = [];
    const seen = new Set();

    rows.forEach((row) => {
      const asin = row.getAttribute("data-asin");
      if (!asin || seen.has(asin)) return;
      // Skip Save For Later items
      const itemtype = (row.getAttribute("data-itemtype") || "").toLowerCase();
      if (itemtype === "saved") return;
      seen.add(asin);

      const titleEl =
        row.querySelector(".sc-product-title .a-truncate-full") ||
        row.querySelector(".sc-product-title") ||
        row.querySelector("span.a-truncate-full") ||
        row.querySelector("a.sc-product-link span");
      const title = titleEl ? titleEl.textContent.trim() : "(unknown title)";

      let quantity = 1;
      const qSel = row.querySelector("select[name='quantity']");
      const qInp = row.querySelector("input[name='quantityBox']");
      const qSpan = row.querySelector(".a-dropdown-prompt");
      if (qSel && qSel.value) quantity = parseInt(qSel.value, 10) || 1;
      else if (qInp && qInp.value) quantity = parseInt(qInp.value, 10) || 1;
      else if (qSpan && qSpan.textContent) {
        const n = parseInt(qSpan.textContent.trim(), 10);
        if (!Number.isNaN(n)) quantity = n;
      }

      const priceEl =
        row.querySelector(".sc-product-price") ||
        row.querySelector(".a-price .a-offscreen") ||
        row.querySelector("span.a-price-whole");
      const price = priceEl ? priceEl.textContent.trim() : "";

      const image = pickBestImg(row);

      const linkEl = row.querySelector("a.sc-product-link, a[href*='/dp/']");
      const url = linkEl ? new URL(linkEl.href, location.origin).href : "";

      items.push({ asin, title, quantity, price, image, url });
    });

    return {
      host: location.hostname,
      capturedAt: new Date().toISOString(),
      items,
      navCartCount,
    };
  } catch (err) {
    return {
      error: String(err && err.message) || String(err),
      host: location.hostname,
      capturedAt: new Date().toISOString(),
      items: [],
      navCartCount: null,
    };
  }
}

// ---- Amazon list (wish list) sync -----------------------------------------
//
// Mirror a saved cart into an Amazon wish list so it follows the user across
// devices, and pull the user's existing lists back into the popup. The READ
// paths (list discovery, single-list import) reuse the proven wishlist
// selectors from observer.js and are reliable. The WRITE paths (create list,
// add item, set quantity) drive Amazon's DOM best-effort; their selectors are
// defensive but should be confirmed against live traffic (see the "endpoint
// spike" note in the feature plan) and they fail loud rather than silently.

const AMAZON_LISTS_PATH = "/hz/wishlist/ls";
const AMAZON_LIST_READ_CACHE_MS = 5 * 60 * 1000;
const amazonListReadCache = new Map();

/**
 * Open a silent background tab at `url`, wait for it to load, run `fn(tabId)`,
 * then close the tab (unless keepOpen). Mirrors the tab strategy in
 * scrapeCartInBackground but factored out for the list flows.
 */
async function runInAmazonTab(url, fn, { timeoutMs = 20000, keepOpen = false } = {}) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabReload(tab.id, timeoutMs);
    return await fn(tab.id, tab);
  } finally {
    if (!keepOpen) {
      try { await chrome.tabs.remove(tab.id); } catch (_e) { /* already gone */ }
    }
  }
}

/** Scrape the user's wish lists from the "Your Lists" index page. */
async function listAmazonLists(preferredHost) {
  const host = preferredHost || (await inferAmazonHost());
  const url = `https://${host}${AMAZON_LISTS_PATH}`;
  const data = await runInAmazonTab(
    url,
    async (tabId) => {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: pageScrapeAmazonLists,
      });
      return (res && res[0] && res[0].result) || { lists: [] };
    },
    { timeoutMs: 12000 }
  );
  if (data.error) throw new Error(data.error);
  return (data.lists || []).map((l) => ({
    listId: l.listId,
    name: l.name,
    count: l.count,
    url: l.listId ? amazonListUrl(host, l.listId) : l.url,
    kind: l.kind || "custom",
  }));
}

/** True if `listId` still appears among the user's lists. */
async function amazonListExists(host, listId) {
  const lists = await listAmazonLists(host).catch(() => []);
  return lists.some((l) => l.listId === listId);
}

/** Read a single wish list's items, shaped like saved-cart items. */
async function readAmazonList(listId, preferredHost, forceRefresh = false) {
  const host = preferredHost || (await inferAmazonHost());
  const cacheKey = `${host}:${listId}`;
  const cached = amazonListReadCache.get(cacheKey);
  if (
    !forceRefresh &&
    cached &&
    Date.now() - cached.cachedAt < AMAZON_LIST_READ_CACHE_MS
  ) {
    return cached.value;
  }
  const url = amazonListUrl(host, listId);
  const data = await runInAmazonTab(
    url,
    async (tabId) => {
      // Lists lazy-load on scroll; give the first paint a beat before scraping.
      await sleep(900);
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: pageScrapeSingleList,
      });
      return (res && res[0] && res[0].result) || { items: [] };
    },
    { timeoutMs: 15000 }
  );
  if (data.error) throw new Error(data.error);
  const items = (data.items || [])
    .filter((it) => it && it.asin)
    .map((it) => ({
      asin: String(it.asin).toUpperCase(),
      title: it.title || "(untitled)",
      quantity: Math.max(1, Math.min(99, Number(it.quantity) || 1)),
      price: "",
      image: it.image || "",
      url: it.url || `https://${host}/dp/${it.asin}`,
      variantLabel: "",
      unavailable: it.unavailable === true,
      unavailableReason: it.unavailableReason || "",
    }));
  const value = { host, name: data.name || "Amazon list", listId, url, items };
  amazonListReadCache.set(cacheKey, { cachedAt: Date.now(), value });
  return value;
}

/** Read a list for the legacy local-cart import flow. */
async function importAmazonListToCart(listId, preferredHost) {
  return readAmazonList(listId, preferredHost);
}

/**
 * Create a new wish list named `name` by driving the create-and-add modal on
 * the FIRST item's product page. This is the only create path Amazon accepts
 * from script (validated live 2026-07-10/11):
 *   - lists-page create modal: Create click + form.submit() both dead-end
 *     ("Page Not Found") — trusted-only.
 *   - PDP chooser → "Create a List" modal: fully synthetic-drivable; its
 *     Create fires POST /hz/wishlist/create/newlist (with asin) → 200, so the
 *     list is created AND the PDP's item is added in one step.
 * Returns { listId, listUrl, firstItemAdded: true } or throws.
 */
async function createAmazonListFromPdp(host, name, firstAsin) {
  const url = `https://${host}/dp/${String(firstAsin).toUpperCase()}`;
  const res = await runInAmazonTab(
    url,
    async (tabId) => {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: pageCreateListAndAdd,
        args: [name],
      });
      return (r && r[0] && r[0].result) || { ok: false, error: "no result from pageCreateListAndAdd" };
    },
    { keepOpen: false, timeoutMs: 40000 }
  );
  console.log("[Styx list-sync] createListFromPdp →", res);
  try {
    await chrome.storage.local.set({ "mc.debug.lastCreateList": { at: Date.now(), via: "pdp-create-and-add", ...res } });
  } catch (_e) { /* non-fatal */ }
  if (!res.ok) {
    throw new Error("Couldn't create the Amazon list: " + (res.error || "the create form couldn't be driven."));
  }
  // The confirmation usually carries a View List link with the new id. If it
  // didn't, resolve the id by name from the lists index (read-only, reliable).
  let listId = res.listId || null;
  if (!listId) listId = await findAmazonListIdByName(host, name);
  if (!listId) {
    throw new Error(
      'List "' + name + '" was created (first item added) but its id could not be read back. Open Your Lists and re-run Save to link it.'
    );
  }
  return { listId, listUrl: amazonListUrl(host, listId), firstItemAdded: true };
}

/** Resolve a list id by exact name from the Your Lists index page. */
async function findAmazonListIdByName(host, name) {
  const url = `https://${host}${AMAZON_LISTS_PATH}`;
  return await runInAmazonTab(
    url,
    async (tabId) => {
      const f = await chrome.scripting.executeScript({
        target: { tabId },
        func: pageFindListByName,
        args: [name],
      });
      const fr = f && f[0] && f[0].result;
      return (fr && fr.listId) || null;
    },
    { keepOpen: false, timeoutMs: 15000 }
  );
}

/** Add one product to a wish list by driving the product page's Add-to-List. */
async function addItemToList(host, listId, asin) {
  const url = `https://${host}/dp/${String(asin).toUpperCase()}`;
  return await runInAmazonTab(
    url,
    async (tabId) => {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: pageAddToList,
        args: [listId],
      });
      return (r && r[0] && r[0].result) || { ok: false, error: "no result" };
    },
    { timeoutMs: 15000 }
  );
}

/** Best-effort pass to set desired quantities on a list (qty>1 items only). */
async function setListQuantities(host, listId, items) {
  const map = {};
  for (const it of items) {
    const q = Math.max(1, Math.min(99, Number(it.quantity) || 1));
    if (q > 1) map[String(it.asin).toUpperCase()] = q;
  }
  if (!Object.keys(map).length) return;
  const url = amazonListUrl(host, listId);
  await runInAmazonTab(
    url,
    async (tabId) => {
      await sleep(900);
      await chrome.scripting.executeScript({
        target: { tabId },
        func: pageSetListQuantities,
        args: [map],
      });
    },
    { timeoutMs: 15000 }
  );
}

/**
 * Orchestrate "save this cart to an Amazon list": create-or-reuse the list,
 * add every item, set quantities, then stamp the link onto the cart. Tolerant
 * of partial failure — reports added/failed counts.
 */
async function saveCartToAmazonList(cart, opts = {}) {
  // Saving drives one product page per item to feed Amazon's Add-to-List
  // chooser — many sequential navigations. Suppress the floating window's
  // auto-reopen for the duration (same rationale as clearAmazonCart).
  await setUiBusy(true);
  try {
    return await saveCartToAmazonListImpl(cart, opts);
  } finally {
    await setUiBusy(false);
  }
}

async function saveCartToAmazonListImpl(cart, opts = {}) {
  const host = cart.host || "www.amazon.com";
  const items = (cart.items || []).filter((it) => it && it.asin);
  if (!items.length) return { ok: false, error: "This cart has no items to save." };

  const label = cart.name ? `"${cart.name}"` : "cart";
  // Progress fans out to both the floating status window and (when the caller
  // supplies a tab) an on-page Styx toast on the initiating tab.
  const progressTabId = opts.progressTabId != null ? opts.progressTabId : null;
  const report = (detail, extra = {}) => {
    setOpStatus(`Saving ${label} to Amazon`, detail);
    notifyTab(progressTabId, { type: "MC_LIST_SAVE_PROGRESS", detail, ...extra });
  };
  report("Preparing your list…");

  // 1. Ensure a target list exists (reuse a prior link if it still exists).
  //    A brand-new list is created from the FIRST item's product page via the
  //    chooser's create-and-add modal — the only scriptable create path — so
  //    creating the list also adds item #1.
  const asins = items.map((it) => String(it.asin).toUpperCase());
  const total = items.length;
  let added = 0;
  let failures = [];
  let startIdx = 0;
  let listId = cart.amazonListId || null;
  if (listId && !(await amazonListExists(host, listId).catch(() => false))) {
    listId = null; // the linked list was deleted on Amazon — recreate it.
  }
  if (!listId) {
    report("Creating your list…", { done: 0, total });
    const created = await createAmazonListFromPdp(host, cart.name || "Styx cart", asins[0]);
    listId = created.listId;
    if (created.firstItemAdded) {
      added++;
      startIdx = 1;
    }
  }
  const listUrl = amazonListUrl(host, listId);
  console.log("[Styx list-sync] target listId =", listId, "host =", host, "items =", total);

  // 2. Add the remaining items by driving Amazon's own Add-to-List chooser on
  //    each item's product page. Validated 2026-07-10: synthetic clicks drive
  //    the chooser end-to-end, while the raw additemtolist fetch 403s from
  //    extension code but succeeds when fired by Amazon's own row handler.
  //    One tab per item; slow but it's the only write path Amazon accepts.
  for (let i = startIdx; i < asins.length; i++) {
    const asin = asins[i];
    report(`Adding item ${i + 1} of ${total}…`, { done: i, total });
    try {
      const r = await addItemToList(host, listId, asin);
      if (r && r.ok) added++;
      else failures.push({ asin, error: (r && r.error) || "add failed" });
    } catch (e) {
      failures.push({ asin, error: String((e && e.message) || e) });
    }
  }

  // 3. Best-effort desired-quantity pass. Degrades to qty 1 if Amazon's list
  //    UI doesn't expose an inline quantity input.
  try { await setListQuantities(host, listId, items); } catch (_e) { /* non-fatal */ }

  // 4. Persist the list link so re-saving updates instead of duplicating.
  //    Only stamp syncedAt (which drives the "Synced" badge) when something
  //    actually landed — a 0-item save must not masquerade as synced.
  const carts = await readCarts();
  const target = carts.find((c) => c.id === cart.id);
  if (target) {
    target.amazonListId = listId;
    target.amazonListUrl = listUrl;
    if (added > 0) target.syncedAt = Date.now();
    await writeCarts(carts);
  }

  const firstFail = failures[0];
  const reason =
    added === 0
      ? (firstFail ? "First error: " + firstFail.error : "Nothing was added.")
      : "";
  console.log("[Styx list-sync] saveCart done", {
    listId, added, total: items.length, failed: failures.length, reason,
  });

  return {
    ok: added > 0,
    listId,
    listUrl,
    added,
    failed: failures.length,
    total: items.length,
    failures,
    error: added === 0 ? reason : undefined,
  };
}

// ---- Amazon list page-context scrapers/drivers ----------------------------
// These run in the Amazon page via chrome.scripting.executeScript, so they
// must be fully self-contained (no references to worker-scope helpers).

/** Scrape wish lists from the "Your Lists" index. Returns { lists, error? }. */
function pageScrapeAmazonLists() {
  try {
    const out = [];
    const seen = new Set();
    const anchors = document.querySelectorAll(
      'a[href*="/wishlist/ls/"], a[href*="/registry/wishlist/"]'
    );
    anchors.forEach((a) => {
      const href = a.getAttribute("href") || "";
      // Keep the modern and legacy URL shapes separate. The former optional
      // `(?:ls/)?` expression could backtrack and misread navigation URLs as
      // list ids (`/ls/` -> "ls", `/ls/ref=...` -> "ref"). Real Amazon list
      // ids are at least seven alphanumeric characters.
      const m =
        href.match(/\/hz\/wishlist\/ls\/([A-Z0-9]{7,})(?:[/?#]|$)/i) ||
        href.match(/\/gp\/registry\/wishlist\/([A-Z0-9]{7,})(?:[/?#]|$)/i);
      const id = m ? m[1].toUpperCase() : null;
      if (!id || seen.has(id)) return;

      // A list-row anchor contains status labels such as "Default List" and
      // "Public". Prefer the dedicated title child so those badges do not
      // become part of the name shown in the extension.
      const titleEl = a.querySelector(
        "[data-list-name], .wl-list-entry-title, .a-size-base-plus, .a-text-bold"
      );
      let name = (
        a.getAttribute("data-list-name") ||
        (titleEl && (titleEl.getAttribute("data-list-name") || titleEl.textContent)) ||
        a.textContent ||
        ""
      )
        .trim()
        .replace(/\s+/g, " ");
      // Defensive fallback for alternate list-row markup without a title
      // class. Strip only trailing Amazon status badges.
      for (let i = 0; i < 3; i++) {
        name = name.replace(/\s+(?:Default List|Public|Private|Shared)\s*$/i, "").trim();
      }
      if (!name || name.length > 120) return; // skip icon-only / chrome anchors
      seen.add(id);
      // Classify the list so tier-gating can exclude Amazon's own defaults.
      // "Default List" badge → the account default Wish List; a "Shopping List"
      // name → the Alexa list. Everything else is a user-created custom cart.
      // (Badge lives in the anchor's raw text, alongside the title we cleaned.)
      // Note: Amazon badges concatenate without spaces ("Default ListPublic"),
      // so no trailing word boundary here.
      let kind = "custom";
      if (/\bDefault List/i.test(a.textContent || "")) {
        kind = "default";
      } else if (/^(?:alexa\s+)?shopping list$/i.test(name)) {
        kind = "alexa";
      }
      out.push({
        listId: id,
        name,
        url: location.origin + "/hz/wishlist/ls/" + id,
        count: null,
        kind,
      });
    });
    return { lists: out };
  } catch (e) {
    return { lists: [], error: String((e && e.message) || e) };
  }
}

/** Scrape one wish list's items. Returns { name, items, error? }. */
function pageScrapeSingleList() {
  return (async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const startY = window.scrollY;
    try {
      // Amazon lazy-loads long lists. Walk toward the bottom until the page
      // height settles, with a hard cap so one pathological list cannot hold
      // the extension open indefinitely.
      let stablePasses = 0;
      let lastHeight = 0;
      for (let pass = 0; pass < 20 && stablePasses < 3; pass++) {
        const height = Math.max(
          document.body ? document.body.scrollHeight : 0,
          document.documentElement ? document.documentElement.scrollHeight : 0
        );
        window.scrollTo(0, height);
        await sleep(250);
        const nextHeight = Math.max(
          document.body ? document.body.scrollHeight : 0,
          document.documentElement ? document.documentElement.scrollHeight : 0
        );
        stablePasses = nextHeight <= lastHeight ? stablePasses + 1 : 0;
        lastHeight = nextHeight;
      }

    const nameEl = document.getElementById("profile-list-name");
    const name = nameEl ? (nameEl.textContent || "").trim() : "";
    const items = [];
    const seen = new Set();
    const lis = document.querySelectorAll(
      "ul#g-items li[data-id], ol#g-items li[data-id], " +
        "#g-items li[data-itemid], li.g-item-sortable, li[data-id][data-itemid]"
    );
    lis.forEach((li) => {
      const link = li.querySelector(
        'a[href*="/dp/"], a[href*="/gp/product/"], a[href*="/gp/aw/d/"]'
      );
      let asin = null;
      if (link) {
        const m = (link.getAttribute("href") || "").match(
          /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i
        );
        asin = m ? m[1].toUpperCase() : null;
      }
      if (!asin || seen.has(asin)) return;
      seen.add(asin);

      let title = "";
      const tEl = li.querySelector('[id^="itemName_"]') || link;
      if (tEl) {
        title = (tEl.getAttribute("title") || tEl.textContent || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 200);
      }

      let qty = 1;
      const qEl = li.querySelector('[id^="itemRequested_"]');
      if (qEl) {
        const n = parseInt(String(qEl.textContent || "").replace(/\D+/g, ""), 10);
        if (n > 0) qty = Math.min(n, 99);
      }

      let image = "";
      const img = li.querySelector("img");
      if (img) image = img.currentSrc || img.src || "";

      const rowText = (li.innerText || li.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      const unavailableMatch = rowText.match(
        /(?:this item is )?(?:currently unavailable|no longer available|not available for purchase|item is unavailable)/i
      );

      items.push({
        asin,
        title,
        quantity: qty,
        url: location.origin + "/dp/" + asin,
        image,
        unavailable: !!unavailableMatch,
        unavailableReason: unavailableMatch ? unavailableMatch[0] : "",
      });
    });
      window.scrollTo(0, startY);
      return { name, items };
    } catch (e) {
      window.scrollTo(0, startY);
      return { name: "", items: [], error: String((e && e.message) || e) };
    }
  })();
}

/**
 * Create a list (and add THIS page's product to it) by driving the PDP
 * chooser's "Create a List" modal. Validated live 2026-07-10/11:
 *   - synthetic caret click opens the multi-list chooser
 *   - synthetic click on #atwl-dd-create-list opens the create modal
 *   - fill input[name="list-name"] + synthetic click on the Create submit
 *     (aria-labelledby="lists-desktop-create-list-label"; Cancel renders
 *     FIRST in DOM, so never generic-match a submit) fires Amazon's own
 *     POST /hz/wishlist/create/newlist (with asin) → 200: list created AND
 *     this item added.
 * NOTE: the modal is position:fixed, so offsetParent is null on its
 * elements — test visibility with getBoundingClientRect(), never offsetParent.
 * Returns { ok, listId?, confirmed, error? }.
 */
function pageCreateListAndAdd(name) {
  return (async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (el) => !!(el && el.getBoundingClientRect().width > 0);
    const idsOnPage = () =>
      new Set(
        [...document.querySelectorAll('a[href*="/wishlist/ls/"]')]
          .map((a) => ((a.getAttribute("href") || "").match(/\/wishlist\/ls\/([A-Z0-9]{8,})/i) || [])[1])
          .filter(Boolean)
      );
    try {
      // 1. Open the chooser (may already be open from a retry).
      let createLink = document.getElementById("atwl-dd-create-list");
      if (!visible(createLink)) {
        const caret =
          document.getElementById("add-to-wishlist-button") ||
          document.querySelector("#wishlistButtonStack .a-button-splitdropdown input") ||
          document.getElementById("wishListDropDown");
        if (!caret) return { ok: false, error: "Add-to-List dropdown not found on this page." };
        caret.click();
        for (let i = 0; i < 20; i++) {
          await sleep(250);
          createLink = document.getElementById("atwl-dd-create-list");
          if (visible(createLink)) break;
        }
      }
      if (!visible(createLink)) return { ok: false, error: "Create-a-List entry not found in the chooser." };

      const preIds = idsOnPage();

      // 2. Open the create modal and name the list.
      createLink.click();
      let input = null;
      for (let i = 0; i < 24; i++) {
        await sleep(250);
        input = document.querySelector('input#list-name, input[name="list-name"]');
        if (visible(input)) break;
      }
      if (!visible(input)) return { ok: false, error: "Create-list form did not appear." };
      // Let Amazon's a-declarative bind the modal's handlers before we drive
      // it — clicking Create before binding silently no-ops (seen live).
      await sleep(800);
      input.focus();
      input.value = name;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));

      // 3. Click the real Create control (never the Cancel that precedes it).
      //    Retry the click: if the handler wasn't bound yet the modal stays
      //    open with no confirmation, and a later click lands (seen live).
      const scope = input.form || document;
      const create = scope.querySelector(
        'input[type="submit"][aria-labelledby="lists-desktop-create-list-label"], ' +
          '.create-list-create-button input[type="submit"], ' +
          '.create-list-create-button [type="submit"]'
      );
      if (!create) return { ok: false, error: "Create button not found in the create-list form." };

      // 4. Confirmation: "1 item added to <name>" plus a View List link whose
      //    href carries the NEW list id (absent from the pre-click set).
      let confirmed = false;
      for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
        create.click();
        for (let i = 0; i < 10; i++) {
          await sleep(400);
          if (/item added to/i.test(document.body.innerText || "")) { confirmed = true; break; }
          // Modal gone without a toast — assume the submit landed and move on.
          if (!visible(input)) break;
        }
        if (!confirmed && !visible(input)) break;
      }
      let listId = null;
      for (let i = 0; i < 8 && !listId; i++) {
        for (const id of idsOnPage()) {
          if (!preIds.has(id)) { listId = id; break; }
        }
        if (!listId) await sleep(400);
      }
      if (!confirmed && !listId) return { ok: false, error: "No confirmation after clicking Create." };
      return { ok: true, listId, confirmed };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  })();
}

/** Find a list id by exact name, or off the current URL after a create. */
function pageFindListByName(name) {
  try {
    const here = location.pathname.match(/\/hz\/wishlist\/ls\/([A-Z0-9]+)/i);
    if (here) return { listId: here[1] };
    const want = String(name || "").trim().toLowerCase();
    const anchors = document.querySelectorAll(
      'a[href*="/wishlist/ls/"], a[href*="/registry/wishlist/"]'
    );
    for (const a of anchors) {
      const m = (a.getAttribute("href") || "").match(
        /\/(?:hz\/wishlist|gp\/registry\/wishlist)\/(?:ls\/)?([A-Z0-9]+)/i
      );
      if (!m) continue;
      const t = (a.textContent || "").trim().toLowerCase();
      if (t && t === want) return { listId: m[1] };
    }
    return { listId: null };
  } catch (e) {
    return { listId: null, error: String((e && e.message) || e) };
  }
}

/**
 * Drive a product page's "Add to List" dropdown to add to a specific list.
 *
 * Validated live (2026-07-10): a SYNTHETIC click on the split-button caret
 * opens the multi-list chooser (the old trusted-click gate is gone), and a
 * synthetic click on the chooser row `#atwl-list-name-<listId>` fires
 * Amazon's own POST /hz/wishlist/additemtolist → 200 and the item lands.
 * The same POST fired directly via fetch from an extension context returns
 * 403, so DOM-driving Amazon's handler is the only working write path.
 */
function pageAddToList(listId) {
  return (async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const rowSel = "#atwl-list-name-" + listId;
    const findRow = () => {
      const el = document.querySelector(rowSel);
      return el && el.getBoundingClientRect().width > 0 ? el : null;
    };
    try {
      // The chooser may already be open (e.g. a retry on the same tab).
      let row = findRow();
      if (!row) {
        const caret =
          document.getElementById("add-to-wishlist-button") ||
          document.querySelector(
            "#wishlistButtonStack .a-button-splitdropdown input"
          ) ||
          document.getElementById("wishListDropDown");
        if (!caret) {
          return { ok: false, error: "Add-to-List dropdown not found on this page." };
        }
        caret.click();
        for (let i = 0; i < 20 && !(row = findRow()); i++) await sleep(250);
      }
      if (!row) {
        return {
          ok: false,
          error: "List " + listId + " not found in the Add-to-List menu.",
        };
      }
      row.click();
      // Success signal: Amazon pops an "item added to <list>" confirmation.
      // Treat the click as the add either way — the row handler is Amazon's —
      // but report whether we saw the confirmation.
      let confirmed = false;
      for (let i = 0; i < 16; i++) {
        await sleep(250);
        const t = document.body.innerText || "";
        if (/item added to|already in your|added to your list/i.test(t)) {
          confirmed = true;
          break;
        }
      }
      return { ok: true, confirmed };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  })();
}

/** Best-effort: set desired quantities on list rows from an asin->qty map. */
function pageSetListQuantities(map) {
  try {
    const lis = document.querySelectorAll(
      "#g-items li[data-id], #g-items li[data-itemid]"
    );
    let set = 0;
    lis.forEach((li) => {
      const link = li.querySelector('a[href*="/dp/"]');
      if (!link) return;
      const m = (link.getAttribute("href") || "").match(/\/dp\/([A-Z0-9]{10})/i);
      if (!m) return;
      const want = map[m[1].toUpperCase()];
      if (!want) return;
      const input = li.querySelector(
        'input[name^="quantity"], input[id^="itemRequested"], input[type="number"]'
      );
      if (input) {
        input.value = String(want);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        set++;
      }
    });
    return { ok: true, set };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ---- Message router -------------------------------------------------------

// Boot marker — if you DON'T see this in the service-worker console after a
// reload, you're looking at the wrong console (Safari = "background content",
// not "service worker").
console.log("[Styx] background loaded", new Date().toISOString());

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  (async () => {
    try {
      switch (msg.type) {
        case "MC_GET_STATUS": {
          sendResponse(_opStatus || { active: false, title: "", detail: "" });
          break;
        }

        case "MC_LOG_PUSH": {
          // A content script or the popup forwarded a dev-mode log line.
          pushLogEntry(msg.entry);
          sendResponse({ ok: true });
          break;
        }

        case "MC_LOG_GET": {
          // The popup's "Copy diagnostic logs" button requests the ring.
          sendResponse({ ok: true, entries: LOG_RING.slice() });
          break;
        }

        case "MC_OBSERVE_ATC": {
          // observer.js detected an Add-to-Cart click on a product page.
          // Stash it keyed by tab id so we can link the upcoming upsell choice.
          prunePendingAtc();
          const tabId = _sender && _sender.tab && _sender.tab.id;
          if (tabId != null && msg.asin) {
            _pendingAtc.set(tabId, {
              asin: String(msg.asin).toUpperCase(),
              title: msg.title || "",
              host: msg.host || "",
              at: Date.now(),
            });
          }
          sendResponse({ ok: true });
          break;
        }

        case "MC_OBSERVE_UPSELL_CHOICE": {
          // observer.js detected a decline or accept on an upsell surface.
          // Link it back to the most recent ATC for this tab and record it.
          prunePendingAtc();
          const tabId = _sender && _sender.tab && _sender.tab.id;
          let pending = tabId != null ? _pendingAtc.get(tabId) : null;
          if (!pending) {
            // Fallback: the upsell may be in a different tab than the ATC
            // (rare but possible with sidesheet flows). Use the newest pending.
            let newest = null;
            for (const p of _pendingAtc.values()) {
              if (!newest || p.at > newest.at) newest = p;
            }
            pending = newest;
          }
          if (pending && pending.asin) {
            await recordUpsellChoice(pending.asin, {
              choice: msg.choice,
              optionLabel: msg.optionLabel || "",
              optionPrice: msg.optionPrice || "",
              optionDuration: msg.optionDuration || null,
              productHost: pending.host,
              productTitle: pending.title,
            });
            if (tabId != null) _pendingAtc.delete(tabId);
          }
          sendResponse({ ok: true });
          break;
        }

        case "MC_DIAGNOSE_CART": {
          // Navigate to the cart page (same path as clearAmazonCart) then
          // ask the content script for a diagnostic snapshot.
          const host = await inferAmazonHost();
          const cartUrl = `https://${host}/gp/cart/view.html`;
          const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
          let diagTabId;
          if (active && active.url && isAmazonUrl(active.url)) {
            diagTabId = active.id;
            if (!isAmazonCartUrl(active.url)) {
              await chrome.tabs.update(diagTabId, { url: cartUrl, active: true });
              await waitForTabComplete(diagTabId);
            }
          } else {
            const cartTabs = await chrome.tabs.query({ url: AMAZON_CART_PATTERNS });
            if (cartTabs.length) {
              diagTabId = cartTabs[0].id;
              await chrome.tabs.update(diagTabId, { active: true });
              await waitForTabComplete(diagTabId);
            } else {
              const t = await chrome.tabs.create({ url: cartUrl, active: true });
              await waitForTabComplete(t.id);
              diagTabId = t.id;
            }
          }
          const result = await sendToContent(diagTabId, { type: "MC_DIAGNOSE_CART" });
          sendResponse(result || { ok: false, error: "No response" });
          break;
        }

        case "MC_LIST_CARTS": {
          const carts = await readCarts();
          const ent = await readEntitlement();
          const now = Date.now();
          const access = computeCartAccess(carts, ent, now);
          const premium = isPremiumActive(ent, now);
          // Annotate each cart with access state so the popup can render
          // locked/read-only carts without recomputing the rule client-side.
          const annotated = carts.map((c) => ({
            ...c,
            access: access.editableIds.has(c.id) ? "editable" : "readonly",
          }));
          sendResponse({
            ok: true,
            carts: annotated,
            entitlement: {
              tier: premium ? "premium" : "free",
              premiumUntil: ent.premiumUntil,
              autoRenew: !!ent.autoRenew,
              source: ent.source,
              isPremium: premium,
              limit: access.limit,
              count: carts.length,
            },
          });
          break;
        }

        case "MC_GET_ENTITLEMENT": {
          // Convenience read for the popup's status badge / paywall trigger.
          // Returns the raw entitlement plus derived booleans and limits.
          const ent = await readEntitlement();
          const carts = await readCarts();
          const now = Date.now();
          const premium = isPremiumActive(ent, now);
          sendResponse({
            ok: true,
            entitlement: {
              tier: premium ? "premium" : "free",
              premiumUntil: ent.premiumUntil,
              autoRenew: !!ent.autoRenew,
              source: ent.source,
              lastChecked: ent.lastChecked,
              isPremium: premium,
              limit: cartLimitFor(ent, now),
              count: carts.length,
            },
          });
          break;
        }

        case "MC_DEV_SET_ENTITLEMENT": {
          // Hidden testing affordance. Gated by chrome.storage.local["mc.dev.v1"]
          // — enable manually in DevTools before use. Lets us flip between
          // free / premium / lapsed states to exercise the gating + paywall UI
          // before ExtensionPay is wired up.
          //
          // Example (in service-worker DevTools console):
          //   await chrome.storage.local.set({ "mc.dev.v1": true })
          //   await chrome.runtime.sendMessage({
          //     type: "MC_DEV_SET_ENTITLEMENT",
          //     entitlement: { tier: "premium", premiumUntil: Date.now() + 86400000 * 365 }
          //   })
          if (!(await isDevModeEnabled())) {
            sendResponse({ ok: false, error: "Dev mode is not enabled." });
            break;
          }
          // Stamp a source so the entitlement is recognizably non-ExtPay and
          // survives ExtPay syncs (see extpayUserToEntitlementPatch).
          const devEnt = Object.assign({}, msg.entitlement || {});
          if (devEnt.tier === "premium" && devEnt.source == null) {
            devEnt.source = "dev";
          }
          const next = await writeEntitlement(devEnt);
          sendResponse({ ok: true, entitlement: next });
          break;
        }

        case "MC_REDEEM_PROMO": {
          // Public, ungated: the upgrade modal exposes "Have a code?" to any user.
          // redeemPromoCode handles validation, single-use-per-device, and
          // entitlement update. Failure responses use a stable shape so the popup
          // can render the error inline.
          const result = await redeemPromoCode(msg.code);
          sendResponse(result);
          break;
        }

        case "MC_OPEN_PAYMENT_PAGE": {
          // Open ExtensionPay-hosted Stripe checkout in a new tab.
          // The popup closes itself after the call (the modal lives there).
          // If the user actually pays, extpay.onPaid fires and we re-sync.
          //
          // Optional msg.plan deep-links a specific plan's checkout via
          // openPaymentPage(nickname) → /choose-plan/<nickname>. We allowlist
          // the known nicknames (set in the extensionpay.com dashboard) so a
          // bad/renamed value can't build a broken URL — unknown/absent falls
          // back to the no-arg call, which shows ExtPay's full plan picker.
          if (IS_SAFARI) {
            // Safari buys via StoreKit in the native host app — the popup
            // launches the styxmulticart:// URL scheme directly and never
            // routes through here. Respond with a clear native signal in case
            // a caller reaches this path anyway.
            sendResponse({
              ok: false,
              native: true,
              error: "Purchases are handled in the Styx Multi-Cart app.",
            });
            break;
          }
          if (!extpay) {
            sendResponse({ ok: false, error: "Payment service not available." });
            break;
          }
          const KNOWN_PLANS = ["annual", "lifetime"];
          const plan = KNOWN_PLANS.includes(msg.plan) ? msg.plan : null;
          try {
            if (plan) {
              extpay.openPaymentPage(plan);
            } else {
              extpay.openPaymentPage();
            }
            sendResponse({ ok: true });
          } catch (err) {
            console.error("[Styx Multi-Cart] openPaymentPage failed:", err);
            sendResponse({ ok: false, error: "Couldn't open checkout." });
          }
          break;
        }

        case "MC_REFRESH_ENTITLEMENT": {
          // Lets the popup ask for a fresh entitlement check from the active
          // payment source (e.g. user returns from the checkout tab on Chrome,
          // or from the host-app purchase on Safari). Best-effort; the response
          // ignores the result and lets the caller re-query MC_GET_ENTITLEMENT.
          await syncEntitlement();
          sendResponse({ ok: true });
          break;
        }

        case "MC_SAVE_CURRENT": {
          // Scrape the cart from a background tab so the user doesn't have to
          // be on the cart page. scrapeCartInBackground reuses an existing cart
          // tab if one is open, or opens /gp/cart/view.html silently and closes
          // it when done — the user stays on their current page throughout.

          // Tier gate: check cart count vs. free/premium limit BEFORE scraping
          // so we don't waste a tab-open/scrape cycle just to refuse the save.
          {
            const existing = await readCarts();
            const ent = await readEntitlement();
            const gate = canCreateSavedCart(existing, ent);
            if (!gate.allowed) {
              sendResponse({ ok: false, ...gate, error: gate.reason });
              break;
            }
          }

          let cart;
          try {
            cart = await scrapeCartInBackground();
          } catch (scrapeErr) {
            sendResponse({
              ok: false,
              error: (scrapeErr && scrapeErr.message) || "Could not read the Amazon cart page.",
            });
            break;
          }
          if (!cart.items.length) {
            sendResponse({
              ok: false,
              error: "Your Amazon cart looks empty — nothing to save.",
            });
            break;
          }
          const carts = await readCarts();
          // Re-check the gate after scraping — defensive, in case another
          // popup action created a cart concurrently.
          {
            const ent = await readEntitlement();
            const gate = canCreateSavedCart(carts, ent);
            if (!gate.allowed) {
              sendResponse({ ok: false, ...gate, error: gate.reason });
              break;
            }
          }
          const now = Date.now();
          carts.unshift({
            id: makeId(),
            name: msg.name || "Untitled cart",
            host: cart.host,
            savedAt: cart.capturedAt,
            lastUsedAt: now,
            items: cart.items,
          });
          await writeCarts(carts);
          sendResponse({ ok: true, count: cart.items.length });
          break;
        }

        case "MC_RENAME_CART": {
          const carts = await readCarts();
          const target = carts.find((c) => c.id === msg.id);
          if (!target) {
            sendResponse({ ok: false, error: "Cart not found." });
            break;
          }
          const ent = await readEntitlement();
          const gate = canEditCart(target.id, carts, ent);
          if (!gate.allowed) {
            sendResponse({ ok: false, ...gate, error: gate.reason });
            break;
          }
          target.name = msg.name || target.name;
          target.lastUsedAt = Date.now();
          await writeCarts(carts);
          sendResponse({ ok: true });
          break;
        }

        case "MC_DELETE_CART": {
          const carts = await readCarts();
          const next = carts.filter((c) => c.id !== msg.id);
          await writeCarts(next);
          sendResponse({ ok: true });
          break;
        }

        case "MC_REMOVE_ITEM_FROM_CART": {
          const carts = await readCarts();
          const target = carts.find((c) => c.id === msg.id);
          if (!target) {
            sendResponse({ ok: false, error: "Cart not found." });
            break;
          }
          const ent = await readEntitlement();
          const gate = canEditCart(target.id, carts, ent);
          if (!gate.allowed) {
            sendResponse({ ok: false, ...gate, error: gate.reason });
            break;
          }
          const before = target.items.length;
          target.items = (target.items || []).filter((it) => it.asin !== msg.asin);
          if (target.items.length === before) {
            sendResponse({ ok: false, error: "Item not found in cart." });
            break;
          }
          if (target.items.length === 0) {
            // Last item removed — delete the cart entirely.
            const next = carts.filter((c) => c.id !== target.id);
            await writeCarts(next);
            sendResponse({ ok: true, cartDeleted: true });
            break;
          }
          target.lastUsedAt = Date.now();
          await writeCarts(carts);
          sendResponse({ ok: true, remaining: target.items.length });
          break;
        }

        case "MC_COMBINE_CARTS": {
          // Move every item from sourceId into targetId. Duplicate ASINs
          // resolve via max quantity (per user spec). Source cart is then
          // deleted. Returns the merged target cart.
          const carts = await readCarts();
          const source = carts.find((c) => c.id === msg.sourceId);
          const target = carts.find((c) => c.id === msg.targetId);
          if (!source || !target) {
            sendResponse({ ok: false, error: "One of the carts could not be found." });
            break;
          }
          if (source.id === target.id) {
            sendResponse({ ok: false, error: "Pick two different carts." });
            break;
          }
          if (!sameAmazonHost(source.host, target.host)) {
            sendResponse({
              ok: false,
              error: `Can't merge across regions — "${source.name}" is on ${source.host} but "${target.name}" is on ${target.host}.`,
            });
            break;
          }

          // Tier gate: both source and target must be editable. Merging into
          // a locked cart would be a write; merging from a locked cart would
          // resurrect data the user hasn't paid to maintain.
          {
            const ent = await readEntitlement();
            const srcGate = canEditCart(source.id, carts, ent);
            const tgtGate = canEditCart(target.id, carts, ent);
            if (!srcGate.allowed || !tgtGate.allowed) {
              const locked = !srcGate.allowed ? source.name : target.name;
              sendResponse({
                ok: false,
                code: "CART_LOCKED",
                error: `Can't merge — "${locked}" is read-only. Renew Premium or delete other carts to free up a slot.`,
              });
              break;
            }
          }

          const targetByAsin = new Map();
          (target.items || []).forEach((it) => {
            if (it && it.asin) targetByAsin.set(it.asin, it);
          });
          let added = 0;
          let qtyBumped = 0;
          (source.items || []).forEach((srcItem) => {
            if (!srcItem || !srcItem.asin) return;
            const existing = targetByAsin.get(srcItem.asin);
            if (existing) {
              const srcQty = Number(srcItem.quantity) || 1;
              const tgtQty = Number(existing.quantity) || 1;
              const merged = Math.max(srcQty, tgtQty);
              if (merged !== tgtQty) {
                existing.quantity = merged;
                qtyBumped++;
              }
            } else {
              target.items.push({ ...srcItem });
              targetByAsin.set(srcItem.asin, target.items[target.items.length - 1]);
              added++;
            }
          });

          // Drop the source cart from the list. Bump target lastUsedAt so a
          // freshly-merged cart stays editable through a later lapse.
          target.lastUsedAt = Date.now();
          const next = carts.filter((c) => c.id !== source.id);
          await writeCarts(next);
          sendResponse({
            ok: true,
            target,
            added,
            qtyBumped,
            sourceName: source.name,
            targetName: target.name,
          });
          break;
        }

        case "MC_MOVE_ITEM_BETWEEN_CARTS": {
          // Move a single item (by ASIN) out of one saved cart and into
          // another. Mirrors the combine merge rules: cross-region moves are
          // refused and a duplicate ASIN in the target keeps the higher
          // quantity. If the move empties the source cart, that cart is
          // deleted (same as removing its last item).
          const carts = await readCarts();
          const source = carts.find((c) => c.id === msg.sourceId);
          const target = carts.find((c) => c.id === msg.targetId);
          if (!source || !target) {
            sendResponse({ ok: false, error: "One of the carts could not be found." });
            break;
          }
          if (source.id === target.id) {
            sendResponse({ ok: false, error: "Pick a different cart." });
            break;
          }
          if (!sameAmazonHost(source.host, target.host)) {
            sendResponse({
              ok: false,
              error: `Can't move across regions — "${source.name}" is on ${source.host} but "${target.name}" is on ${target.host}.`,
            });
            break;
          }

          // Tier gate: both carts must be editable — the move writes to each.
          {
            const ent = await readEntitlement();
            const srcGate = canEditCart(source.id, carts, ent);
            const tgtGate = canEditCart(target.id, carts, ent);
            if (!srcGate.allowed || !tgtGate.allowed) {
              const locked = !srcGate.allowed ? source.name : target.name;
              sendResponse({
                ok: false,
                code: "CART_LOCKED",
                error: `Can't move — "${locked}" is read-only. Renew Premium or delete other carts to free up a slot.`,
              });
              break;
            }
          }

          const moving = (source.items || []).find((it) => it && it.asin === msg.asin);
          if (!moving) {
            sendResponse({ ok: false, error: "Item not found in cart." });
            break;
          }

          // Pull it out of the source.
          source.items = (source.items || []).filter((it) => it.asin !== msg.asin);

          // Land it in the target, merging by ASIN. Duplicates keep the
          // higher quantity (same rule the combine UI advertises).
          target.items = Array.isArray(target.items) ? target.items : [];
          const existing = target.items.find((it) => it && it.asin === moving.asin);
          let action;
          if (existing) {
            const moved = Number(moving.quantity) || 1;
            const have = Number(existing.quantity) || 1;
            existing.quantity = Math.max(1, Math.min(99, Math.max(moved, have)));
            if (moving.variantLabel && !existing.variantLabel) {
              existing.variantLabel = moving.variantLabel;
            }
            if (moving.image && !existing.image) existing.image = moving.image;
            if (moving.title && (!existing.title || existing.title === "(untitled)")) {
              existing.title = moving.title;
            }
            if (moving.price && !existing.price) existing.price = moving.price;
            if (moving.url && !existing.url) existing.url = moving.url;
            action = "merged";
          } else {
            target.items.unshift({ ...moving });
            action = "added";
          }
          target.lastUsedAt = Date.now();

          // If the source is now empty, drop it from the list entirely.
          let sourceDeleted = false;
          let nextCarts = carts;
          if (source.items.length === 0) {
            nextCarts = carts.filter((c) => c.id !== source.id);
            sourceDeleted = true;
          } else {
            source.lastUsedAt = Date.now();
          }

          await writeCarts(nextCarts);
          sendResponse({
            ok: true,
            action,
            sourceDeleted,
            sourceName: source.name,
            targetName: target.name,
            itemTitle: moving.title || moving.asin,
            sourceRemaining: source.items.length,
            targetCount: target.items.length,
          });
          break;
        }

        case "MC_UPDATE_ITEM_QUANTITY": {
          const qty = Math.max(1, Math.min(99, Number(msg.quantity) || 1));
          const carts = await readCarts();
          const target = carts.find((c) => c.id === msg.id);
          if (!target) {
            sendResponse({ ok: false, error: "Cart not found." });
            break;
          }
          const ent = await readEntitlement();
          const gate = canEditCart(target.id, carts, ent);
          if (!gate.allowed) {
            sendResponse({ ok: false, ...gate, error: gate.reason });
            break;
          }
          const item = (target.items || []).find((it) => it.asin === msg.asin);
          if (!item) {
            sendResponse({ ok: false, error: "Item not found in cart." });
            break;
          }
          item.quantity = qty;
          target.lastUsedAt = Date.now();
          await writeCarts(carts);
          sendResponse({ ok: true, quantity: qty });
          break;
        }

        case "MC_RESTORE_CART": {
          const carts = await readCarts();
          const target = carts.find((c) => c.id === msg.id);
          if (!target) {
            sendResponse({ ok: false, error: "Cart not found." });
            break;
          }
          // Restore is a "write" against Amazon's live cart and per the
          // monetization spec, locked (read-only) carts cannot move-to-Amazon.
          const ent = await readEntitlement();
          const gate = canEditCart(target.id, carts, ent);
          if (!gate.allowed) {
            sendResponse({ ok: false, ...gate, error: gate.reason });
            break;
          }
          // Bump lastUsedAt synchronously — restoring counts as a "use" and we
          // want the cart to stay editable through any later lapse.
          target.lastUsedAt = Date.now();
          await writeCarts(carts);
          // Acknowledge immediately so the popup doesn't time out — this
          // can take a long time for large carts. The popup will likely
          // close before we finish; that's fine.
          sendResponse({ ok: true, started: true, total: target.items.length });
          setOpStatus(`Restoring "${target.name || 'cart'}"`, "Starting…");
          openStatusWindow(); // non-blocking — don't await
          setTimeout(() => clearThenRestoreCart(target), 0);
          break;
        }

        case "MC_WISHLIST_ADD_ALL": {
          // observer.js scraped an Amazon wishlist and wants every item
          // added to the live Amazon cart (additive — does NOT clear).
          const items = Array.isArray(msg.items)
            ? msg.items.filter((it) => it && it.asin && it.unavailable !== true)
            : [];
          if (!items.length) {
            sendResponse({
              ok: false,
              error: "No available items were found on this wishlist.",
            });
            break;
          }
          // Best-effort tier gate: locked custom carts can't push to the Amazon
          // cart. Only blocks when the cached snapshot marks the list locked, so
          // an unknown/premium list is never wrongly refused.
          if (msg.listId) {
            const acc = _lastListAccess.byId.get(String(msg.listId).toUpperCase());
            if (acc === "locked") {
              sendResponse({
                ok: false,
                code: "CART_LOCKED",
                upsell: true,
                error:
                  "This cart is locked on the free plan. Upgrade to send it to your Amazon cart.",
              });
              break;
            }
          }
          // Acknowledge immediately — the bulk flow navigates a tab and waits
          // on the user's confirmation, which can outlive the message channel.
          sendResponse({ ok: true, started: true, total: items.length });
          setOpStatus("Adding wishlist to cart", "Starting…");
          openStatusWindow(); // non-blocking
          setTimeout(() => wishlistAddAllToCart(items, msg.host, msg.listId), 0);
          break;
        }

        case "MC_CLEAR_CURRENT": {
          const currentCount = await getActiveAmazonCartCount();
          if (currentCount === 0) {
            sendResponse({ ok: true, alreadyEmpty: true });
            break;
          }

          // Acknowledge immediately — navigation + deletion can take several
          // seconds and opening a tab may close the popup, which would drop
          // the response and leave the button spinner stuck forever.
          sendResponse({ ok: true, started: true });
          setOpStatus("Clearing cart", "Starting…");
          openStatusWindow(); // non-blocking — don't await
          setTimeout(clearCurrentCartInBackground, 0);
          break;
        }

        case "MC_SAVE_AND_CLEAR": {
          // Convenience: scrape + save synchronously (using background tab so
          // the user doesn't need to be on the cart page), then clear in the
          // background (fire-and-forget) so the message channel stays open.

          // Tier gate: check BEFORE scraping so we don't waste a tab cycle.
          {
            const existing = await readCarts();
            const ent = await readEntitlement();
            const gate = canCreateSavedCart(existing, ent);
            if (!gate.allowed) {
              sendResponse({ ok: false, ...gate, error: gate.reason });
              break;
            }
          }

          // Capture the origin page NOW, before scraping, so we can return
          // the user to it after the cart is cleared (scraping may take a few
          // seconds and open/close background tabs).
          const [scOriginTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const scOriginUrl = (scOriginTab && scOriginTab.url &&
            isAmazonUrl(scOriginTab.url) && !isAmazonCartUrl(scOriginTab.url))
            ? scOriginTab.url : null;

          let scCart;
          try {
            scCart = await scrapeCartInBackground();
          } catch (scrapeErr) {
            sendResponse({
              ok: false,
              error: (scrapeErr && scrapeErr.message) || "Cart appears empty — nothing to save.",
            });
            break;
          }
          if (!scCart.items.length) {
            sendResponse({ ok: false, error: "Cart appears empty — nothing to save." });
            break;
          }
          const carts = await readCarts();
          // Re-check gate after scraping (concurrent saves are possible).
          {
            const ent = await readEntitlement();
            const gate = canCreateSavedCart(carts, ent);
            if (!gate.allowed) {
              sendResponse({ ok: false, ...gate, error: gate.reason });
              break;
            }
          }
          carts.unshift({
            id: makeId(),
            name: msg.name || "Untitled cart",
            host: scCart.host,
            savedAt: scCart.capturedAt,
            lastUsedAt: Date.now(),
            items: scCart.items,
          });
          await writeCarts(carts);
          // Respond immediately so the popup spinner clears; the actual cart
          // clearing happens in the background via clearAmazonCart().
          const savedCount = scCart.items.length;
          const savedHost = scCart.host;
          sendResponse({ ok: true, saved: savedCount, removed: "pending" });
          setOpStatus("Clearing cart", `Saved — now clearing ${savedCount} item${savedCount === 1 ? '' : 's'}…`);
          openStatusWindow(); // non-blocking — don't await
          setTimeout(() => clearAmazonCart(savedHost, {
            returnToOrigin: true,
            originUrl: scOriginUrl,
          }), 0);
          break;
        }

        case "MC_GET_INTERCEPT": {
          const settings = await readSettings();
          sendResponse({ ok: true, enabled: !!settings.interceptAtc });
          break;
        }

        case "MC_SET_INTERCEPT": {
          const next = await writeSettings({ interceptAtc: !!msg.enabled });
          sendResponse({ ok: true, enabled: !!next.interceptAtc });
          break;
        }

        case "MC_GET_RELABEL": {
          const settings = await readSettings();
          sendResponse({ ok: true, enabled: settings.relabelListsAsCarts !== false });
          break;
        }

        case "MC_SET_RELABEL": {
          const next = await writeSettings({ relabelListsAsCarts: !!msg.enabled });
          sendResponse({ ok: true, enabled: next.relabelListsAsCarts !== false });
          break;
        }

        case "MC_GET_FAB_PULSE": {
          const settings = await readSettings();
          sendResponse({ ok: true, enabled: settings.fabPulse !== false });
          break;
        }

        case "MC_SET_FAB_PULSE": {
          const next = await writeSettings({ fabPulse: !!msg.enabled });
          sendResponse({ ok: true, enabled: next.fabPulse !== false });
          break;
        }

        case "MC_GET_UI_SURFACE": {
          const settings = await readSettings();
          const supported = !!(
            chrome.sidePanel && chrome.sidePanel.setPanelBehavior
          );
          sendResponse({
            ok: true,
            supported,
            surface: settings.uiSurface === "popup" ? "popup" : "sidepanel",
          });
          break;
        }

        case "MC_SET_UI_SURFACE": {
          const surface = msg.surface === "popup" ? "popup" : "sidepanel";
          const next = await writeSettings({ uiSurface: surface });
          applyUiSurface(next.uiSurface);
          sendResponse({ ok: true, surface: next.uiSurface });
          break;
        }

        case "MC_CREATE_EMPTY_CART": {
          // Create a saved cart with no items. Used by the popup's
          // "Create new" button. The ATC intercept on Amazon pages
          // can then fill it via MC_ADD_ITEM_TO_SAVED_CART.
          const name = (msg.name || "").trim() || "Untitled cart";

          // Default host to www.amazon.com. Callers that create a cart as
          // part of a same-region workflow (for example, Move item -> Create
          // new cart) may pass an explicit Amazon host; otherwise prefer the
          // active tab's Amazon hostname.
          let host = "www.amazon.com";
          const requestedHost = String(msg.host || "").trim().toLowerCase();
          if (/(^|\.)amazon\./i.test(requestedHost)) {
            host = requestedHost;
          } else {
            try {
              const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
              if (tab && tab.url) {
                const tabUrl = new URL(tab.url);
                if (/(^|\.)amazon\./i.test(tabUrl.hostname)) host = tabUrl.hostname;
              }
            } catch (_e) {
              // Tab query can fail in some contexts; the default host is fine.
            }
          }

          const carts = await readCarts();
          // Tier gate — refuse before mutating storage.
          {
            const ent = await readEntitlement();
            const gate = canCreateSavedCart(carts, ent);
            if (!gate.allowed) {
              sendResponse({ ok: false, ...gate, error: gate.reason });
              break;
            }
          }
          const newCart = {
            id: makeId(),
            name,
            host,
            savedAt: new Date().toISOString(),
            lastUsedAt: Date.now(),
            items: [],
          };
          carts.unshift(newCart);
          await writeCarts(carts);
          sendResponse({ ok: true, cart: newCart });
          break;
        }

        case "MC_ADD_ITEM_TO_SAVED_CART": {
          // Add a single product-page item to an existing saved cart.
          // Used by the in-page ATC picker (observer.js) when the user
          // chooses to send a click to a saved cart instead of Amazon's
          // live cart.
          const item = msg.item || {};
          if (!item.asin) {
            sendResponse({ ok: false, error: "Item is missing ASIN." });
            break;
          }
          const reqQty = Math.max(1, Math.min(99, Number(item.quantity) || 1));
          const carts = await readCarts();
          const target = carts.find((c) => c.id === msg.savedCartId);
          if (!target) {
            sendResponse({ ok: false, error: "Cart not found." });
            break;
          }
          const ent = await readEntitlement();
          const gate = canEditCart(target.id, carts, ent);
          if (!gate.allowed) {
            sendResponse({ ok: false, ...gate, error: gate.reason });
            break;
          }
          target.items = Array.isArray(target.items) ? target.items : [];
          const existing = target.items.find((it) => it && it.asin === item.asin);
          let action;
          if (existing) {
            const merged = Math.max(1, Math.min(99, (Number(existing.quantity) || 1) + reqQty));
            existing.quantity = merged;
            // Refresh variantLabel if we have a new one and the existing
            // row is missing it (e.g., item was originally added from a
            // tile that didn't expose variant info).
            if (item.variantLabel && !existing.variantLabel) {
              existing.variantLabel = String(item.variantLabel).slice(0, 200);
            }
            if (item.image && !existing.image) {
              existing.image = item.image;
            }
            if (item.title && (!existing.title || existing.title === "(untitled)")) {
              existing.title = item.title;
            }
            if (item.price && !existing.price) {
              existing.price = item.price;
            }
            if (item.url && !existing.url) {
              existing.url = item.url;
            }
            action = "bumped";
          } else {
            target.items.unshift({
              asin: item.asin,
              title: item.title || "(untitled)",
              quantity: reqQty,
              price: item.price || "",
              image: item.image || "",
              url: item.url || "",
              variantLabel: item.variantLabel ? String(item.variantLabel).slice(0, 200) : "",
            });
            action = "added";
          }
          target.lastUsedAt = Date.now();
          await writeCarts(carts);
          sendResponse({ ok: true, action, cartName: target.name, itemCount: target.items.length });
          break;
        }

        case "MC_SAVE_CART_TO_LIST": {
          console.log("[Styx list-sync] MC_SAVE_CART_TO_LIST received, cartId =", msg.cartId);
          // Mirror a saved cart into an Amazon wish list so it syncs across
          // devices. Long-running (creates a list + opens a tab per item), so
          // we ack immediately and report progress through the status window.
          const carts = await readCarts();
          const target = carts.find((c) => c.id === msg.cartId);
          if (!target) {
            sendResponse({ ok: false, error: "Cart not found." });
            break;
          }
          if (!(target.items && target.items.length)) {
            sendResponse({ ok: false, error: "This cart has no items to save." });
            break;
          }
          const ent = await readEntitlement();
          const gate = canEditCart(target.id, carts, ent);
          if (!gate.allowed) {
            sendResponse({ ok: false, ...gate, error: gate.reason });
            break;
          }
          setOpStatus(`Saving "${target.name || "cart"}" to Amazon`, "Starting…");
          openStatusWindow(); // non-blocking
          // Await the whole flow and return the real result so the popup can
          // show what happened (the popup uses a long timeout for this call).
          let saveRes;
          try {
            saveRes = await saveCartToAmazonList(target);
          } catch (e) {
            saveRes = { ok: false, error: String((e && e.message) || e) };
          }
          try { await chrome.storage.local.set({ "mc.debug.lastSync": { at: Date.now(), ...saveRes } }); } catch (_e) {}
          if (saveRes && saveRes.ok) {
            clearOpStatus(
              saveRes.failed
                ? `Saved ${saveRes.added}/${saveRes.total} to "${target.name}". ${saveRes.failed} need a manual add.`
                : `Saved ${saveRes.added} item${saveRes.added === 1 ? "" : "s"} to your Amazon list.`
            );
          } else {
            setOpStatus("Couldn't save to Amazon", (saveRes && saveRes.error) || "Try again.");
          }
          sendResponse(saveRes || { ok: false, error: "No result." });
          break;
        }

        case "MC_SAVE_LIVE_CART_TO_LIST": {
          // Save the LIVE Amazon cart straight into a NEW Amazon wish list —
          // no Styx saved cart in between. Fired by the on-page cart button.
          // Progress is reported as an on-page Styx toast on the INITIATING
          // tab (via notifyTab), and on success that same tab is navigated to
          // the finished list — so the whole flow begins and ends on the cart
          // tab the user clicked from. The per-item driver tabs open/close in
          // the background. Reuses the saveCartToAmazonList driver.
          const cartTabId = (_sender && _sender.tab && _sender.tab.id) || null;
          let liveCart;
          try {
            liveCart = await scrapeCartInBackground(msg.host);
          } catch (scrapeErr) {
            sendResponse({
              ok: false,
              error: (scrapeErr && scrapeErr.message) || "Could not read the Amazon cart page.",
            });
            break;
          }
          if (!liveCart.items || !liveCart.items.length) {
            sendResponse({ ok: false, error: "Your Amazon cart looks empty — nothing to save." });
            break;
          }
          const liveListName = (msg.name && String(msg.name).trim()) || "Amazon cart";
          // No cart.id → saveCartToAmazonList creates a new list and skips the
          // saved-cart link persistence, so nothing lands in the Styx panel.
          let liveSaveRes;
          try {
            liveSaveRes = await saveCartToAmazonList(
              { host: liveCart.host, name: liveListName, items: liveCart.items },
              { progressTabId: cartTabId }
            );
          } catch (e) {
            liveSaveRes = { ok: false, error: String((e && e.message) || e) };
          }
          try { await chrome.storage.local.set({ "mc.debug.lastSync": { at: Date.now(), ...liveSaveRes } }); } catch (_e) {}
          if (liveSaveRes && liveSaveRes.ok) {
            clearOpStatus(
              liveSaveRes.failed
                ? `Saved ${liveSaveRes.added}/${liveSaveRes.total} to "${liveListName}". ${liveSaveRes.failed} need a manual add.`
                : `Saved ${liveSaveRes.added} item${liveSaveRes.added === 1 ? "" : "s"} to your new Amazon list.`
            );
            // Land the user on their new list — in the SAME tab they started
            // from. Falls back to a fresh tab if that tab is gone.
            if (liveSaveRes.listUrl) {
              notifyTab(cartTabId, {
                type: "MC_LIST_SAVE_PROGRESS",
                detail: "Done — opening your list…",
                done: liveSaveRes.total,
                total: liveSaveRes.total,
              });
              let navigated = false;
              if (cartTabId != null) {
                try {
                  await chrome.tabs.update(cartTabId, { url: liveSaveRes.listUrl, active: true });
                  navigated = true;
                } catch (_e) { /* tab gone — fall back below */ }
              }
              if (!navigated) {
                try { await chrome.tabs.create({ url: liveSaveRes.listUrl, active: true }); } catch (_e) {}
              }
            }
          } else {
            setOpStatus("Couldn't save to Amazon", (liveSaveRes && liveSaveRes.error) || "Try again.");
          }
          sendResponse(liveSaveRes || { ok: false, error: "No result." });
          break;
        }

        case "MC_LIST_AMAZON_LISTS": {
          // Read the user's Amazon wish lists for the popup dashboard, then
          // annotate each with tier access (editable/locked) so the popup can
          // gray + paywall locked custom carts.
          const rawLists = await listAmazonLists(msg.host);
          const ent = await readEntitlement();
          const access = computeListAccess(rawLists, ent);
          rememberListAccess(access.lists);
          sendResponse({
            ok: true,
            lists: access.lists,
            entitlement: {
              isPremium: access.isPremium,
              limit: access.isPremium ? null : access.limit,
              customCount: access.customCount,
            },
          });
          break;
        }

        case "MC_GET_LIST_ACCESS": {
          // Access lookup for the on-page wishlist button. Prefer the cached
          // snapshot; on a cache miss, scrape the SENDER's own tab — the wish
          // list page's left sidebar already lists every list, so we can rank
          // the custom lists WITHOUT navigating or spawning a new tab. Only if
          // that yields nothing do we fail OPEN ("editable").
          const wantId = String(msg.listId || "").toUpperCase();
          if (!wantId) {
            sendResponse({ ok: false, error: "Missing list id." });
            break;
          }
          if (
            !_lastListAccess.byId.has(wantId) &&
            _sender &&
            _sender.tab &&
            _sender.tab.id != null
          ) {
            try {
              const res = await chrome.scripting.executeScript({
                target: { tabId: _sender.tab.id },
                func: pageScrapeAmazonLists,
              });
              const scraped =
                (res && res[0] && res[0].result && res[0].result.lists) || [];
              if (scraped.length) {
                const entNow = await readEntitlement();
                const computed = computeListAccess(scraped, entNow);
                rememberListAccess(computed.lists);
              }
            } catch (_e) {
              /* fall through to fail-open */
            }
          }
          const acc = _lastListAccess.byId.get(wantId) || "editable";
          const known = _lastListAccess.byId.has(wantId);
          sendResponse({
            ok: true,
            access: acc,
            known,
            isPremium: isPremiumActive(await readEntitlement()),
          });
          break;
        }

        case "MC_GET_AMAZON_LIST": {
          if (!msg.listId) {
            sendResponse({ ok: false, error: "Missing list id." });
            break;
          }
          const list = await readAmazonList(
            msg.listId,
            msg.host,
            msg.forceRefresh === true
          );
          sendResponse({ ok: true, list });
          break;
        }

        case "MC_IMPORT_AMAZON_LIST": {
          // Pull an existing Amazon list into a new local cart (cross-device
          // recall). Tier-gated like any other new-cart creation.
          if (!msg.listId) {
            sendResponse({ ok: false, error: "Missing list id." });
            break;
          }
          const ent = await readEntitlement();
          const gate = canCreateSavedCart(await readCarts(), ent);
          if (!gate.allowed) {
            sendResponse({ ok: false, ...gate, error: gate.reason });
            break;
          }
          const imported = await importAmazonListToCart(msg.listId, msg.host);
          if (!imported.items.length) {
            sendResponse({ ok: false, error: "That list has no items we could read." });
            break;
          }
          const carts = await readCarts();
          const newCart = {
            id: makeId(),
            name: imported.name || "Imported list",
            host: imported.host,
            savedAt: new Date().toISOString(),
            lastUsedAt: Date.now(),
            items: imported.items,
            amazonListId: msg.listId,
            amazonListUrl: amazonListUrl(imported.host, msg.listId),
            syncedAt: Date.now(),
          };
          carts.unshift(newCart);
          await writeCarts(carts);
          sendResponse({ ok: true, cart: newCart, count: newCart.items.length });
          break;
        }

        default:
          sendResponse({ ok: false, error: "Unknown message: " + msg.type });
      }
    } catch (err) {
      console.error("[Styx Multi-Cart] background error", err);
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    }
  })();

  return true; // keep the channel open for async sendResponse
});

async function waitForTabComplete(tabId, timeoutMs = 45000) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
  } catch (_e) {
    return;
  }

  return new Promise((resolve) => {
    let done = false;
    let timer = null;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removedListener);
      resolve();
    };

    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        finish();
      }
    };

    const removedListener = (id) => {
      if (id === tabId) finish();
    };

    timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removedListener);
  });
}

async function createTabAndWait(url, timeoutMs = 45000) {
  const tab = await chrome.tabs.create({ url, active: true });
  await waitForTabNavigation(tab.id, url, timeoutMs);
  return tab;
}

async function navigateTabAndWait(tabId, url, timeoutMs = 45000) {
  await chrome.tabs.update(tabId, { url, active: true });
  await waitForTabNavigation(tabId, url, timeoutMs);
}

async function waitForTabNavigation(tabId, targetUrl, timeoutMs = 45000) {
  const target = normalizeUrlForWait(targetUrl);

  return new Promise((resolve) => {
    let done = false;
    let timer = null;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removedListener);
      resolve();
    };

    const matchesTarget = (url) => {
      if (!url) return false;
      const current = normalizeUrlForWait(url);
      return current === target || current.startsWith(target + "?");
    };

    const listener = (id, info, tab) => {
      if (id !== tabId) return;
      if ((info.status === "complete" || tab.status === "complete") && matchesTarget(tab.url)) {
        finish();
      }
    };

    const removedListener = (id) => {
      if (id === tabId) finish();
    };

    timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removedListener);

    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete" && matchesTarget(tab.url)) finish();
      })
      .catch(finish);
  });
}

/**
 * Wait for the tab to go through a loading→complete cycle (i.e. a page reload
 * or navigation). Unlike waitForTabComplete, this will NOT resolve immediately
 * if the tab is already complete — it waits for the NEXT load.
 *
 * Also handles the race where the tab started loading before we set up the
 * listener: we check the current status immediately after attaching and mark
 * sawLoading=true if the tab is already in the "loading" state.
 */
async function waitForTabReload(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let sawLoading = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removedListener);
      resolve();
    };

    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "loading") sawLoading = true;
      if (info.status === "complete" && sawLoading) finish();
    };

    const removedListener = (id) => {
      if (id === tabId) finish();
    };

    timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removedListener);

    // Check immediately in case loading already started before our listener attached.
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "loading") {
        sawLoading = true; // already loading — next "complete" event will finish us
      }
    }).catch(finish);
  });
}

function normalizeUrlForWait(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href.replace(/\/$/, "");
  } catch (_e) {
    return String(url || "").replace(/#.*$/, "").replace(/\/$/, "");
  }
}
