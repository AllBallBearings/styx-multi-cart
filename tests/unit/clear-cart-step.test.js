/**
 * Decision-table tests for evaluateClearStep — the pure logic that drives the
 * clear-cart loop in src/background/index.js after each MC_CLEAR_ONE delete
 * settles. The two count units ("rows" = cart line items, "quantity" = nav
 * badge summing per-item quantities) must never be cross-compared; these
 * tests lock that contract down.
 */

import { describe, it, expect } from "vitest";
import { evaluateClearStep } from "../../lib/clear-cart.js";

const step = (overrides = {}) =>
  evaluateClearStep({
    settled: { rows: null, quantity: null, changed: false },
    beforeRows: null,
    beforeQuantity: null,
    stalledDeletes: 0,
    ...overrides,
  });

describe("evaluateClearStep — progress", () => {
  it("counts one removal when the row count drops by one", () => {
    const result = step({
      settled: { rows: 2, quantity: null, changed: true },
      beforeRows: 3,
    });
    expect(result).toEqual({
      action: "progress",
      removedDelta: 1,
      lastKnownRows: 2,
      empty: false,
    });
  });

  it("counts every removed row when a reload prunes several at once", () => {
    const result = step({
      settled: { rows: 2, quantity: null, changed: true },
      beforeRows: 5,
    });
    expect(result.action).toBe("progress");
    expect(result.removedDelta).toBe(3);
  });

  it("flags empty when the row count reaches zero", () => {
    const result = step({
      settled: { rows: 0, quantity: null, changed: true },
      beforeRows: 1,
    });
    expect(result.action).toBe("progress");
    expect(result.empty).toBe(true);
  });

  it("flags empty on a zero quantity reading with no row reading", () => {
    const result = step({
      settled: { rows: null, quantity: 0, changed: true },
      beforeRows: 1,
      beforeQuantity: 3,
    });
    expect(result.action).toBe("progress");
    expect(result.removedDelta).toBe(1);
    expect(result.empty).toBe(true);
  });

  it("counts exactly one removal on a quantity-only drop (row delta unknown)", () => {
    // A multi-quantity item dropped the badge 6 → 4, but rows never rendered
    // during the settle window. We deleted one row; claim no more than that.
    const result = step({
      settled: { rows: null, quantity: 4, changed: true },
      beforeRows: 3,
      beforeQuantity: 6,
    });
    expect(result).toEqual({
      action: "progress",
      removedDelta: 1,
      lastKnownRows: null,
      empty: false,
    });
  });

  it("treats a row drop as progress even if the watcher missed it (changed=false)", () => {
    const result = step({
      settled: { rows: 1, quantity: null, changed: false },
      beforeRows: 2,
    });
    expect(result.action).toBe("progress");
    expect(result.removedDelta).toBe(1);
  });

  it("does not cross-compare a quantity reading against the row baseline", () => {
    // Badge shows 6 (quantity units) vs 3 rows before the delete. 6 > 3 must
    // NOT read as "cart grew" — without a same-unit drop this is a stall, not
    // progress and not a hard failure.
    const result = step({
      settled: { rows: null, quantity: 6, changed: false },
      beforeRows: 3,
      beforeQuantity: 6,
    });
    expect(result.action).toBe("retry");
  });
});

describe("evaluateClearStep — stall handling", () => {
  it("retries once when rows hold steady", () => {
    const result = step({
      settled: { rows: 3, quantity: null, changed: false },
      beforeRows: 3,
      stalledDeletes: 0,
    });
    expect(result.action).toBe("retry");
    expect(result.removedDelta).toBe(0);
  });

  it("gives up after a second consecutive stall", () => {
    const result = step({
      settled: { rows: 3, quantity: null, changed: false },
      beforeRows: 3,
      stalledDeletes: 1,
    });
    expect(result.action).toBe("stuck");
  });

  it("stalls rather than assumes success when rows hold steady without a baseline", () => {
    const result = step({
      settled: { rows: 3, quantity: null, changed: false },
      beforeRows: null,
    });
    expect(result.action).toBe("retry");
  });

  it("stalls on a steady quantity reading with a quantity baseline", () => {
    const result = step({
      settled: { rows: null, quantity: 6, changed: false },
      beforeQuantity: 6,
      stalledDeletes: 1,
    });
    expect(result.action).toBe("stuck");
  });
});

describe("evaluateClearStep — blind fallback", () => {
  it("assumes one removal when no reading was observed at all", () => {
    const result = step({
      settled: { rows: null, quantity: null, changed: false },
      beforeRows: 3,
    });
    expect(result).toEqual({
      action: "blind",
      removedDelta: 1,
      lastKnownRows: null,
      empty: false,
    });
  });

  it("assumes one removal on a quantity reading with no baseline to compare", () => {
    const result = step({
      settled: { rows: null, quantity: 6, changed: false },
      beforeQuantity: null,
    });
    expect(result.action).toBe("blind");
  });

  it("tolerates a missing settled object", () => {
    const result = step({ settled: null });
    expect(result.action).toBe("blind");
  });
});
