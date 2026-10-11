import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../src/background/index.js", import.meta.url), "utf8");
const start = source.indexOf("async function bumpCachedAmazonListCount(listId, delta) {");
const end = source.indexOf("\n\n", source.indexOf("\n}", start) + 2);
if (start < 0 || end < 0) throw new Error("bumpCachedAmazonListCount not found");
const block = source.slice(start, end);

function setup(count) {
  const snapshot = {
    host: "www.amazon.com",
    fetchedAt: 123,
    lists: [{ listId: "HOLIDAY123", name: "Holiday", count }],
  };
  const set = vi.fn(async () => {});
  const chrome = { storage: { local: {
    get: vi.fn(async () => ({ "mc.amazonlists.v1": snapshot })), set,
  } } };
  const bump = new Function("chrome", "AMAZON_LISTS_CACHE_KEY", `${block}; return bumpCachedAmazonListCount;`)(
    chrome, "mc.amazonlists.v1"
  );
  return { bump, set, snapshot };
}

describe("cached Amazon list count after an add", () => {
  it("updates a known count without a fresh list scrape or resetting cache age", async () => {
    const { bump, set, snapshot } = setup(2);
    await bump("holiday123", 1);
    expect(set).toHaveBeenCalledWith({ "mc.amazonlists.v1": {
      ...snapshot, lists: [{ listId: "HOLIDAY123", name: "Holiday", count: 3 }],
    } });
    expect(snapshot.fetchedAt).toBe(123);
  });

  it("does not invent a count when Amazon has not provided one", async () => {
    const { bump, set } = setup(null);
    await bump("HOLIDAY123", 1);
    expect(set).not.toHaveBeenCalled();
  });
});
