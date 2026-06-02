import { describe, it, expect } from "vitest";
import {
  EXTPAY_PREMIUM_BUFFER_MS,
  extpayUserToEntitlementPatch,
} from "../../lib/extpay-sync.js";

const NOW = 1_700_000_000_000; // arbitrary fixed epoch
const DAY = 24 * 60 * 60 * 1000;

describe("extpayUserToEntitlementPatch", () => {
  it("paid + no cancellation → premium with 28-day buffer", () => {
    const user = { paid: true };
    const current = {
      tier: "free",
      premiumUntil: null,
      source: null,
      lastChecked: 0,
    };
    const patch = extpayUserToEntitlementPatch(user, current, NOW);
    expect(patch.tier).toBe("premium");
    expect(patch.source).toBe("extensionpay");
    expect(patch.autoRenew).toBe(true);
    expect(patch.premiumUntil).toBe(NOW + EXTPAY_PREMIUM_BUFFER_MS);
    expect(patch.lastChecked).toBe(NOW);
  });

  it("paid + one-time plan → lifetime premium", () => {
    const user = {
      paid: true,
      plan: {
        unitAmountCents: 1999,
        currency: "usd",
        nickname: "lifetime",
        interval: "once",
        intervalCount: null,
      },
    };
    const patch = extpayUserToEntitlementPatch(user, { tier: "free" }, NOW);
    expect(patch.tier).toBe("premium");
    expect(patch.source).toBe("extensionpay");
    expect(patch.premiumUntil).toBeNull();
    expect(patch.autoRenew).toBe(false);
    expect(patch.lastChecked).toBe(NOW);
  });

  it("paid + future subscriptionCancelAt (Date) → premium until cancel date, autoRenew false", () => {
    const cancelAt = new Date(NOW + 60 * DAY);
    const user = { paid: true, subscriptionCancelAt: cancelAt };
    const patch = extpayUserToEntitlementPatch(user, { tier: "free" }, NOW);
    expect(patch.tier).toBe("premium");
    expect(patch.premiumUntil).toBe(cancelAt.getTime());
    expect(patch.autoRenew).toBe(false);
  });

  it("paid + ISO-string subscriptionCancelAt → parsed correctly", () => {
    const cancelDate = new Date(NOW + 30 * DAY);
    const user = {
      paid: true,
      subscriptionCancelAt: cancelDate.toISOString(),
    };
    const patch = extpayUserToEntitlementPatch(user, { tier: "free" }, NOW);
    expect(patch.premiumUntil).toBe(cancelDate.getTime());
  });

  it("paid + past subscriptionCancelAt → falls back to buffer (treats stale cancel as no cancel)", () => {
    const user = {
      paid: true,
      subscriptionCancelAt: new Date(NOW - 5 * DAY),
    };
    const patch = extpayUserToEntitlementPatch(user, { tier: "free" }, NOW);
    expect(patch.premiumUntil).toBe(NOW + EXTPAY_PREMIUM_BUFFER_MS);
  });

  it("paid + active longer promo grant → premiumUntil takes MAX, source extensionpay", () => {
    // User redeemed a promo last week (90 days) and just subscribed.
    // Subscription's 28-day buffer is shorter than the remaining 83 days
    // of promo; promo window should win.
    const promoUntil = NOW + 83 * DAY;
    const current = {
      tier: "premium",
      premiumUntil: promoUntil,
      source: "promo",
      lastChecked: NOW - 7 * DAY,
    };
    const patch = extpayUserToEntitlementPatch({ paid: true }, current, NOW);
    expect(patch.tier).toBe("premium");
    expect(patch.source).toBe("extensionpay"); // subscription is now the path
    expect(patch.premiumUntil).toBe(promoUntil); // but we don't shorten the promo
  });

  it("not paid + active promo grant → leave premium intact, just bump lastChecked", () => {
    const current = {
      tier: "premium",
      premiumUntil: NOW + 60 * DAY,
      source: "promo",
      lastChecked: NOW - DAY,
    };
    const patch = extpayUserToEntitlementPatch({ paid: false }, current, NOW);
    expect(patch).toEqual({ lastChecked: NOW });
  });

  it("not paid + active dev grant (source 'dev') → leave premium intact", () => {
    const current = {
      tier: "premium",
      premiumUntil: NOW + 60 * DAY,
      source: "dev",
      lastChecked: NOW - DAY,
    };
    const patch = extpayUserToEntitlementPatch({ paid: false }, current, NOW);
    expect(patch).toEqual({ lastChecked: NOW });
  });

  it("not paid + active grant with no recorded source (legacy dev-set) → intact", () => {
    const current = {
      tier: "premium",
      premiumUntil: NOW + 60 * DAY,
      source: null,
      lastChecked: NOW - DAY,
    };
    const patch = extpayUserToEntitlementPatch({ paid: false }, current, NOW);
    expect(patch).toEqual({ lastChecked: NOW });
  });

  it("not paid + active extensionpay grace window → leave premium intact", () => {
    const current = {
      tier: "premium",
      premiumUntil: NOW + 14 * DAY,
      source: "extensionpay",
      autoRenew: true,
      lastChecked: NOW - DAY,
    };
    const patch = extpayUserToEntitlementPatch({ paid: false }, current, NOW);
    expect(patch).toEqual({ lastChecked: NOW });
  });

  it("paid + active longer dev grant → premiumUntil takes MAX as floor", () => {
    const devUntil = NOW + 200 * DAY;
    const current = { tier: "premium", premiumUntil: devUntil, source: "dev" };
    const patch = extpayUserToEntitlementPatch({ paid: true }, current, NOW);
    expect(patch.source).toBe("extensionpay");
    expect(patch.premiumUntil).toBe(devUntil);
  });

  it("paid + active longer extensionpay window → does not shorten it", () => {
    const currentUntil = NOW + 60 * DAY;
    const current = {
      tier: "premium",
      premiumUntil: currentUntil,
      source: "extensionpay",
      autoRenew: true,
    };
    const patch = extpayUserToEntitlementPatch({ paid: true }, current, NOW);
    expect(patch.source).toBe("extensionpay");
    expect(patch.premiumUntil).toBe(currentUntil);
  });

  it("not paid + expired promo grant → free tier", () => {
    const current = {
      tier: "premium",
      premiumUntil: NOW - DAY,
      source: "promo",
    };
    const patch = extpayUserToEntitlementPatch({ paid: false }, current, NOW);
    expect(patch.tier).toBe("free");
    expect(patch.premiumUntil).toBeNull();
    expect(patch.source).toBeNull();
    expect(patch.autoRenew).toBe(false);
    expect(patch.lastChecked).toBe(NOW);
  });

  it("not paid + lapsed extensionpay subscription → free tier", () => {
    const current = {
      tier: "premium",
      premiumUntil: NOW - DAY,
      source: "extensionpay",
      autoRenew: false,
    };
    const patch = extpayUserToEntitlementPatch({ paid: false }, current, NOW);
    expect(patch.tier).toBe("free");
    expect(patch.source).toBeNull();
  });

  it("paid: false on fresh install (no current entitlement) → free", () => {
    const patch = extpayUserToEntitlementPatch({ paid: false }, {}, NOW);
    expect(patch.tier).toBe("free");
    expect(patch.lastChecked).toBe(NOW);
  });

  it("guards against malformed current entitlement", () => {
    const patch = extpayUserToEntitlementPatch({ paid: false }, null, NOW);
    expect(patch.tier).toBe("free");
  });

  it("guards against malformed subscriptionCancelAt", () => {
    const user = { paid: true, subscriptionCancelAt: "not-a-date" };
    const patch = extpayUserToEntitlementPatch(user, {}, NOW);
    expect(patch.premiumUntil).toBe(NOW + EXTPAY_PREMIUM_BUFFER_MS);
    expect(patch.autoRenew).toBe(true);
  });
});
