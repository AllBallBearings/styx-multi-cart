/**
 * background.js — service worker.
 *
 * Owns:
 *   - Storage layer (chrome.storage.local) for saved carts.
 *   - Restore logic: clears the active cart and drives product-page Add to Cart.
 *   - Tab discovery: finds (or opens) an Amazon cart tab to send messages to.
 *   - ExtensionPay entitlement sync (daily alarm + onPaid listener).
 *
 * Testing note: pure helpers and storage wrappers in this file are mirrored
 * byte-for-byte in lib/helpers.js, lib/storage.js, lib/scrape.js
 * (pageScrapeCart + pageGetCartCount), and lib/extpay-sync.js so they can be
 * unit-tested under Vitest. If you change a helper here, change it there.
 * A future PR can collapse the duplication by loading background.js as an
 * ES module.
 */

// ExtensionPay SDK. Must come before any reference to `ExtPay(...)`.
// Vendored from `npm install extpay` → node_modules/extpay/dist/ExtPay.js.
importScripts("ExtPay.js");

// Verbose service-worker logging. Controlled at runtime by the
// `mc.dev.v1` flag — toggle it from the popup's Settings → Developer mode
// switch (no source edits needed). This let is intentionally NOT a const:
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
const dlog = (...a) => { if (DEBUG) console.log(...a); };
const dinfo = (...a) => { if (DEBUG) console.info(...a); };
const dwarn = (...a) => { if (DEBUG) console.warn(...a); };

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
const FREE_CART_LIMIT = 2;
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
  // Ephemeral flag — set to true for the duration of a cart restore so the
  // observer.js ATC intercept stands down. Cleared in a finally block so a
  // crash or early return can never leave interception permanently disabled.
  restoring: false,
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
  return carts;
}

async function writeCarts(carts) {
  await chrome.storage.local.set({ [STORAGE_KEY]: carts });
}

// ---- Entitlement (mirrored from lib/helpers.js + lib/storage.js) ----------
// See docs/MONETIZATION_PLAN.md. Mirroring matches the convention used for
// other pure helpers — service worker can't import ESM yet.

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

const extpay = typeof ExtPay === "function" ? ExtPay(EXTPAY_ID) : null;
if (!extpay) {
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

// EXTPAY_PREMIUM_BUFFER_MS + extpayUserToEntitlementPatch:
// mirrored byte-for-byte from lib/extpay-sync.js (see file header).
const EXTPAY_PREMIUM_BUFFER_MS = 28 * 24 * 60 * 60 * 1000; // 28 days

function extpayUserToEntitlementPatch(user, current, nowMs) {
  const safeCurrent = current && typeof current === "object" ? current : {};

  // Any still-active entitlement is a floor we have to honor. For promo/dev
  // grants, ExtPay can't see the grant. For extensionpay-sourced premium, this
  // is the grace buffer from the last known-good paid sync.
  const activePremiumFloor =
    safeCurrent.tier === "premium" &&
    typeof safeCurrent.premiumUntil === "number" &&
    safeCurrent.premiumUntil > nowMs
      ? safeCurrent.premiumUntil
      : 0;

  if (user && user.paid === true) {
    if (user.plan && user.plan.interval === "once") {
      return {
        tier: "premium",
        premiumUntil: null,
        autoRenew: false,
        source: "extensionpay",
        lastChecked: nowMs,
      };
    }

    let cancelAt = null;
    if (user.subscriptionCancelAt) {
      cancelAt =
        user.subscriptionCancelAt instanceof Date
          ? user.subscriptionCancelAt.getTime()
          : Date.parse(user.subscriptionCancelAt);
      if (!Number.isFinite(cancelAt)) cancelAt = null;
    }

    const subscriptionUntil =
      cancelAt && cancelAt > nowMs ? cancelAt : nowMs + EXTPAY_PREMIUM_BUFFER_MS;

    const premiumUntil = Math.max(subscriptionUntil, activePremiumFloor);

    return {
      tier: "premium",
      premiumUntil,
      autoRenew: !cancelAt,
      source: "extensionpay",
      lastChecked: nowMs,
    };
  }

  // Not paid via ExtPay — but keep any still-valid premium window alive. Only
  // the check timestamp moves; expiry still happens once premiumUntil passes.
  if (activePremiumFloor > 0) {
    return { lastChecked: nowMs };
  }

  return {
    tier: "free",
    premiumUntil: null,
    autoRenew: false,
    source: null,
    lastChecked: nowMs,
  };
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

// Daily alarm wakes the service worker even if the popup is never opened.
chrome.alarms.create(EXTPAY_SYNC_ALARM, {
  periodInMinutes: EXTPAY_SYNC_PERIOD_MIN,
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === EXTPAY_SYNC_ALARM) syncEntitlementFromExtPay();
});

// Sync once when the service worker spins up (e.g. on browser startup, on
// install/update, or after the worker has been suspended). Doesn't block
// other event registration because top-level awaits aren't allowed here.
syncEntitlementFromExtPay();

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

/** Open (or focus) the floating status window. Non-blocking — call without await. */
async function openStatusWindow() {
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
 *   "Clear cart"). Has no effect when the user was already on the cart page.
 * @param {string}  [options.originUrl]
 *   Pre-captured return URL. If omitted and returnToOrigin is true, the
 *   function queries the active tab itself.
 */
async function clearAmazonCart(preferredHost, options = {}) {
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

  // Delete items one at a time using MC_CLEAR_ONE. Amazon's cart delete is a
  // real form POST (not XHR) that reloads the page, which destroys the content
  // script mid-execution. MC_CLEAR_ONE responds BEFORE submitting the form so
  // the response is delivered before the reload. We then wait for the reload
  // and call again until the cart is empty.
  let removed = 0;

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
    if (result.empty) break;   // cart is now empty
    if (!result.ok) break;     // unrecoverable error

    removed++;
    // Wait for the full-page reload triggered by the form POST, then pause
    // briefly before sending the next delete.
    await waitForTabReload(tabId, 15000);
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

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: active.id },
      func: pageGetCartCount,
    });
    const count = result && result[0] && result[0].result;
    return Number.isFinite(count) ? count : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Inject content.js into a tab if it isn't already there, then send a message.
 * Cart tabs always have content.js via manifest, but this is defensive — for
 * example if the user is on a cart subroute we didn't list, we can still work.
 */
