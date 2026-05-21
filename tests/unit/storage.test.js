import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  readCarts,
  writeCarts,
  readSettings,
  writeSettings,
  getUpsellChoices,
  recordUpsellChoice,
  getRecordedUpsellChoice,
} from "../../lib/storage.js";
import {
  STORAGE_KEY,
  SETTINGS_KEY,
  UPSELL_CHOICES_KEY,
  DEFAULT_SETTINGS,
  UPSELL_TTL_MS,
} from "../../lib/helpers.js";

/**
 * Tiny in-memory chrome.storage.local backing store. sinon-chrome's stubs
 * return undefined by default, which isn't enough to round-trip read/write
 * semantics — we install a fresh map per test and let .get/.set act on it.
 */
function installStorageBackend() {
  const store = new Map();

  chrome.storage.local.get.callsFake((keyOrKeys) => {
    if (keyOrKeys == null) {
      // Full dump
      return Promise.resolve(Object.fromEntries(store));
    }
    if (typeof keyOrKeys === "string") {
      return Promise.resolve(
        store.has(keyOrKeys) ? { [keyOrKeys]: store.get(keyOrKeys) } : {}
      );
    }
    if (Array.isArray(keyOrKeys)) {
      const out = {};
      for (const k of keyOrKeys) if (store.has(k)) out[k] = store.get(k);
      return Promise.resolve(out);
    }
    // Object form: { key: defaultValue }
    const out = {};
    for (const [k, def] of Object.entries(keyOrKeys)) {
      out[k] = store.has(k) ? store.get(k) : def;
    }
    return Promise.resolve(out);
  });

  chrome.storage.local.set.callsFake((obj) => {
    for (const [k, v] of Object.entries(obj)) store.set(k, v);
    return Promise.resolve();
  });

  return store;
}

beforeEach(() => {
  chrome.flush();
});

describe("readCarts / writeCarts", () => {
  it("returns [] when nothing has been stored", async () => {
    installStorageBackend();
    await expect(readCarts()).resolves.toEqual([]);
  });

  it("round-trips an array through write+read", async () => {
    installStorageBackend();
    const carts = [{ id: "a", name: "Cart A", items: [] }];
    await writeCarts(carts);
    await expect(readCarts()).resolves.toEqual(carts);
  });

  it("guards against non-array stored values", async () => {
    const store = installStorageBackend();
    store.set(STORAGE_KEY, { not: "an array" });
    await expect(readCarts()).resolves.toEqual([]);
  });

  it("writes under the canonical storage key", async () => {
    const store = installStorageBackend();
    await writeCarts([{ id: "x" }]);
    expect(store.get(STORAGE_KEY)).toEqual([{ id: "x" }]);
  });
});

describe("readSettings / writeSettings", () => {
  it("returns DEFAULT_SETTINGS when nothing has been stored", async () => {
    installStorageBackend();
    await expect(readSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it("merges stored settings on top of defaults (forward-compat)", async () => {
    const store = installStorageBackend();
    // Simulate an old shape missing a field we later added.
    store.set(SETTINGS_KEY, { interceptAtc: false });
    await expect(readSettings()).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      interceptAtc: false,
    });
  });

  it("ignores a non-object stored value and returns defaults", async () => {
    const store = installStorageBackend();
    store.set(SETTINGS_KEY, "corrupt");
    await expect(readSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it("writeSettings applies a partial patch and returns the merged result", async () => {
    installStorageBackend();
    const next = await writeSettings({ interceptAtc: false });
    expect(next).toEqual({ ...DEFAULT_SETTINGS, interceptAtc: false });
    await expect(readSettings()).resolves.toEqual(next);
  });

  it("writeSettings(null) is a no-op patch but still persists current state", async () => {
    installStorageBackend();
    const next = await writeSettings(null);
    expect(next).toEqual(DEFAULT_SETTINGS);
  });
});

describe("upsell choice storage", () => {
  it("getUpsellChoices returns {} when nothing stored", async () => {
    installStorageBackend();
    await expect(getUpsellChoices()).resolves.toEqual({});
  });

  it("recordUpsellChoice stamps recordedAt and persists", async () => {
    installStorageBackend();
    const before = Date.now();
    await recordUpsellChoice("B000ABC", { choice: "decline" });
    const after = Date.now();

    const map = await getUpsellChoices();
    expect(map).toHaveProperty("B000ABC");
    expect(map.B000ABC.choice).toBe("decline");
    expect(map.B000ABC.recordedAt).toBeGreaterThanOrEqual(before);
    expect(map.B000ABC.recordedAt).toBeLessThanOrEqual(after);
  });

  it("recordUpsellChoice is a no-op when asin is falsy", async () => {
    const store = installStorageBackend();
    await recordUpsellChoice("", { choice: "decline" });
    await recordUpsellChoice(null, { choice: "accept" });
    expect(store.has(UPSELL_CHOICES_KEY)).toBe(false);
  });

  it("getRecordedUpsellChoice returns null for missing or empty asin", async () => {
    installStorageBackend();
    await expect(getRecordedUpsellChoice("")).resolves.toBeNull();
    await expect(getRecordedUpsellChoice("B000MISSING")).resolves.toBeNull();
  });

  it("getRecordedUpsellChoice returns the recorded entry", async () => {
    installStorageBackend();
    await recordUpsellChoice("B000XYZ", { choice: "accept", price: "9.99" });
    const got = await getRecordedUpsellChoice("B000XYZ");
    expect(got).toMatchObject({ choice: "accept", price: "9.99" });
  });

  it("prunes expired entries on read and writes back the pruned shape", async () => {
    const store = installStorageBackend();
    const now = Date.now();
    store.set(UPSELL_CHOICES_KEY, {
      FRESH: { recordedAt: now - 1000, choice: "decline" },
      STALE: { recordedAt: now - UPSELL_TTL_MS - 1, choice: "accept" },
    });

    const map = await getUpsellChoices();
    expect(Object.keys(map)).toEqual(["FRESH"]);
    // Writeback should have shrunk the stored value too.
    expect(store.get(UPSELL_CHOICES_KEY)).toEqual({
      FRESH: { recordedAt: expect.any(Number), choice: "decline" },
    });
  });

  it("does not write back when nothing was pruned", async () => {
    const store = installStorageBackend();
    store.set(UPSELL_CHOICES_KEY, {
      FRESH: { recordedAt: Date.now(), choice: "decline" },
    });
    chrome.storage.local.set.resetHistory();

    await getUpsellChoices();
    expect(chrome.storage.local.set.called).toBe(false);
  });
});
