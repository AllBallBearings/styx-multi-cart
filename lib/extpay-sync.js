/**
 * lib/extpay-sync.js — pure helper that translates an ExtensionPay user
 * object into an entitlement patch.
 *
 * Mirrors `extpayUserToEntitlementPatch` in background.js byte-for-byte
 * (same convention as lib/helpers.js — the service worker is loaded as a
 * classic script and can't import ESM yet, so we duplicate to test).
 *
 * Tests live in tests/unit/extpay-sync.test.js.
 */

// If a Premium subscription is active and ExtPay didn't tell us when it
// cancels, project this far into the future and keep refreshing via the
// daily alarm. The buffer means a transient outage (laptop offline for a
// few days, ExtPay down for a few hours) won't downgrade a paying user.
export const EXTPAY_PREMIUM_BUFFER_MS = 28 * 24 * 60 * 60 * 1000; // 28 days

/**
 * Compute the entitlement patch to apply given an ExtPay user object
 * and the user's current local entitlement.
 *
 * Rules (in order):
 *  1. user.paid === true → premium, sourced from extensionpay. If
 *     subscriptionCancelAt is set, use it as premiumUntil (so we honor a
 *     pending cancellation); otherwise extend by EXTPAY_PREMIUM_BUFFER_MS
 *     from `now`. Take MAX with any existing promo-granted premiumUntil
 *     so a promo code redeemed earlier isn't shortened.
 *  2. user.paid === false AND current entitlement is a still-active
 *     promo grant (source === "promo" AND premiumUntil > now) → leave the
 *     premium state alone; only bump lastChecked. Promo grants are local
 *     and ExtPay can't see them.
 *  3. Otherwise → free tier. Clear premium fields.
 *
 * @param {object} user        ExtPay.getUser() return value.
 * @param {object} current     Current entitlement record (from storage).
 * @param {number} nowMs       Current epoch ms.
 * @returns {object} Patch to merge into entitlement storage.
 */
export function extpayUserToEntitlementPatch(user, current, nowMs) {
  const safeCurrent = current && typeof current === "object" ? current : {};

  if (user && user.paid === true) {
    // ExtPay sometimes serializes dates as Date instances; sometimes as
    // ISO strings (depends on whether SDK has parsed the field already).
    // Accept both shapes defensively.
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

    // Don't shorten an active promo grant.
    const promoFloor =
      safeCurrent.source === "promo" &&
      typeof safeCurrent.premiumUntil === "number" &&
      safeCurrent.premiumUntil > nowMs
        ? safeCurrent.premiumUntil
        : 0;

    const premiumUntil = Math.max(subscriptionUntil, promoFloor);

    return {
      tier: "premium",
      premiumUntil,
      // Auto-renew is the inverse of "subscription has a hard cancel date
      // already set". If the subscription is active with no scheduled
      // cancel, the user is on autopay.
      autoRenew: !cancelAt,
      source: "extensionpay",
      lastChecked: nowMs,
    };
  }

  // Not paid via ExtPay. Respect a still-active promo grant.
  if (
    safeCurrent.source === "promo" &&
    typeof safeCurrent.premiumUntil === "number" &&
    safeCurrent.premiumUntil > nowMs
  ) {
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
