import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../../src/background/index.js"), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const open = source.indexOf("{", start);
  let depth = 1;
  let end = open + 1;
  while (end < source.length && depth > 0) {
    if (source[end] === "{") depth++;
    else if (source[end] === "}") depth--;
    end++;
  }
  return source.slice(start, end);
}

const pageScrapeAmazonLists = new Function(
  `${extractFunction("pageScrapeAmazonLists")}; return pageScrapeAmazonLists;`
)();
const pageScrapeSingleList = new Function(
  `${extractFunction("pageScrapeSingleList")}; return pageScrapeSingleList;`
)();
const pageClassifyProductAvailability = new Function(
  `${extractFunction("pageClassifyProductAvailability")}; return pageClassifyProductAvailability;`
)();

describe("pageScrapeAmazonLists", () => {
  it("ignores Your Lists navigation URLs and cleans Amazon status badges", () => {
    const dom = new JSDOM(
      `
        <a href="/hz/wishlist/ls/?ref_=topnav_storetab_wl">Your Lists</a>
        <a href="/hz/wishlist/ls/ref=cm_wl_your_lists">Your Lists</a>
        <a href="/hz/wishlist/ls/3ABCXYZ123?ref_=nav_wishlist_lists_1">
          <span class="a-size-base-plus">Wish List</span>
          <span>Default List</span><span>Public</span>
        </a>
        <a href="/hz/wishlist/ls/3ABCXYZ123">Duplicate Wish List link</a>
        <a href="/gp/registry/wishlist/2OLDID9">
          Project Supplies <span>Private</span>
        </a>
      `,
      { url: "https://www.amazon.com/hz/wishlist/ls" }
    );
    const priorDocument = globalThis.document;
    const priorLocation = globalThis.location;
    globalThis.document = dom.window.document;
    globalThis.location = dom.window.location;
    try {
      expect(pageScrapeAmazonLists()).toEqual({
        lists: [
          {
            listId: "3ABCXYZ123",
            name: "Wish List",
            url: "https://www.amazon.com/hz/wishlist/ls/3ABCXYZ123",
            count: null,
            kind: "default", // carries the "Default List" badge
          },
          {
            listId: "2OLDID9",
            name: "Project Supplies",
            url: "https://www.amazon.com/hz/wishlist/ls/2OLDID9",
            count: null,
            kind: "custom",
          },
        ],
      });
    } finally {
      globalThis.document = priorDocument;
      globalThis.location = priorLocation;
      dom.window.close();
    }
  });
});

describe("Amazon list item availability", () => {
  it("marks explicitly unavailable wishlist rows", async () => {
    vi.useFakeTimers();
    const dom = new JSDOM(
      `
        <h1 id="profile-list-name">Wish List</h1>
        <ul id="g-items">
          <li data-id="row-1">
            <a id="itemName_1" href="/dp/B000GOOD01">Available product</a>
          </li>
          <li data-id="row-2">
            <a id="itemName_2" href="/dp/B000GONE01">Deleted product</a>
            <span>This item is no longer available</span>
          </li>
        </ul>
      `,
      { url: "https://www.amazon.com/hz/wishlist/ls/3ABCXYZ123" }
    );
    dom.window.scrollTo = () => {};
    const priorWindow = globalThis.window;
    const priorDocument = globalThis.document;
    const priorLocation = globalThis.location;
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.location = dom.window.location;
    try {
      const pending = pageScrapeSingleList();
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({
        asin: "B000GOOD01",
        unavailable: false,
      });
      expect(result.items[1]).toMatchObject({
        asin: "B000GONE01",
        unavailable: true,
        unavailableReason: "This item is no longer available",
      });
    } finally {
      vi.useRealTimers();
      globalThis.window = priorWindow;
      globalThis.document = priorDocument;
      globalThis.location = priorLocation;
      dom.window.close();
    }
  });

  it("recognizes Amazon's missing-page and unavailable-product messages", () => {
    const cases = [
      {
        html: "<body><h1>SORRY</h1><p>we couldn't find that page</p></body>",
        title: "Amazon.com",
        reason: "Product page no longer exists",
      },
      {
        html: '<body><div id="availability">Currently unavailable.</div></body>',
        title: "Product",
        reason: "Currently unavailable.",
      },
    ];
    const priorDocument = globalThis.document;
    for (const sample of cases) {
      const dom = new JSDOM(sample.html);
      Object.defineProperty(dom.window.document, "title", {
        configurable: true,
        value: sample.title,
      });
      globalThis.document = dom.window.document;
      expect(pageClassifyProductAvailability()).toMatchObject({
        available: false,
        reason: sample.reason,
      });
      dom.window.close();
    }
    globalThis.document = priorDocument;
  });

  it("asks for a format choice when the saved book edition has no cart offer", () => {
    const dom = new JSDOM(`
      <body>
        <div id="tmmSwatches">
          <a href="/dp/B001KINDLE">Kindle $12.99</a>
          <a href="/dp/B001AUDIO">Audiobook $0.00</a>
          <a href="/dp/B001PAPER">Paperback $16.48</a>
          <span>MP3 CD — Out of Print—Limited Availability</span>
        </div>
        <button>Add to Auto Buy</button>
      </body>
    `);
    const priorDocument = globalThis.document;
    globalThis.document = dom.window.document;
    try {
      expect(pageClassifyProductAvailability()).toMatchObject({
        available: true,
        needsUserChoice: true,
        reason: "The saved format is unavailable; choose another format",
      });
    } finally {
      globalThis.document = priorDocument;
      dom.window.close();
    }
  });

  it("does not ask for a format choice when the selected edition has Add to Cart", () => {
    const dom = new JSDOM(`
      <body>
        <div id="tmmSwatches">
          <a href="/dp/B001KINDLE">Kindle</a>
          <a href="/dp/B001PAPER">Paperback</a>
        </div>
        <input id="add-to-cart-button" value="Add to Cart">
      </body>
    `);
    const priorDocument = globalThis.document;
    globalThis.document = dom.window.document;
    try {
      expect(pageClassifyProductAvailability()).toEqual({ available: true });
    } finally {
      globalThis.document = priorDocument;
      dom.window.close();
    }
  });
});
