/**
 * lib/clear-cart.js — pure decision logic for the clear-cart loop in
 * src/background/index.js, extracted for unit testing.
 *
 * Cart counts come in two units that must never be cross-compared:
 *   - "rows":     cart line items — what one MC_CLEAR_ONE delete removes.
 *   - "quantity": the nav badge, which sums per-item quantities.
 * A cart holding multi-quantity items makes the two diverge, and during a
 * page reload the quantity badge renders before the row elements do.
 */

/**
 * Decide what the clear-cart loop should do after one MC_CLEAR_ONE delete
 * settles.
 *
 * @param {object} input
 * @param {object} input.settled - result of waitForCartSettleAfterDelete:
 *   { rows, quantity, changed } where rows/quantity are the latest reading
 *   in each unit (or null if never observed) and changed is true when a
 *   count dropped against its own pre-delete baseline.
 * @param {number|null} input.beforeRows - row count before the delete.
 * @param {number|null} input.beforeQuantity - quantity badge before the delete.
 * @param {number} input.stalledDeletes - consecutive settles with no progress.
 * @returns {{
 *   action: "progress"|"retry"|"stuck"|"blind",
 *   removedDelta: number,
 *   lastKnownRows: number|null,
 *   empty: boolean,
 * }}
 *   - "progress": the delete landed; add removedDelta, reset the stall
 *     counter, and continue (or stop if empty).
 *   - "retry": no count moved but the readings are trustworthy — Amazon
 *     sometimes swallows the first activation. Retry the same row once.
 *   - "stuck": still no movement after a retry; abort so we never loop on a
 *     cart that refuses to shrink.
 *   - "blind": no usable reading in either unit (unusual Amazon layout).
 *     Assume the activated delete control worked, as the pre-verification
 *     code did; the final cart check still has the last word.
 */
export function evaluateClearStep({ settled, beforeRows, beforeQuantity, stalledDeletes }) {
  const rows = settled && Number.isFinite(settled.rows) ? settled.rows : null;
  const quantity = settled && Number.isFinite(settled.quantity) ? settled.quantity : null;
  const changed = Boolean(settled && settled.changed);

  const rowsDropped = rows != null && beforeRows != null && rows < beforeRows;
  if (changed || rowsDropped) {
    return {
      action: "progress",
      // Rows map 1:1 to deletes, so a multi-row drop (Amazon collapsed a
      // duplicate, a reload pruned stale rows) counts every removed row. A
      // quantity-only drop proves the delete landed but not how many rows
      // went with it — count the one row we know we deleted.
      removedDelta: rowsDropped ? Math.max(1, beforeRows - rows) : 1,
      lastKnownRows: rows,
      empty: rows === 0 || (rows == null && quantity === 0),
    };
  }

  // Not changed: every reading the settle watcher saw stayed at or above its
  // own baseline. If we have a reading in at least one comparable unit, the
  // delete genuinely didn't land.
  const sawSteadyReading =
    rows != null || (quantity != null && beforeQuantity != null);
  if (sawSteadyReading) {
    return {
      action: stalledDeletes === 0 ? "retry" : "stuck",
      removedDelta: 0,
      lastKnownRows: rows,
      empty: false,
    };
  }

  return { action: "blind", removedDelta: 1, lastKnownRows: null, empty: false };
}