async function sendToContent(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_e) {
    // Content script not loaded yet — inject and retry.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
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
      "input[name='proceedToCheckout']",
      "form[action*='cart/add' i] input[type='submit']",
      "form[action*='cart/add' i] button[type='submit']",
      "form[action*='cart' i] input[type='submit']",
      "form[action*='cart' i] button[type='submit']",
      "form[action*='handle-buy-box' i] input[type='submit']",
      // Value-based — works even when name/id are unusual
      "input[type='submit'][value*='Add' i][value*='Cart' i]",
      "input.a-button-input[value*='Add' i][value*='Cart' i]",
      // Last-resort generic submit (use with extreme care; isVisible filters)
      "input.a-button-input",
    ];

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
        const label = (
          el.value || el.textContent || el.getAttribute("aria-label") || ""
        ).trim().toLowerCase();
        if (!label) continue;
        const looksLikeAddToCart =
          label === "add to cart" ||
          label === "add to shopping cart" ||
          (label.startsWith("add") && label.includes("cart") && label.length < 40);
        if (!looksLikeAddToCart) continue;

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

    const findButton = () => {
      for (const sel of SELECTORS) {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) {
          console.log("[Styx Multi-Cart] confirm button matched selector:", sel);
          return el;
        }
      }
      const byText = findByText();
      if (byText) {
        console.log("[Styx Multi-Cart] confirm button matched via text fallback");
        return byText;
      }
      return null;
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
      const btn = findButton();
      if (btn) {
        try { applyOverlayRing(btn); resolve({ ok: true }); }
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
function pagePromptChoice(title, message, choices) {
  // choices: [{ label, value, style: 'primary'|'secondary'|'ghost' }]
  // Resolves with the chosen `value`, or "dismissed" if user clicks the backdrop.
  return new Promise((resolve) => {
    const ID = "__styx-prompt-modal";
    const existing = document.getElementById(ID);
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = ID;
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,.55);" +
      "z-index:2147483646;display:flex;align-items:center;justify-content:center;" +
      "font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;";

    const modal = document.createElement("div");
    modal.style.cssText =
      "background:#131a22;color:#fff;border:1px solid #ff9900;" +
      "border-radius:14px;padding:22px 26px;max-width:480px;width:90%;" +
      "box-shadow:0 0 0 1px #ff9900,0 6px 32px rgba(0,0,0,.6);";

    const h = document.createElement("div");
    h.style.cssText = "font-size:18px;font-weight:700;margin-bottom:10px;";
    h.textContent = title;
    modal.appendChild(h);

    const p = document.createElement("div");
    p.style.cssText = "font-size:15px;line-height:1.45;opacity:.92;margin-bottom:22px;white-space:pre-wrap;";
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
      return "padding:9px 16px;border-radius:8px;border:1px solid #4b5563;" +
             "background:transparent;color:#fff;cursor:pointer;font-size:14px;";
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
function waitForUserBulkConfirm(tabId, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(navListener); } catch (_e) {}
      try { chrome.tabs.onRemoved.removeListener(removeListener); } catch (_e) {}
      clearTimeout(timer);
      resolve(result);
    };
    const navListener = (id, info, tab) => {
      if (id !== tabId) return;
      // The click POSTs and triggers a navigation away from add.html.
      // Use status:'loading' so we catch the navigation start (the URL
      // is already the new destination at this point).
      if (info.status === "loading" && tab && tab.url) {
        if (!/\/gp\/aws\/cart\/add\.html/i.test(tab.url)) {
          finish({ ok: true, url: tab.url });
        }
      }
    };
    const removeListener = (id) => {
      if (id === tabId) finish({ ok: false, error: "tab closed" });
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: "user did not confirm within timeout" }),
      timeoutMs
    );
    chrome.tabs.onUpdated.addListener(navListener);
    chrome.tabs.onRemoved.addListener(removeListener);
  });
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

      // Try to highlight the confirm button. Two possible outcomes:
      //   (a) Confirm page rendered → button found → highlight + ask user to click.
      //   (b) Amazon redirected past it OR our selectors miss the button →
      //       skip the wait, proceed to reconciliation at the end of the loop.
      const hlRes = await chrome.scripting.executeScript({
        target: { tabId: helperTab.id },
        func: pageHighlightBulkConfirm,
      });
      const hr = hlRes && hlRes[0] && hlRes[0].result;

      if (hr && hr.ok) {
        // Path (a): user-confirm flow.
        const chunkPrompt = chunks.length > 1
          ? `Click the highlighted "Add To Cart" to confirm batch ${c + 1} of ${chunks.length} (${chunk.length} items)`
          : `Click the highlighted "Add To Cart" to add ${chunk.length} item${chunk.length === 1 ? '' : 's'} to your Amazon cart`;
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
    const summary = addedCount > 0
      ? `Bulk add only got ${addedCount} of ${allItems.length} items into your cart.\n\nWould you like to restore the remaining ${missing.length} one at a time? This is slower but more reliable.`
      : `The bulk add didn't put any items in your cart — Amazon's batch endpoint may have silently dropped them (often because the associate tag isn't recognized).\n\nWould you like to restore all ${allItems.length} items one at a time instead?`;

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
    choices.push({ label: "Cancel", value: "cancel", style: "ghost" });

    let userChoice = "cancel";
    try {
      const promptRes = await chrome.scripting.executeScript({
        target: { tabId: helperTab.id },
        func: pagePromptChoice,
        args: ["Bulk add incomplete", summary, choices],
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
    await chrome.scripting.executeScript({
      target: { tabId },
      func: pageShowStatus,
      args: [message, type],
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
function pageShowStatus(message, type) {
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

  var accent = type === 'done' ? '#34d399' : type === 'error' ? '#ef4444' : '#ff9900';
  var glowRgb = type === 'done' ? '52,211,153' : type === 'error' ? '239,68,68' : '255,153,0';

  var ts = toast.style;
  ts.position = 'fixed'; ts.top = '24px'; ts.left = '50%';
  ts.transform = 'translateX(-50%)'; ts.bottom = ''; ts.right = '';
  ts.zIndex = '2147483647';
  ts.display = 'flex'; ts.alignItems = 'center'; ts.gap = '14px';
  ts.padding = '16px 22px'; ts.borderRadius = '14px';
  ts.border = '1px solid ' + accent;
  ts.background = '#131a22'; ts.color = '#ffffff';
  ts.fontFamily = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
  ts.fontSize = '18px'; ts.fontWeight = '600'; ts.lineHeight = '1.35';
  ts.boxShadow = '0 0 0 1px ' + accent + ', 0 0 24px rgba(' + glowRgb + ',.35), 0 6px 24px rgba(0,0,0,.45)';
  ts.maxWidth = '720px'; ts.width = ''; ts.pointerEvents = 'none';
  ts.opacity = '1'; ts.transition = 'opacity .2s, box-shadow .25s, border-color .25s';

  toast.className = type === 'loading' ? '__styx-toast-loading' : '';

  if (toast._styxTimer) { clearTimeout(toast._styxTimer); toast._styxTimer = null; }

  // Styx logo (carts + river) — copied from popup.html, with class hooks
  // on each cart's <g> and its wheels for the cycling animation.
  var logoSvg =
    '<svg width="36" height="36" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block">' +
      '<rect width="32" height="32" rx="7" fill="#131a22"/>' +
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

function pageGetCartCount() {
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
    return true;
  });
  if (liveRows.length) return liveRows.length;

  const quantityEl =
    document.querySelector("#nav-cart-count") ||
    document.querySelector("#ewc-total-quantity") ||
    document.querySelector("input[name='totalCartQuantity']");
  if (quantityEl) {
    const count = parseCount(quantityEl.value || quantityEl.textContent);
    if (count != null) return count;
  }

  const quantityText = document.querySelector(
    "#nav-flyout-ewc .ewc-quantity, #ewc-content .ewc-quantity"
  );
  if (quantityText) {
    const match = (quantityText.textContent || "").match(/\b(\d+)\s+items?\b/i);
    if (match) return parseCount(match[1]);
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

// ---- Message router -------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  (async () => {
    try {
      switch (msg.type) {
        case "MC_GET_STATUS": {
          sendResponse(_opStatus || { active: false, title: "", detail: "" });
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
          // Lets the popup ask for a fresh ExtPay-backed entitlement check
          // (e.g. user returns from checkout tab). Best-effort; the response
          // ignores the result and lets the caller re-query MC_GET_ENTITLEMENT.
          await syncEntitlementFromExtPay();
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
