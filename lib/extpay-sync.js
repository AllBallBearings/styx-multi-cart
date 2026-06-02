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
 *  1. user.paid === true with a one-time plan → lifetime premium.
 *  2. user.paid === true with a subscription → premium, sourced from
 *     extensionpay. If subscriptionCancelAt is set, use it as premiumUntil
 *     (so we honor a pending cancellation); otherwise extend by
 *     EXTPAY_PREMIUM_BUFFER_MS from `now`. Take MAX with any still-active
 *     premiumUntil so an existing grant or grace window is not shortened.
 *  3. user.paid === false AND current entitlement is still active
 *     (premiumUntil > now) → leave the premium state alone; only bump
 *     lastChecked. This honors both local promo/dev grants and the ExtPay
 *     grace buffer from the last known-good paid sync.
 *  4. Otherwise → free tier. Clear premium fields.
 *
 * @param {object} user        ExtPay.getUser() return value.
 * @param {object} current     Current entitlement record (from storage).
 * @param {number} nowMs       Current epoch ms.
 * @returns {object} Patch to merge into entitlement storage.
 */
export function extpayUserToEntitlementPatch(user, current, nowMs) {
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

    // Don't shorten an active grant or grace window.
    const premiumUntil = Math.max(subscriptionUntil, activePremiumFloor);

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
