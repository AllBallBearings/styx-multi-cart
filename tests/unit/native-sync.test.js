import { describe, it, expect } from "vitest";
import {
  NATIVE_PREMIUM_BUFFER_MS,
  nativeEntitlementToPatch,
} from "../../lib/native-sync.js";

const NOW = 1_700_000_000_000; // arbitrary fixed epoch
const DAY = 24 * 60 * 60 * 1000;

describe("nativeEntitlementToPatch", () => {
  it("entitled + lifetime → lifetime premium (no expiry)", () => {
    const native = {
      ok: true,
      entitled: true,
      productType: "lifetime",
      expiresAt: 0,
      willAutoRenew: false,
      productId: "com.jaredgoolsby.styx.multicart.pro.lifetime",
    };
    const patch = nativeEntitlementToPatch(native, { tier: "free" }, NOW);
    expect(patch.tier).toBe("premium");
    expect(patch.premiumUntil).toBe(null);
    expect(patch.autoRenew).toBe(false);
    expect(patch.source).toBe("appstore");
    expect(patch.lastChecked).toBe(NOW);
  });

  it("entitled + subscription with expiry → premium until expiry, autoRenew passed through", () => {
    const expiresAt = NOW + 365 * DAY;
    const native = {
      ok: true,
      entitled: true,
      productType: "subscription",
      expiresAt,
      willAutoRenew: true,
      productId: "com.jaredgoolsby.styx.multicart.pro.annual",
    };
    const patch = nativeEntitlementToPatch(native, { tier: "free" }, NOW);
    expect(patch.tier).toBe("premium");
    expect(patch.premiumUntil).toBe(expiresAt);
    expect(patch.autoRenew).toBe(true);
    expect(patch.source).toBe("appstore");
  });

  it("subscription without expiry → premium with buffer", () => {
    const native = {
      ok: true,
      entitled: true,
      productType: "subscription",
      expiresAt: 0,
      willAutoRenew: false,
    };
    const patch = nativeEntitlementToPatch(native, { tier: "free" }, NOW);
    expect(patch.tier).toBe("premium");
    expect(patch.premiumUntil).toBe(NOW + NATIVE_PREMIUM_BUFFER_MS);
  });

  it("subscription expiry never shortens an active grant", () => {
    const longGrant = NOW + 100 * DAY;
    const native = {
      ok: true,
      entitled: true,
      productType: "subscription",
      expiresAt: NOW + 5 * DAY,
      willAutoRenew: true,
    };
    const current = { tier: "premium", premiumUntil: longGrant, source: "promo" };
    const patch = nativeEntitlementToPatch(native, current, NOW);
    expect(patch.premiumUntil).toBe(longGrant);
  });

  it("not entitled but active promo window → only bumps lastChecked", () => {
    const current = {
      tier: "premium",
      premiumUntil: NOW + 30 * DAY,
      source: "promo",
    };
    const native = { ok: true, entitled: false };
    const patch = nativeEntitlementToPatch(native, current, NOW);
    expect(patch).toEqual({ lastChecked: NOW });
  });

  it("not entitled + no active window → free", () => {
    const current = { tier: "premium", premiumUntil: NOW - DAY };
    const native = { ok: true, entitled: false };
    const patch = nativeEntitlementToPatch(native, current, NOW);
    expect(patch.tier).toBe("free");
    expect(patch.premiumUntil).toBe(null);
    expect(patch.source).toBe(null);
  });

  it("missing / malformed native payload → free (no crash)", () => {
    const patch = nativeEntitlementToPatch(undefined, { tier: "free" }, NOW);
    expect(patch.tier).toBe("free");
    expect(patch.lastChecked).toBe(NOW);
  });
});
