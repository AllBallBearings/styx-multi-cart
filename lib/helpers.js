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
  return String(host || "")
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
