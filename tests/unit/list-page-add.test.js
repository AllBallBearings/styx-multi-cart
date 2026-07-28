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

const pageAddAllFromList = new Function(
  `${extractFunction("pageAddAllFromList")}; return pageAddAllFromList;`
)();

// Build one wishlist <li> matching the live Amazon markup captured in the
// 2026-07-24 spike. `withStepper` renders the post-add state (already in cart).
function itemHtml(itemid, asin, { withStepper = false, label = "Add to Cart" } = {}) {
  const control = withStepper
    ? `<button data-action="a-stepper-increment" aria-label="Increase quantity by one"></button>`
    : `<span id="pab-declarative-${itemid}" class="a-declarative" data-action="cta-add-to-cart">
         <span id="pab-${itemid}" class="a-button">
           <a href="javascript:void(0)" class="a-button-text a-text-center" data-csa-c-item-id="${asin}">${label}</a>
         </span>
       </span>`;
  return `<li data-id="LIST123" data-itemid="${itemid}" data-price="9.99">
      <a href="/dp/${asin}">Product ${asin}</a>
      ${control}
    </li>`;
}

function withDom(html, fn) {
  const dom = new JSDOM(`<div id="g-items">${html}</div>`, {
    url: "https://www.amazon.com/hz/wishlist/ls/LIST123",
  });
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  return Promise.resolve(fn(dom)).finally(() => {
    globalThis.window = prior.window;
    globalThis.document = prior.document;
    globalThis.location = prior.location;
    dom.window.close();
  });
}

describe("pageAddAllFromList", () => {
  it("clicks the native ATC anchor and reports the item added once its stepper appears", async () => {
    await withDom(itemHtml("ITEMAAA", "B000000001"), async (dom) => {
      // Simulate Amazon's AJAX: clicking the anchor replaces the control with a
      // quantity stepper (the "in cart" signal the function waits for).
      const anchor = dom.window.document.querySelector("a.a-button-text");
      anchor.addEventListener("click", () => {
        const li = dom.window.document.querySelector("li[data-itemid]");
        const btn = dom.window.document.createElement("button");
        btn.setAttribute("data-action", "a-stepper-increment");
        li.appendChild(btn);
      });

      const res = await pageAddAllFromList(["B000000001"]);
      expect(res.added).toEqual(["B000000001"]);
      expect(res.notCartable).toEqual([]);
      expect(res.notFound).toEqual([]);
    });
  });

  it("treats an item that already shows a stepper as already in cart (no re-click)", async () => {
    await withDom(itemHtml("ITEMBBB", "B000000002", { withStepper: true }), async () => {
      const res = await pageAddAllFromList(["B000000002"]);
      expect(res.alreadyInCart).toEqual(["B000000002"]);
      expect(res.added).toEqual([]);
    });
  });

  it("reports a requested asin that isn't on the list as notFound", async () => {
    await withDom(itemHtml("ITEMCCC", "B000000003"), async () => {
      const res = await pageAddAllFromList(["B0DOESNTEX"]);
      expect(res.notFound).toEqual(["B0DOESNTEX"]);
      expect(res.added).toEqual([]);
    });
  });

  it("does NOT click a variation item's 'See all buying options' (would navigate away)", async () => {
    await withDom(
      itemHtml("ITEMDDD", "B000000004", { label: "See all buying options" }),
      async (dom) => {
        const anchor = dom.window.document.querySelector("a.a-button-text");
        let clicked = false;
        anchor.addEventListener("click", () => {
          clicked = true;
        });
        const res = await pageAddAllFromList(["B000000004"]);
        expect(clicked).toBe(false);
        expect(res.notCartable).toEqual(["B000000004"]);
        expect(res.added).toEqual([]);
      }
    );
  });

  it("still clicks a button relabeled to 'Add to Amazon Cart' (rebrand on)", async () => {
    await withDom(
      itemHtml("ITEMEEE", "B000000005", { label: "Add to Amazon Cart" }),
      async (dom) => {
        const anchor = dom.window.document.querySelector("a.a-button-text");
        anchor.addEventListener("click", () => {
          const li = dom.window.document.querySelector("li[data-itemid]");
          const btn = dom.window.document.createElement("button");
          btn.setAttribute("data-action", "a-stepper-increment");
          li.appendChild(btn);
        });
        const res = await pageAddAllFromList(["B000000005"]);
        expect(res.added).toEqual(["B000000005"]);
      }
    );
  });
});
