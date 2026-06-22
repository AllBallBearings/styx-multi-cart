/**
 * lib/native-sync.js — pure helper that translates the native (App Store /
 * StoreKit) entitlement payload into an entitlement patch.
 *
 * Safari build only. The Swift host app drives StoreKit purchases, writes the
 * resulting entitlement into a shared App Group, and the extension's
 * SafariWebExtensionHandler returns that record to background.js when asked.
 * This module is the JS-side mapper, mirroring the shape/convention of
 * lib/extpay-sync.js so both payment sources land the same entitlement record.
 *
 * Native payload shape (from SafariWebExtensionHandler → getEntitlement):
 *   {
 *     ok: true,
 *     entitled: boolean,
 *     productType: "lifetime" | "subscription" | "",
 *     expiresAt: number,      // epoch ms; 0 for lifetime / none
 *     willAutoRenew: boolean,
 *     productId: string
 *   }
 *
 * Tests live in tests/unit/native-sync.test.js.
 */

// If a subscription is active but StoreKit didn't hand us an expiry (rare —
// e.g. a billing-retry window), project this far forward and let the periodic
// refresh re-confirm. Mirrors the EXTPAY buffer rationale but shorter: StoreKit
// caches entitlements locally and is reliable offline, so we need far less
// grace than the network-backed ExtPay path.
export const NATIVE_PREMIUM_BUFFER_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

/**
 * Compute the entitlement patch to apply given a native entitlement payload
 * and the user's current local entitlement.
 *
 * Rules (in order):
 *  1. entitled + lifetime → lifetime premium (premiumUntil null).
 *  2. entitled + subscription → premium until expiresAt (or now + buffer if
 *     missing). Take MAX with any still-active premiumUntil so an existing
 *     grant or grace window is never shortened. autoRenew from willAutoRenew.
 *  3. not entitled BUT current entitlement still active (promo/dev grant or a
 *     still-valid window) → leave premium alone; only bump lastChecked.
 *  4. Otherwise → free.
 *
 * @param {object} native   Payload from the native handler (see shape above).
 * @param {object} current  Current entitlement record (from storage).
 * @param {number} nowMs    Current epoch ms.
 * @returns {object} Patch to merge into entitlement storage.
 */
export function nativeEntitlementToPatch(native, current, nowMs) {
  const safeCurrent = current && typeof current === "object" ? current : {};
  const n = native && typeof native === "object" ? native : {};

  // Any still-active entitlement is a floor we honor. For promo/dev grants the
  // App Store can't see the grant; for appstore-sourced premium this is the
  // grace buffer from the last known-good read.
  const activePremiumFloor =
    safeCurrent.tier === "premium" &&
    typeof safeCurrent.premiumUntil === "number" &&
    safeCurrent.premiumUntil > nowMs
      ? safeCurrent.premiumUntil
      : 0;

  if (n.entitled === true) {
    if (n.productType === "lifetime") {
      return {
        tier: "premium",
        premiumUntil: null,
        autoRenew: false,
        source: "appstore",
        lastChecked: nowMs,
      };
    }

    // Subscription. expiresAt is epoch ms; 0/absent means "active but no end
    // date handed to us" → project forward by the buffer.
    const expiresAt = Number(n.expiresAt);
    const subscriptionUntil =
      Number.isFinite(expiresAt) && expiresAt > nowMs
        ? expiresAt
        : nowMs + NATIVE_PREMIUM_BUFFER_MS;

    // Don't shorten an active grant or grace window.
    const premiumUntil = Math.max(subscriptionUntil, activePremiumFloor);

    return {
      tier: "premium",
      premiumUntil,
      autoRenew: n.willAutoRenew === true,
      source: "appstore",
      lastChecked: nowMs,
    };
  }

  // Not entitled per the App Store — but keep any still-valid premium window
  // alive (promo/dev grant, or grace). Only the check timestamp moves.
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
