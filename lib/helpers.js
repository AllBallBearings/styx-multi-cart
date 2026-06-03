/**
 * lib/helpers.js — pure, side-effect-free helpers extracted from background.js
 * for unit testing.
 *
 * Each function here is a byte-identical copy of the same-named function in
 * background.js (the service worker is loaded as a classic script and can't
 * import ESM today, so we duplicate rather than re-export). If you change a
 * helper in one file, change it in the other. Both files cross-reference each
 * other so future maintainers find this contract.
 *
 * Tests under tests/unit/helpers.test.js import from here.
 */

// ---- Constants ------------------------------------------------------------

export const STORAGE_KEY = "mc.carts.v1";
export const SETTINGS_KEY = "mc.settings.v1";
export const UPSELL_CHOICES_KEY = "mc.upsell.choices.v1";
export const UPSELL_TTL_MS = 24 * 60 * 60 * 1000;
export const PENDING_ATC_TTL_MS = 5 * 60 * 1000;

export const DEFAULT_SETTINGS = {
  interceptAtc: true,
  dockToExtensionsBar: false,
  sidePanelCollapsed: false,
  restoring: false,
};

export const AMAZON_TLDS = [
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

// ---- IDs ------------------------------------------------------------------

export function makeId() {
  return (
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8)
  );
}

// ---- Upsell / pending-ATC pruning -----------------------------------------

/**
 * Prune entries older than PENDING_ATC_TTL_MS from a Map<tabId, {at: number}>.
 * Mutates the map in place. Pure with respect to its arguments (no globals).
 */
export function prunePendingAtc(map, nowMs = Date.now(), ttlMs = PENDING_ATC_TTL_MS) {
  for (const [tabId, p] of map) {
    if (nowMs - p.at > ttlMs) map.delete(tabId);
  }
}

export function pruneUpsellChoices(map, nowMs = Date.now(), ttlMs = UPSELL_TTL_MS) {
  const out = {};
  for (const [asin, entry] of Object.entries(map || {})) {
    if (entry && entry.recordedAt && nowMs - entry.recordedAt < ttlMs) {
      out[asin] = entry;
    }
  }
  return out;
}

// ---- URL / host helpers ---------------------------------------------------

export function getUrlHost(url) {
  try {
    return new URL(url).hostname;
  } catch (_e) {
    return "";
  }
}

export function normalizeAmazonHost(host) {
  return String(host || "www.amazon.com")
    .toLowerCase()
    .replace(/^www\./, "");
}

export function sameAmazonHost(a, b) {
  return normalizeAmazonHost(a) === normalizeAmazonHost(b);
}

export function isAmazonCartUrl(url) {
  return /amazon\.[a-z.]+\/(gp\/)?cart(?:[/?#]|$)/i.test(url || "");
}

export function isAmazonUrl(url) {
  return /(^|\.)amazon\.[a-z.]+\//i.test(url || "");
}

export function isUpsellUrl(url) {
  return /\/gp\/.*attach|attach-warranty|warranty|protection|service-plan/i.test(
    url || ""
  );
}

export function normalizeUrlForWait(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href.replace(/\/$/, "");
  } catch (_e) {
    return String(url || "")
      .replace(/#.*$/, "")
      .replace(/\/$/, "");
  }
}

// ---- Bulk-add URL building ------------------------------------------------

export function buildBulkAddUrl(host, items, associateTag) {
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

export function chunkItemsForBulk(items, size = 30) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---- Entitlement & cart-tier gating --------------------------------------
//
// See docs/MONETIZATION_PLAN.md for the full spec. Summary:
//   - Free tier: up to FREE_CART_LIMIT saved carts, all editable.
//   - Premium tier: up to PREMIUM_CART_LIMIT saved carts, all editable.
//   - Lapsed premium: existing carts remain visible, but only the top
//     FREE_CART_LIMIT (sorted by lastUsedAt desc) are editable; the rest
//     are read-only. Deletion is always allowed; auto-promotion happens
//     implicitly via the next lastUsedAt sort.

export const ENTITLEMENT_KEY = "mc.entitlement.v1";
export const DEV_FLAG_KEY = "mc.dev.v1";
export const FREE_CART_LIMIT = 2;
export const PREMIUM_CART_LIMIT = 20;

export const DEFAULT_ENTITLEMENT = Object.freeze({
  tier: "free",          // "free" | "premium"
  premiumUntil: null,    // epoch ms or null
  autoRenew: false,      // hint from payment provider
  source: null,          // "extensionpay" | "promo" | "stripe" | "appstore" | null
  lastChecked: 0,        // epoch ms of last server verification
});

export function isPremiumActive(ent, nowMs = Date.now()) {
  if (!ent || ent.tier !== "premium") return false;
  if (!ent.premiumUntil) return false;
  return nowMs < Number(ent.premiumUntil);
}

export function cartLimitFor(ent, nowMs = Date.now()) {
  return isPremiumActive(ent, nowMs) ? PREMIUM_CART_LIMIT : FREE_CART_LIMIT;
}

/**
 * Return the IDs of the N most-recently-used carts (descending by lastUsedAt).
 * Stable tiebreaker: savedAt desc, then id ascending. Carts without a
 * lastUsedAt are treated as 0 (oldest) so any cart that has ever been touched
 * floats above a never-used one.
 */
export function topNCartIdsByLastUsed(carts, n) {
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

/**
 * Pure: given carts and entitlement, return per-cart access annotation.
 *   editableIds: Set of cart ids the user can write to.
 *   readOnlyIds: Set of cart ids that are visible but locked.
 *   limit:       The active tier's cart limit.
 */
export function computeCartAccess(carts, ent, nowMs = Date.now()) {
  const limit = cartLimitFor(ent, nowMs);
  const editableIds = new Set(topNCartIdsByLastUsed(carts, limit));
  const readOnlyIds = new Set();
  for (const c of carts || []) {
    if (c && c.id && !editableIds.has(c.id)) readOnlyIds.add(c.id);
  }
  return { editableIds, readOnlyIds, limit };
}

/**
 * Can the user create another saved cart right now?
 * Gate: cart count strictly less than tier limit.
 */
export function canCreateSavedCart(carts, ent, nowMs = Date.now()) {
  const current = Array.isArray(carts) ? carts.length : 0;
  const limit = cartLimitFor(ent, nowMs);
  const premium = isPremiumActive(ent, nowMs);
  if (current < limit) {
    return {
      allowed: true,
      current,
      limit,
      remaining: limit - current,
      tier: premium ? "premium" : "free",
    };
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

/**
 * Can the user edit (write to) a specific cart?
 * A cart is editable iff it appears in the top-N by lastUsedAt where N is
 * the current tier's limit.
 */
export function canEditCart(cartId, carts, ent, nowMs = Date.now()) {
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
 * Backfill lastUsedAt on carts that predate the entitlement layer.
 * Mutates in place. Returns the same array. Default fill is savedAt (or 0).
 */
export function backfillLastUsedAt(carts) {
  if (!Array.isArray(carts)) return carts;
  for (const c of carts) {
    if (c && !Number.isFinite(c.lastUsedAt)) {
      const sa = Number(c.savedAt);
      c.lastUsedAt = Number.isFinite(sa) ? sa : 0;
    }
  }
  return carts;
}
