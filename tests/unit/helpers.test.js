import { describe, it, expect } from "vitest";
import {
  makeId,
  prunePendingAtc,
  pruneUpsellChoices,
  getUrlHost,
  normalizeAmazonHost,
  sameAmazonHost,
  isAmazonCartUrl,
  isAmazonUrl,
  isUpsellUrl,
  normalizeUrlForWait,
  buildBulkAddUrl,
  chunkItemsForBulk,
  AMAZON_TLDS,
  PENDING_ATC_TTL_MS,
  UPSELL_TTL_MS,
} from "../../lib/helpers.js";

describe("makeId", () => {
  it("returns a non-empty string containing a hyphen", () => {
    const id = makeId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(3);
    expect(id).toContain("-");
  });

  it("is unique across rapid calls", () => {
    const ids = new Set();
    for (let i = 0; i < 200; i++) ids.add(makeId());
    // Allow a one-in-a-million collision but flag systemic dupes.
    expect(ids.size).toBeGreaterThanOrEqual(199);
  });
});

describe("prunePendingAtc", () => {
  it("removes entries older than the TTL", () => {
    const now = 10_000_000;
    const map = new Map([
      [1, { at: now - PENDING_ATC_TTL_MS - 1 }], // expired
      [2, { at: now - 1000 }], // fresh
    ]);
    prunePendingAtc(map, now);
    expect(map.has(1)).toBe(false);
    expect(map.has(2)).toBe(true);
  });

  it("is a no-op on an empty map", () => {
    const map = new Map();
    prunePendingAtc(map, 0);
    expect(map.size).toBe(0);
  });
});

describe("pruneUpsellChoices", () => {
  it("keeps entries within TTL and drops the rest", () => {
    const now = 10_000_000;
    const result = pruneUpsellChoices(
      {
        B000FRESH: { recordedAt: now - 1000, choice: "decline" },
        B000STALE: { recordedAt: now - UPSELL_TTL_MS - 1, choice: "accept" },
        B000NOAT: { choice: "decline" }, // missing recordedAt — drop
      },
      now
    );
    expect(Object.keys(result)).toEqual(["B000FRESH"]);
  });

  it("tolerates null / undefined input", () => {
    expect(pruneUpsellChoices(null)).toEqual({});
    expect(pruneUpsellChoices(undefined)).toEqual({});
  });

  it("skips falsy entry values without throwing", () => {
    const out = pruneUpsellChoices({ A: null, B: undefined }, Date.now());
    expect(out).toEqual({});
  });
});

describe("getUrlHost", () => {
  it("extracts the hostname from a valid URL", () => {
    expect(getUrlHost("https://www.amazon.com/gp/cart")).toBe("www.amazon.com");
    expect(getUrlHost("https://amazon.co.uk/cart")).toBe("amazon.co.uk");
  });

  it("returns an empty string for garbage input", () => {
    expect(getUrlHost("not a url")).toBe("");
    expect(getUrlHost(null)).toBe("");
    expect(getUrlHost(undefined)).toBe("");
  });
});

describe("normalizeAmazonHost", () => {
  it("lowercases and strips a leading www.", () => {
    expect(normalizeAmazonHost("WWW.Amazon.COM")).toBe("amazon.com");
    expect(normalizeAmazonHost("amazon.co.uk")).toBe("amazon.co.uk");
  });

  it("does not strip subdomains other than www", () => {
    expect(normalizeAmazonHost("smile.amazon.com")).toBe("smile.amazon.com");
  });

  it("defaults nullish input to the US storefront", () => {
    expect(normalizeAmazonHost(null)).toBe("amazon.com");
    expect(normalizeAmazonHost(undefined)).toBe("amazon.com");
  });
});

describe("sameAmazonHost", () => {
  it("treats www and bare host as equal", () => {
    expect(sameAmazonHost("www.amazon.com", "amazon.com")).toBe(true);
  });

  it("distinguishes different TLDs", () => {
    expect(sameAmazonHost("amazon.com", "amazon.co.uk")).toBe(false);
  });

  it("treats hostless legacy carts as US carts", () => {
    expect(sameAmazonHost("", "www.amazon.com")).toBe(true);
    expect(sameAmazonHost(null, "www.amazon.co.uk")).toBe(false);
  });
});

describe("isAmazonCartUrl", () => {
  const cartUrls = [
    "https://www.amazon.com/gp/cart/view.html",
    "https://amazon.com/cart",
    "https://www.amazon.co.uk/cart?ref=foo",
    "https://www.amazon.de/gp/cart",
    "https://www.amazon.com.br/cart#anchor",
  ];

  const nonCartUrls = [
    "https://www.amazon.com/dp/B000ABCDEF",
    "https://www.amazon.com/gp/product/B000",
    "https://www.example.com/cart",
    "https://www.amazon.com/cartoon",
    "",
    null,
    undefined,
  ];

  for (const url of cartUrls) {
    it(`recognises cart URL: ${url}`, () => {
      expect(isAmazonCartUrl(url)).toBe(true);
    });
  }

  for (const url of nonCartUrls) {
    it(`rejects non-cart URL: ${String(url)}`, () => {
      expect(isAmazonCartUrl(url)).toBe(false);
    });
  }
});

