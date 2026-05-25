/**
 * Unit tests for the entitlement / tier-gating helpers.
 *
 * Spec: docs/MONETIZATION_PLAN.md
 *   - Free tier: up to FREE_CART_LIMIT saved carts, all editable.
 *   - Premium tier: up to PREMIUM_CART_LIMIT saved carts, all editable.
 *   - Lapsed premium: existing carts visible, only top FREE_CART_LIMIT by
 *     lastUsedAt are editable; the rest are read-only.
 *   - Deletion is always allowed (handled at the handler layer, not the gate).
 */

import { describe, it, expect } from "vitest";
import {
  isPremiumActive,
  cartLimitFor,
  topNCartIdsByLastUsed,
  computeCartAccess,
  canCreateSavedCart,
  canEditCart,
  backfillLastUsedAt,
  FREE_CART_LIMIT,
  PREMIUM_CART_LIMIT,
  DEFAULT_ENTITLEMENT,
} from "../../lib/helpers.js";

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

function cart(id, lastUsedAt, savedAt = lastUsedAt) {
  return { id, name: id, items: [], host: "www.amazon.com", savedAt, lastUsedAt };
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
  it("returns false for premium with null premiumUntil (malformed)", () => {
    expect(isPremiumActive({ tier: "premium", premiumUntil: null }, NOW)).toBe(false);
  });
  it("returns false for null/undefined entitlement", () => {
    expect(isPremiumActive(null, NOW)).toBe(false);
    expect(isPremiumActive(undefined, NOW)).toBe(false);
  });
});

describe("cartLimitFor", () => {
  it("uses free limit when not premium", () => {
    expect(cartLimitFor(freeEnt(), NOW)).toBe(FREE_CART_LIMIT);
    expect(cartLimitFor(lapsedPremium(), NOW)).toBe(FREE_CART_LIMIT);
  });
  it("uses premium limit when active", () => {
    expect(cartLimitFor(activePremium(), NOW)).toBe(PREMIUM_CART_LIMIT);
  });
});

describe("topNCartIdsByLastUsed", () => {
  it("returns ids in descending lastUsedAt order", () => {
    const carts = [
      cart("a", NOW - 1000),
      cart("b", NOW - 500),
      cart("c", NOW - 2000),
    ];
    expect(topNCartIdsByLastUsed(carts, 3)).toEqual(["b", "a", "c"]);
  });
  it("respects n and returns only the top N", () => {
    const carts = [
      cart("a", NOW - 1000),
      cart("b", NOW - 500),
      cart("c", NOW - 2000),
    ];
    expect(topNCartIdsByLastUsed(carts, 2)).toEqual(["b", "a"]);
  });
  it("tiebreaks stably (savedAt desc, then id asc)", () => {
    const carts = [
      cart("a", 100, 50),
      cart("b", 100, 60),  // newer savedAt → ahead of a
      cart("c", 100, 50),  // same as a → id asc (a < c)
    ];
    expect(topNCartIdsByLastUsed(carts, 3)).toEqual(["b", "a", "c"]);
  });
  it("treats missing lastUsedAt as 0", () => {
    const carts = [
      { id: "no-lu", savedAt: 100 },
      cart("touched", 50),
    ];
    expect(topNCartIdsByLastUsed(carts, 2)).toEqual(["touched", "no-lu"]);
  });
  it("returns [] for empty input or n<=0", () => {
    expect(topNCartIdsByLastUsed([], 3)).toEqual([]);
    expect(topNCartIdsByLastUsed([cart("a", 1)], 0)).toEqual([]);
    expect(topNCartIdsByLastUsed(null, 3)).toEqual([]);
  });
});

describe("computeCartAccess", () => {
  it("free user with <=limit carts: all editable", () => {
    const carts = [cart("a", NOW - 10), cart("b", NOW - 20)];
    const acc = computeCartAccess(carts, freeEnt(), NOW);
    expect(acc.editableIds.size).toBe(2);
    expect(acc.readOnlyIds.size).toBe(0);
    expect(acc.limit).toBe(FREE_CART_LIMIT);
  });
  it("premium with 5 carts: all editable", () => {
    const carts = ["a", "b", "c", "d", "e"].map((id, i) => cart(id, NOW - i * 10));
    const acc = computeCartAccess(carts, activePremium(), NOW);
    expect(acc.editableIds.size).toBe(5);
    expect(acc.readOnlyIds.size).toBe(0);
    expect(acc.limit).toBe(PREMIUM_CART_LIMIT);
  });
  it("lapsed premium with 5 carts: top 2 editable, rest read-only", () => {
    const carts = [
      cart("oldest", NOW - 1000),
      cart("newest", NOW - 100),    // ← top
      cart("middle1", NOW - 500),
      cart("second-newest", NOW - 200), // ← top
      cart("middle2", NOW - 800),
    ];
    const acc = computeCartAccess(carts, lapsedPremium(), NOW);
    expect([...acc.editableIds].sort()).toEqual(["newest", "second-newest"].sort());
    expect([...acc.readOnlyIds].sort()).toEqual(["middle1", "middle2", "oldest"].sort());
  });
  it("premium beyond limit: excess carts become read-only", () => {
    const carts = Array.from({ length: PREMIUM_CART_LIMIT + 3 }, (_, i) =>
      cart(`c${i}`, NOW - i)
    );
    const acc = computeCartAccess(carts, activePremium(), NOW);
    expect(acc.editableIds.size).toBe(PREMIUM_CART_LIMIT);
    expect(acc.readOnlyIds.size).toBe(3);
  });
});

