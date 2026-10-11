/**
 * The service worker serializes long operations (save / clear / restore /
 * add-to-list) with an exclusive lock, because two of them running at once
 * fight over the same Amazon tabs (a second Save makes a duplicate list; a
 * Clear mid-save wipes the cart before it's captured). A lock that can get
 * stuck would be worse than none, so these tests pin the guarantees:
 * it excludes, it always releases, and it expires if something goes wrong.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = fs.readFileSync(path.join(ROOT, "src", "background", "index.js"), "utf8");

// Pull the lock block out of the (un-exported) service-worker source.
const start = src.indexOf("const OP_LOCK_STALE_MS");
const end = src.indexOf("/**\n * Set the current in-progress status");
if (start < 0 || end < 0) throw new Error("op-lock block not found in src/background/index.js");
const lock = new Function(
  `${src.slice(start, end)}
   return { OP_LOCK_STALE_MS, OP_LOCK_KIND_BY_MESSAGE, isOpLocked, acquireOpLock, releaseOpLock, runLocked,
            peek: () => _opLock, listsVersion: () => _listsVersion };`
)();

describe("operation lock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    lock.releaseOpLock();
  });
  afterEach(() => vi.useRealTimers());

  it("excludes a second operation and records who holds it", () => {
    expect(lock.acquireOpLock("save")).toBe(true);
    expect(lock.acquireOpLock("clear")).toBe(false);
    expect(lock.isOpLocked()).toBe(true);
    expect(lock.peek().kind).toBe("save");
  });

  it("can be re-acquired once released", () => {
    lock.acquireOpLock("save");
    lock.releaseOpLock();
    expect(lock.isOpLocked()).toBe(false);
    expect(lock.acquireOpLock("clear")).toBe(true);
  });

  it("expires by itself so a lost release can never strand the extension", () => {
    lock.acquireOpLock("restore");
    vi.setSystemTime(Date.now() + lock.OP_LOCK_STALE_MS - 1);
    expect(lock.isOpLocked()).toBe(true);
    vi.setSystemTime(Date.now() + 2);
    expect(lock.isOpLocked()).toBe(false);
    expect(lock.acquireOpLock("save")).toBe(true);
  });

  it("runLocked releases when the work succeeds", async () => {
    lock.acquireOpLock("save");
    await expect(lock.runLocked(async () => "done")).resolves.toBe("done");
    expect(lock.isOpLocked()).toBe(false);
  });

  it("runLocked releases even when the work throws", async () => {
    lock.acquireOpLock("save");
    await expect(
      lock.runLocked(async () => {
        throw new Error("scrape failed");
      })
    ).rejects.toThrow("scrape failed");
    expect(lock.isOpLocked()).toBe(false);
  });

  it("covers every user-triggered long operation with the right kind", () => {
    expect(lock.OP_LOCK_KIND_BY_MESSAGE).toMatchObject({
      MC_SAVE_FOR_LATER: "save",
      MC_SAVE_AND_CLEAR: "clear",
      MC_CLEAR_CURRENT: "clear",
      MC_SAVE_LIVE_CART_TO_LIST: "save",
      MC_WISHLIST_ADD_ALL: "restore",
      MC_ADD_ITEM_TO_AMAZON_LIST: "list",
      MC_CREATE_AMAZON_LIST_WITH_ITEM: "list",
    });
  });
});

describe("lists version (tells the panel to reload its carts)", () => {
  beforeEach(() => lock.releaseOpLock());

  it("bumps when a save finishes", () => {
    const before = lock.listsVersion();
    lock.acquireOpLock("save");
    lock.releaseOpLock();
    expect(lock.listsVersion()).toBe(before + 1);
  });

  it("bumps when a create-list / add-to-list operation finishes", () => {
    const before = lock.listsVersion();
    lock.acquireOpLock("list");
    lock.releaseOpLock();
    expect(lock.listsVersion()).toBe(before + 1);
  });

  it("does not bump for operations that leave the set of carts alone", () => {
    const before = lock.listsVersion();
    for (const kind of ["clear", "restore"]) {
      lock.acquireOpLock(kind);
      lock.releaseOpLock();
    }
    expect(lock.listsVersion()).toBe(before);
  });

  it("bumps when the work ends through runLocked, even if it throws", async () => {
    const before = lock.listsVersion();
    lock.acquireOpLock("save");
    await expect(lock.runLocked(async () => { throw new Error("boom"); })).rejects.toThrow();
    expect(lock.listsVersion()).toBe(before + 1);
  });

  it("does not bump when nothing was locked", () => {
    const before = lock.listsVersion();
    lock.releaseOpLock();
    expect(lock.listsVersion()).toBe(before);
  });

  it("is reported by MC_GET_STATUS", () => {
    expect(src).toMatch(/listsVersion: _listsVersion,/);
  });
});

describe("listener wiring", () => {
  it("every fire-and-forget hand-off both flags itself and runs under runLocked", () => {
    const lines = src.split("\n");
    const handoffs = lines
      .map((l, i) => (l.includes("lockHandedOff = true") ? i : -1))
      .filter((i) => i >= 0);
    expect(handoffs.length).toBe(3); // clear, save/save-and-clear, wishlist add-all
    for (const i of handoffs) {
      // the setTimeout that launches the background work follows within a few lines
      const next = lines.slice(i + 1, i + 4).join("\n");
      expect(next).toMatch(/setTimeout\(\(\) => runLocked\(/);
    }
  });

  it("releases the lock in a finally when the handler did not hand off", () => {
    expect(src).toMatch(/finally \{[^}]*if \(lockHeld && !lockHandedOff\) releaseOpLock\(\);/s);
  });

  it("derives busy from the lock alone, not from a status an error path may leave active", () => {
    expect(src).toMatch(/busy: locked,/);
    // a failed live-cart save must END its status rather than leave it active
    expect(src).not.toMatch(/setOpStatus\(t\("popup_err_saveToAmazonFailed"\)/);
  });
});
