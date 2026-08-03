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

export const SETTINGS_KEY = "mc.settings.v1";
export const UPSELL_CHOICES_KEY = "mc.upsell.choices.v1";
export const UPSELL_TTL_MS = 24 * 60 * 60 * 1000;
export const PENDING_ATC_TTL_MS = 5 * 60 * 1000;

export const DEFAULT_SETTINGS = {
  interceptAtc: true,
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

// ---- Entitlement & list-tier gating --------------------------------------
//
// See docs/MONETIZATION_PLAN.md. The product treats Amazon lists as "carts":
// free tier gets the first FREE_CART_LIMIT lists editable, the rest locked;
// Premium unlocks all. See computeListAccess below.

export const ENTITLEMENT_KEY = "mc.entitlement.v1";
export const DEV_FLAG_KEY = "mc.dev.v1";
export const FREE_CART_LIMIT = 3;

export const DEFAULT_ENTITLEMENT = Object.freeze({
  tier: "free",          // "free" | "premium"
  premiumUntil: null,    // epoch ms, or null for lifetime premium / free
  autoRenew: false,      // hint from payment provider
  source: null,          // "extensionpay" | "promo" | "stripe" | "appstore" | null
  lastChecked: 0,        // epoch ms of last server verification
});

export function isPremiumActive(ent, nowMs = Date.now()) {
  if (!ent || ent.tier !== "premium") return false;
  if (ent.premiumUntil == null) return true;
  return nowMs < Number(ent.premiumUntil);
}

/**
 * Tier access for Amazon lists (the product treats Amazon lists as "carts").
 * On the free tier only the first FREE_CART_LIMIT lists (in the given order)
 * are editable; the rest are "locked". Every list counts toward the limit —
 * Amazon does not auto-create any list for new accounts, so there are no
 * default lists to exclude (the "Wish List" is just a user-created list like
 * any other). Premium unlocks every list.
 *
 * `lists` are {listId,name,url,count,kind} objects. Returns the same list
 * objects annotated with `access` ("editable" | "locked"), plus a summary.
 */
export function computeListAccess(lists, ent, nowMs = Date.now()) {
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

/**
 * Extract the list id from an Amazon wish-list URL or href.
 * Handles the modern `/hz/wishlist/ls/<ID>` form and the legacy
 * `/gp/registry/wishlist/<ID>` form. Returns null when no id is present.
 * Pure — safe to unit test.
 */
export function parseAmazonListId(href) {
  if (!href) return null;
  const s = String(href);
  const m =
    s.match(/\/hz\/wishlist\/ls\/([A-Z0-9]{7,})(?:[/?#]|$)/i) ||
    s.match(/\/gp\/registry\/wishlist\/([A-Z0-9]{7,})(?:[/?#]|$)/i) ||
    s.match(/[?&]listId=([A-Z0-9]{7,})(?:[&#]|$)/i);
  return m ? m[1].toUpperCase() : null;
}

/** Canonical URL for a wish list on a given Amazon host. */
export function amazonListUrl(host, listId) {
  const h = normalizeAmazonHost(host);
  const full = h.startsWith("amazon.") ? `www.${h}` : h;
  return `https://${full}/hz/wishlist/ls/${listId}`;
}
