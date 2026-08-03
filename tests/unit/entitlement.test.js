/**
 * Unit tests for the entitlement helpers.
 *
 * Spec: docs/MONETIZATION_PLAN.md. The product treats Amazon lists as "carts";
 * per-list tier access is covered in list-access.test.js (computeListAccess).
 * This file covers the premium-active predicate that both surfaces build on.
 */

import { describe, it, expect } from "vitest";
import { isPremiumActive, DEFAULT_ENTITLEMENT } from "../../lib/helpers.js";

const NOW = 1_700_000_000_000; // arbitrary fixed "now" for determinism
const ONE_DAY = 86_400_000;

function freeEnt() {
  return { ...DEFAULT_ENTITLEMENT };
}
function activePremium() {
  return { ...DEFAULT_ENTITLEMENT, tier: "premium", premiumUntil: NOW + 30 * ONE_DAY };
}
function lapsedPremium() {
  return { ...DEFAULT_ENTITLEMENT, tier: "premium", premiumUntil: NOW - ONE_DAY };
}

describe("isPremiumActive", () => {
  it("returns false for default (free) entitlement", () => {
    expect(isPremiumActive(freeEnt(), NOW)).toBe(false);
  });
  it("returns true for premium with future premiumUntil", () => {
    expect(isPremiumActive(activePremium(), NOW)).toBe(true);
  });
  it("returns false for premium whose premiumUntil has passed", () => {
    expect(isPremiumActive(lapsedPremium(), NOW)).toBe(false);
  });
  it("returns true for premium with null premiumUntil (lifetime)", () => {
    expect(isPremiumActive({ tier: "premium", premiumUntil: null }, NOW)).toBe(true);
  });
  it("returns false for null/undefined entitlement", () => {
    expect(isPremiumActive(null, NOW)).toBe(false);
    expect(isPremiumActive(undefined, NOW)).toBe(false);
  });
});