describe("isAmazonUrl", () => {
  it("matches all supported TLDs", () => {
    for (const tld of AMAZON_TLDS) {
      expect(isAmazonUrl(`https://www.${tld}/anything`)).toBe(true);
    }
  });

  it("rejects non-Amazon hosts and falsy input", () => {
    expect(isAmazonUrl("https://www.example.com/")).toBe(false);
    expect(isAmazonUrl("")).toBe(false);
    expect(isAmazonUrl(null)).toBe(false);
  });
});

describe("isUpsellUrl", () => {
  const upsellUrls = [
    "https://www.amazon.com/gp/attach/warranty",
    "https://www.amazon.com/some/attach-warranty/path",
    "https://www.amazon.com/protection-plan",
    "https://www.amazon.com/service-plan/info",
  ];

  for (const url of upsellUrls) {
    it(`flags upsell URL: ${url}`, () => {
      expect(isUpsellUrl(url)).toBe(true);
    });
  }

  it("does not flag a normal cart URL", () => {
    expect(isUpsellUrl("https://www.amazon.com/gp/cart")).toBe(false);
  });

  it("handles falsy input", () => {
    expect(isUpsellUrl(null)).toBe(false);
    expect(isUpsellUrl("")).toBe(false);
  });
});

describe("normalizeUrlForWait", () => {
  it("strips trailing slash and hash from a valid URL", () => {
    expect(normalizeUrlForWait("https://www.amazon.com/gp/cart/#anchor")).toBe(
      "https://www.amazon.com/gp/cart"
    );
  });

  it("falls back to string manipulation for invalid URLs", () => {
    expect(normalizeUrlForWait("not-a-url/#frag")).toBe("not-a-url");
  });

  it("tolerates nullish input", () => {
    expect(normalizeUrlForWait(null)).toBe("");
    expect(normalizeUrlForWait(undefined)).toBe("");
  });

  it("treats two URLs differing only in trailing slash / hash as equal", () => {
    const a = normalizeUrlForWait("https://www.amazon.com/cart");
    const b = normalizeUrlForWait("https://www.amazon.com/cart/#x");
    expect(a).toBe(b);
  });
});

describe("buildBulkAddUrl", () => {
  it("builds an Amazon bulk-add URL with ASIN.N / Quantity.N params", () => {
    const url = buildBulkAddUrl(
      "www.amazon.com",
      [
        { asin: "b000abcdef", quantity: 2 },
        { asin: "B000XYZ", quantity: 1 },
      ]
    );
    expect(url).toMatch(
      /^https:\/\/www\.amazon\.com\/gp\/aws\/cart\/add\.html\?/
    );
    const params = new URL(url).searchParams;
    expect(params.get("ASIN.1")).toBe("B000ABCDEF"); // upper-cased
    expect(params.get("Quantity.1")).toBe("2");
    expect(params.get("ASIN.2")).toBe("B000XYZ");
    expect(params.get("Quantity.2")).toBe("1");
  });

  it("clamps quantity into [1, 99]", () => {
    const params = new URL(
      buildBulkAddUrl("www.amazon.com", [
        { asin: "A", quantity: 0 },
        { asin: "B", quantity: 999 },
        { asin: "C", quantity: -5 },
        { asin: "D", quantity: "garbage" },
      ])
    ).searchParams;
    expect(params.get("Quantity.1")).toBe("1");
    expect(params.get("Quantity.2")).toBe("99");
    expect(params.get("Quantity.3")).toBe("1");
    expect(params.get("Quantity.4")).toBe("1");
  });

  it("includes affiliate tag params only when supplied", () => {
    const noTag = new URL(
      buildBulkAddUrl("www.amazon.com", [{ asin: "A", quantity: 1 }])
    ).searchParams;
    expect(noTag.get("tag")).toBeNull();
    expect(noTag.get("AssociateTag")).toBeNull();

    const withTag = new URL(
      buildBulkAddUrl(
        "www.amazon.com",
        [{ asin: "A", quantity: 1 }],
        "mytag-20"
      )
    ).searchParams;
    expect(withTag.get("tag")).toBe("mytag-20");
    expect(withTag.get("AssociateTag")).toBe("mytag-20");
  });

  it("produces an empty-params URL for an empty item list", () => {
    expect(buildBulkAddUrl("www.amazon.com", [])).toBe(
      "https://www.amazon.com/gp/aws/cart/add.html?"
    );
  });
});

describe("chunkItemsForBulk", () => {
  it("returns one chunk when items <= size", () => {
    expect(chunkItemsForBulk([1, 2, 3], 30)).toEqual([[1, 2, 3]]);
  });

  it("splits items into chunks of the given size", () => {
    const items = Array.from({ length: 7 }, (_, i) => i);
    expect(chunkItemsForBulk(items, 3)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
      [6],
    ]);
  });

  it("defaults to a chunk size of 30", () => {
    const items = Array.from({ length: 65 }, (_, i) => i);
    const chunks = chunkItemsForBulk(items);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(30);
    expect(chunks[1].length).toBe(30);
    expect(chunks[2].length).toBe(5);
  });

  it("returns an empty array for an empty input", () => {
    expect(chunkItemsForBulk([])).toEqual([]);
  });
});
