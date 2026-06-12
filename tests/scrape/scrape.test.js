/**
 * DOM scraping tests for pageScrapeCart / pageGetCartCount.
 *
 * Each test boots a fresh JSDOM from an Amazon-shaped HTML fixture, pins the
 * relevant globals (document, window, location) so the scraper sees a
 * realistic page context, then asserts the extracted item list. The fixtures
 * under tests/fixtures/amazon/ are intentionally minimal — they exist to lock
 * down the scraper's selector contract so when Amazon ships a layout change
 * and we have to update the fixtures, the tests tell us exactly which
 * selectors regressed.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

import {
  pageScrapeCart,
  pageGetCartCount,
  pageGetCartCountDetailed,
} from "../../lib/scrape.js";

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "amazon"
);

/**
 * Load a fixture into a fresh JSDOM, install its document/window/location on
 * globalThis, and return a teardown function. The scraper accesses `document`,
 * `window`, and `location` as free globals (because it's normally injected
 * into a page via chrome.scripting.executeScript) — so we mirror that here.
 */
function mountFixture(filename, { url = "https://www.amazon.com/gp/cart/view.html" } = {}) {
  const html = readFileSync(path.join(FIXTURE_DIR, filename), "utf8");
  const dom = new JSDOM(html, {
    url,
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("location", dom.window.location);
  vi.stubGlobal("Event", dom.window.Event);
  vi.stubGlobal("URL", dom.window.URL);
  return () => {
    dom.window.close();
  };
}

/**
 * Drive pageScrapeCart through its 700ms setTimeout without sleeping in
 * real time. We can't useFakeTimers globally for jsdom (it interferes with
 * other internals), so we manually progress the scheduler.
 */
async function runScrape() {
  vi.useFakeTimers();
  const p = pageScrapeCart();
  // Push past the internal `await new Promise(r => setTimeout(r, 700))`.
  await vi.advanceTimersByTimeAsync(700);
  const result = await p;
  vi.useRealTimers();
  return result;
}

let teardown = null;

afterEach(() => {
  if (teardown) {
    teardown();
    teardown = null;
  }
  vi.unstubAllGlobals();
});

describe("pageScrapeCart — single item", () => {
  beforeEach(() => {
    teardown = mountFixture("cart-single-item.html");
  });

  it("captures one item with the expected fields", async () => {
    const result = await runScrape();
    expect(result.host).toBe("www.amazon.com");
    expect(result.navCartCount).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      asin: "B000ABCDEF",
      title: "Test Product One",
      quantity: 2,
      price: "$19.99",
    });
    expect(result.items[0].url).toBe(
      "https://www.amazon.com/dp/B000ABCDEF/ref=cart"
    );
  });

  it("picks the largest variant from data-a-dynamic-image", async () => {
    const result = await runScrape();
    expect(result.items[0].image).toBe(
      "https://m.media-amazon.com/images/I/single-item-large.jpg"
    );
  });

  it("returns an ISO-8601 capture timestamp", async () => {
    const result = await runScrape();
    expect(result.capturedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
  });
});

describe("pageScrapeCart — multi item", () => {
  beforeEach(() => {
    teardown = mountFixture("cart-multi-item.html");
  });

  it("captures every item in source order", async () => {
    const result = await runScrape();
    expect(result.items.map((i) => i.asin)).toEqual([
      "B000AAAAAA",
      "B000BBBBBB",
      "B000CCCCCC",
    ]);
  });

  it("reads quantity from each of the three supported shapes", async () => {
    const result = await runScrape();
    const byAsin = Object.fromEntries(result.items.map((i) => [i.asin, i]));
    expect(byAsin.B000AAAAAA.quantity).toBe(2); // select[name=quantity]
    expect(byAsin.B000BBBBBB.quantity).toBe(7); // input[name=quantityBox]
    expect(byAsin.B000CCCCCC.quantity).toBe(3); // .a-dropdown-prompt text
  });

  it("falls back through the price-selector ladder", async () => {
    const result = await runScrape();
    const byAsin = Object.fromEntries(result.items.map((i) => [i.asin, i]));
    expect(byAsin.B000AAAAAA.price).toBe("$9.99"); // .a-price .a-offscreen
    expect(byAsin.B000BBBBBB.price).toBe("14"); // .a-price-whole
    expect(byAsin.B000CCCCCC.price).toBe("$5.50"); // .sc-product-price
  });

  it("prefers .a-truncate-full when available for title", async () => {
    const result = await runScrape();
    const beta = result.items.find((i) => i.asin === "B000BBBBBB");
    expect(beta.title).toBe("Beta Gizmo (extra long title that may truncate)");
  });
});

describe("pageScrapeCart — saved-for-later items", () => {
  beforeEach(() => {
    teardown = mountFixture("cart-with-saved-for-later.html");
  });

  it("captures active items only", async () => {
    const result = await runScrape();
    expect(result.items.map((i) => i.asin)).toEqual(["B000ACTIVE"]);
  });
});

describe("pageScrapeCart — empty cart", () => {
  beforeEach(() => {
    teardown = mountFixture("cart-empty.html");
  });

  it("returns no items and a zero nav cart count", async () => {
    const result = await runScrape();
    expect(result.items).toEqual([]);
    expect(result.navCartCount).toBe(0);
  });
});

describe("pageScrapeCart — spinner / fallback image handling", () => {
  beforeEach(() => {
    teardown = mountFixture("cart-spinner-image.html");
  });

  it("never returns the loadIndicators spinner image", async () => {
    const result = await runScrape();
    for (const item of result.items) {
      expect(item.image).not.toMatch(/loadIndicators/);
      expect(item.image).not.toMatch(/^data:/);
    }
  });

  it("uses img.sc-product-image when present", async () => {
    const result = await runScrape();
    const spin = result.items.find((i) => i.asin === "B000SPINNER");
    expect(spin.image).toBe(
      "https://m.media-amazon.com/images/I/real-product.jpg"
    );
  });

  it("falls back to the first usable img when sc-product-image is missing", async () => {
    const result = await runScrape();
    const fb = result.items.find((i) => i.asin === "B000NOSPI");
    expect(fb.image).toBe("https://m.media-amazon.com/images/I/fallback.jpg");
  });
});

describe("pageScrapeCart — permissive fallback + dedup", () => {
  beforeEach(() => {
    teardown = mountFixture("cart-fallback-permissive.html");
  });

  it("matches legacy markup via the bare [data-asin] selector", async () => {
    const result = await runScrape();
    expect(result.items.length).toBe(1);
    expect(result.items[0].asin).toBe("B000LEGACY");
  });

  it("dedupes repeated ASINs (first occurrence wins)", async () => {
    const result = await runScrape();
    expect(result.items[0].title).toBe("Legacy Item");
  });
});

describe("pageScrapeCart — host extraction", () => {
  it("uses location.hostname so cross-TLD restores work", async () => {
    teardown = mountFixture("cart-single-item.html", {
      url: "https://www.amazon.co.uk/gp/cart/view.html",
    });
    const result = await runScrape();
    expect(result.host).toBe("www.amazon.co.uk");
  });
});

describe("pageGetCartCount", () => {
  it("returns the count of live rows when present", () => {
    teardown = mountFixture("cart-multi-item.html");
    expect(pageGetCartCount()).toBe(3);
  });

  it("falls back to #nav-cart-count when no rows match", () => {
    teardown = mountFixture("cart-empty.html");
    expect(pageGetCartCount()).toBe(0);
  });

  it("counts a live .ewc-item row when present", () => {
    teardown = mountFixture("cart-flyout-ewc.html");
    // The flyout fixture has a single .ewc-item[data-asin] — the live-row
    // selector matches first, so we expect the row count (1), not the nav
    // badge value (3). The text fallback is exercised below.
    expect(pageGetCartCount()).toBe(1);
  });

  it("falls back to the '\\d+ items' text inside .ewc-quantity", () => {
    teardown = mountFixture("cart-flyout-ewc.html");
    // Strip every other count source so we reach the regex on .ewc-quantity.
    document
      .querySelectorAll("[data-asin], #nav-cart-count, #ewc-total-quantity, input[name='totalCartQuantity']")
      .forEach((el) => el.remove());
    expect(pageGetCartCount()).toBe(3);
  });

  it("returns null when no count source is available", () => {
    teardown = mountFixture("cart-empty.html");
    // Remove the #nav-cart-count element AND the cart surface to force the
    // function past every fallback (an empty cart surface now counts as an
    // authoritative zero). We expect null rather than 0.
    document.getElementById("nav-cart-count").remove();
    document.getElementById("sc-active-cart").remove();
    expect(pageGetCartCount()).toBeNull();
  });

  it("skips deleted rows", () => {
    teardown = mountFixture("cart-multi-item.html");
    // Mark one row as deleted; live count should drop to 2.
    const row = document.querySelector("div[data-asin='B000AAAAAA']");
    row.classList.add("sc-list-item-removed");
    expect(pageGetCartCount()).toBe(2);
  });
});

describe("pageGetCartCountDetailed", () => {
  // The source tag is load-bearing: the clear-cart loop compares "rows"
  // readings only against row baselines and "quantity" readings only against
  // quantity baselines, since multi-quantity items make the units diverge.

  it("tags a live-row count with source 'rows'", () => {
    teardown = mountFixture("cart-multi-item.html");
    expect(pageGetCartCountDetailed()).toEqual({ count: 3, source: "rows" });
  });

  it("ignores Amazon's 'Coupon Clipped' box, which carries data-asin but is not a cart item", () => {
    teardown = mountFixture("cart-multi-item.html");
    const coupon = document.createElement("div");
    coupon.className = "a-box a-text-center sc-clipcoupon sc-clipcoupon-container";
    coupon.setAttribute("data-asin", "B0COUPON00");
    coupon.setAttribute("data-itemid", "cf0182bf-3140-47f0");
    coupon.textContent = "Coupon Clipped";
    document.getElementById("sc-active-cart").appendChild(coupon);
    expect(pageGetCartCountDetailed()).toEqual({ count: 3, source: "rows" });
  });

  it("still reads empty when only a 'Coupon Clipped' box remains", () => {
    teardown = mountFixture("cart-empty.html");
    const coupon = document.createElement("div");
    coupon.className = "sc-clipcoupon sc-clipcoupon-container";
    coupon.setAttribute("data-asin", "B0COUPON00");
    coupon.setAttribute("data-itemid", "cf0182bf-3140-47f0");
    document.getElementById("sc-active-cart").appendChild(coupon);
    expect(pageGetCartCountDetailed()).toEqual({ count: 0, source: "rows" });
  });

  it("treats a cart surface with zero rows as an authoritative rows-source empty", () => {
    teardown = mountFixture("cart-empty.html");
    // #sc-active-cart is present with no rows — that outranks the badge.
    expect(pageGetCartCountDetailed()).toEqual({ count: 0, source: "rows" });
  });

  it("ignores a stale non-zero nav badge on the empty-cart page", () => {
    teardown = mountFixture("cart-empty.html");
    // Amazon's badge lags behind delete POSTs: empty cart, badge still "1".
    document.getElementById("nav-cart-count").textContent = "1";
    expect(pageGetCartCountDetailed()).toEqual({ count: 0, source: "rows" });
  });

  it("tags the #nav-cart-count fallback with source 'quantity' when no cart surface exists", () => {
    teardown = mountFixture("cart-empty.html");
    document.getElementById("sc-active-cart").remove();
    document.getElementById("nav-cart-count").textContent = "4";
    expect(pageGetCartCountDetailed()).toEqual({ count: 4, source: "quantity" });
  });

  it("tags the .ewc-quantity text fallback with source 'quantity'", () => {
    teardown = mountFixture("cart-flyout-ewc.html");
    document
      .querySelectorAll("[data-asin], #nav-cart-count, #ewc-total-quantity, input[name='totalCartQuantity']")
      .forEach((el) => el.remove());
    expect(pageGetCartCountDetailed()).toEqual({ count: 3, source: "quantity" });
  });

  it("returns null when no count source is available", () => {
    teardown = mountFixture("cart-empty.html");
    document.getElementById("nav-cart-count").remove();
    document.getElementById("sc-active-cart").remove();
    expect(pageGetCartCountDetailed()).toBeNull();
  });
});