describe("canCreateSavedCart", () => {
  it("allows when below free limit", () => {
    const result = canCreateSavedCart([cart("a", 1)], freeEnt(), NOW);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(FREE_CART_LIMIT - 1);
    expect(result.tier).toBe("free");
  });
  it("blocks at free limit with FREE_LIMIT_REACHED code", () => {
    const carts = [cart("a", 1), cart("b", 2)];
    const result = canCreateSavedCart(carts, freeEnt(), NOW);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("FREE_LIMIT_REACHED");
    expect(result.remaining).toBe(0);
  });
  it("allows premium up to PREMIUM_CART_LIMIT", () => {
    const carts = Array.from({ length: PREMIUM_CART_LIMIT - 1 }, (_, i) =>
      cart(`c${i}`, NOW - i)
    );
    const result = canCreateSavedCart(carts, activePremium(), NOW);
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe("premium");
  });
  it("blocks premium at PREMIUM_CART_LIMIT with PREMIUM_LIMIT_REACHED code", () => {
    const carts = Array.from({ length: PREMIUM_CART_LIMIT }, (_, i) =>
      cart(`c${i}`, NOW - i)
    );
    const result = canCreateSavedCart(carts, activePremium(), NOW);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("PREMIUM_LIMIT_REACHED");
  });
  it("lapsed premium with carts beyond free limit: still blocked", () => {
    // User has 5 carts (paid for them) but premium has lapsed. They can't
    // create a new cart because they're already over the free cap.
    const carts = Array.from({ length: 5 }, (_, i) => cart(`c${i}`, NOW - i));
    const result = canCreateSavedCart(carts, lapsedPremium(), NOW);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("FREE_LIMIT_REACHED");
  });
});

describe("canEditCart", () => {
  it("free tier with <=limit carts: all editable", () => {
    const carts = [cart("a", NOW - 10), cart("b", NOW - 20)];
    expect(canEditCart("a", carts, freeEnt(), NOW).allowed).toBe(true);
    expect(canEditCart("b", carts, freeEnt(), NOW).allowed).toBe(true);
  });
  it("lapsed premium: only top 2 by lastUsedAt editable", () => {
    const carts = [
      cart("old", NOW - 1000),
      cart("recent1", NOW - 100),
      cart("recent2", NOW - 200),
      cart("ancient", NOW - 5000),
    ];
    const ent = lapsedPremium();
    expect(canEditCart("recent1", carts, ent, NOW).allowed).toBe(true);
    expect(canEditCart("recent2", carts, ent, NOW).allowed).toBe(true);
    expect(canEditCart("old", carts, ent, NOW).allowed).toBe(false);
    expect(canEditCart("ancient", carts, ent, NOW).allowed).toBe(false);
    expect(canEditCart("old", carts, ent, NOW).code).toBe("CART_LOCKED");
  });
  it("unknown cart id is treated as locked (defensive)", () => {
    const carts = [cart("a", 1)];
    expect(canEditCart("nope", carts, freeEnt(), NOW).allowed).toBe(false);
  });
});

describe("auto-promotion via deletion", () => {
  // The handler-layer behavior we want to verify: when a lapsed user deletes
  // one of their top-2 editable carts, the next-most-recent locked cart
  // should automatically become editable on the next access computation.
  it("after deleting a top-2 cart, the next-recent cart becomes editable", () => {
    const ent = lapsedPremium();
    let carts = [
      cart("a", NOW - 100),  // editable
      cart("b", NOW - 200),  // editable
      cart("c", NOW - 300),  // locked
      cart("d", NOW - 400),  // locked
    ];
    let acc = computeCartAccess(carts, ent, NOW);
    expect(acc.editableIds.has("a")).toBe(true);
    expect(acc.editableIds.has("b")).toBe(true);
    expect(acc.editableIds.has("c")).toBe(false);

    // User deletes "a" — handler is free to do this without a gate.
    carts = carts.filter((c) => c.id !== "a");
    acc = computeCartAccess(carts, ent, NOW);
    expect(acc.editableIds.has("b")).toBe(true);
    expect(acc.editableIds.has("c")).toBe(true);   // ← auto-promoted
    expect(acc.editableIds.has("d")).toBe(false);
  });
});

describe("backfillLastUsedAt", () => {
  it("fills lastUsedAt from savedAt when missing", () => {
    const carts = [
      { id: "a", savedAt: 1000 },
      { id: "b", savedAt: 2000, lastUsedAt: 5000 }, // already set; preserved
      { id: "c" }, // no savedAt either → 0
    ];
    backfillLastUsedAt(carts);
    expect(carts[0].lastUsedAt).toBe(1000);
    expect(carts[1].lastUsedAt).toBe(5000);
    expect(carts[2].lastUsedAt).toBe(0);
  });
  it("is a no-op on non-array input", () => {
    expect(backfillLastUsedAt(null)).toBe(null);
    expect(backfillLastUsedAt(undefined)).toBe(undefined);
  });
});
