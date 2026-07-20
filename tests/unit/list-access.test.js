import { describe, it, expect } from "vitest";
import { computeListAccess, FREE_CART_LIMIT } from "../../lib/helpers.js";

const FREE = { tier: "free", premiumUntil: null };
const PREMIUM = { tier: "premium", premiumUntil: null }; // lifetime

// Build a list of the given kinds in order.
function lists(...kinds) {
  return kinds.map((kind, i) => ({
    listId: `L${i}`,
    name: `list-${i}`,
    url: `https://amazon.com/hz/wishlist/ls/L${i}`,
    count: null,
    kind,
  }));
}
const accessOf = (res) => res.lists.map((l) => l.access);

describe("computeListAccess", () => {
  it(`free tier: first ${FREE_CART_LIMIT} custom lists editable, rest locked`, () => {
    // One more custom than the limit → exactly one locked at the end.
    const res = computeListAccess(
      lists(...Array(FREE_CART_LIMIT + 1).fill("custom")),
      FREE
    );
    const expected = Array(FREE_CART_LIMIT + 1)
      .fill("editable")
      .map((v, i) => (i < FREE_CART_LIMIT ? "editable" : "locked"));
    expect(accessOf(res)).toEqual(expected);
    expect(res.customCount).toBe(FREE_CART_LIMIT + 1);
    expect(res.isPremium).toBe(false);
  });

  it("default (Wish List) and Alexa lists never count and are always editable", () => {
    // A default + an alexa + (FREE_CART_LIMIT + 1) customs. Defaults don't
    // consume slots, so only the last custom overflows into "locked".
    const kinds = ["default", "alexa", ...Array(FREE_CART_LIMIT + 1).fill("custom")];
    const res = computeListAccess(lists(...kinds), FREE);
    const byId = Object.fromEntries(res.lists.map((l) => [l.listId, l.access]));
    expect(byId.L0).toBe("editable"); // default
    expect(byId.L1).toBe("editable"); // alexa
    for (let i = 0; i < FREE_CART_LIMIT; i++) {
      expect(byId[`L${2 + i}`]).toBe("editable"); // customs within limit
    }
    expect(byId[`L${2 + FREE_CART_LIMIT}`]).toBe("locked"); // overflow custom
    expect(res.customCount).toBe(FREE_CART_LIMIT + 1);
  });

  it("premium unlocks every custom list", () => {
    const res = computeListAccess(
      lists(...Array(FREE_CART_LIMIT + 3).fill("custom")),
      PREMIUM
    );
    expect(res.lists.every((l) => l.access === "editable")).toBe(true);
    expect(res.isPremium).toBe(true);
  });

  it("missing kind defaults to custom and is gated", () => {
    const raw = Array.from({ length: FREE_CART_LIMIT + 1 }, (_, i) => ({
      listId: `X${i}`,
      name: `x${i}`,
    }));
    const res = computeListAccess(raw, FREE);
    expect(res.customCount).toBe(FREE_CART_LIMIT + 1);
    expect(res.lists[FREE_CART_LIMIT].access).toBe("locked");
  });

  it("exactly at the limit: all custom carts editable", () => {
    const res = computeListAccess(
      lists(...Array(FREE_CART_LIMIT).fill("custom")),
      FREE
    );
    expect(res.lists.every((l) => l.access === "editable")).toBe(true);
  });

  it("handles empty / non-array input", () => {
    expect(computeListAccess([], FREE).lists).toEqual([]);
    expect(computeListAccess(null, FREE).lists).toEqual([]);
    expect(computeListAccess(undefined, FREE).customCount).toBe(0);
  });

  it("does not mutate the input list objects", () => {
    const input = lists(...Array(FREE_CART_LIMIT + 1).fill("custom"));
    computeListAccess(input, FREE);
    expect(input.every((l) => !("access" in l))).toBe(true);
  });
});
