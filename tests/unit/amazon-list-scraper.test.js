import { describe, expect, it } from "vitest";
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
          },
          {
            listId: "2OLDID9",
            name: "Project Supplies",
            url: "https://www.amazon.com/hz/wishlist/ls/2OLDID9",
            count: null,
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
