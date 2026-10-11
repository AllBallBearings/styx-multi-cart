import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const source = readFileSync(new URL("../../src/background/index.js", import.meta.url), "utf8");
const start = source.indexOf("function pageAddToList(listId, i18n) {");
const end = source.indexOf("\n\n", source.indexOf("\n}", start) + 2);
if (start < 0 || end < 0) throw new Error("pageAddToList not found");
const pageAddToListSource = source.slice(start, end);

function setup(body) {
  const dom = new JSDOM(`<body>${body}</body>`, { url: "https://www.amazon.com/dp/B0TESTASN0" });
  const { document } = dom.window;
  let waitedMs = 0;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: this.closest('[aria-hidden="true"]') ? 0 : 20 };
  };
  const pageAddToList = new Function(
    "document", "setTimeout", `${pageAddToListSource}; return pageAddToList;`
  )(document, (callback, ms) => { waitedMs += ms; callback(); });
  return { dom, document, pageAddToList, waitedMs: () => waitedMs };
}

describe("Amazon Add-to-List chooser", () => {
  it("uses the visible row when Amazon retains a hidden duplicate menu", async () => {
    const { document, pageAddToList } = setup(`
      <div aria-hidden="true"><span id="atwl-list-name-1V8R6GN3RRFSE">Holiday</span></div>
      <div id="atwl-popover-inner" aria-hidden="false">
        <span id="atwl-list-name-1V8R6GN3RRFSE">Holiday</span>
      </div>
    `);
    const rows = document.querySelectorAll("#atwl-list-name-1V8R6GN3RRFSE");
    rows[1].addEventListener("click", () => { document.body.innerText = "Item added to Holiday"; });

    const result = await pageAddToList("1V8R6GN3RRFSE");
    expect(result).toEqual({ ok: true, confirmed: true });
  });

  it("expands a shortened menu to find the chosen list", async () => {
    const { document, pageAddToList, waitedMs } = setup(`
      <button id="add-to-wishlist-button">Add to List</button>
      <div id="atwl-popover-inner" aria-hidden="true">
        <button id="atwl-show-more-lists">Show More Lists</button>
      </div>
    `);
    const menu = document.getElementById("atwl-popover-inner");
    document.getElementById("add-to-wishlist-button").addEventListener("click", () => {
      menu.setAttribute("aria-hidden", "false");
    });
    document.getElementById("atwl-show-more-lists").addEventListener("click", () => {
      const row = document.createElement("span");
      row.id = "atwl-list-name-1V8R6GN3RRFSE";
      row.addEventListener("click", () => { document.body.innerText = "Item added to Holiday"; });
      menu.appendChild(row);
    });

    const result = await pageAddToList("1V8R6GN3RRFSE");
    expect(result).toEqual({ ok: true, confirmed: true });
    expect(waitedMs()).toBeLessThan(1000);
  });
});
