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

const pageHighlightBulkConfirm = new Function(
  `${extractFunction("pageHighlightBulkConfirm")}; return pageHighlightBulkConfirm;`
)();

describe("pageHighlightBulkConfirm", () => {
  it("relabels and highlights Go to Cart on Amazon's bulk-add page", async () => {
    const dom = new JSDOM(`
      <div class="bulk-item" data-asin="B000TEST01">
        <a href="/dp/B000TEST01">Requested product</a>
      </div>
      <div class="a-button">
        <span id="go-cart-label" class="a-button-text">Go to Cart</span>
        <input
          class="a-button-input"
          type="submit"
          aria-labelledby="go-cart-label"
          value="Go to Cart"
        />
      </div>
    `, { url: "https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=B000TEST01" });
    dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
      width: 120,
      height: 32,
      top: 10,
      left: 10,
      right: 130,
      bottom: 42,
    });

    const priorWindow = globalThis.window;
    const priorDocument = globalThis.document;
    const priorLocation = globalThis.location;
    const priorGetComputedStyle = globalThis.getComputedStyle;
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.location = dom.window.location;
    globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
    try {
      await expect(pageHighlightBulkConfirm()).resolves.toMatchObject({
        ok: true,
        confirmLabel: "Add All to Amazon Cart",
      });
      expect(document.getElementById("go-cart-label").textContent).toBe(
        "Add All to Amazon Cart"
      );
      expect(document.getElementById("__styx-bulk-ring")).not.toBeNull();
    } finally {
      globalThis.window = priorWindow;
      globalThis.document = priorDocument;
      globalThis.location = priorLocation;
      globalThis.getComputedStyle = priorGetComputedStyle;
      dom.window.close();
    }
  });

  it("rejects an empty bulk page instead of relabeling Go to Cart", async () => {
    const dom = new JSDOM(`
      <main>
        <p>Amazon did not render any requested products.</p>
        <div class="a-button">
          <span id="go-cart-label" class="a-button-text">Go to Cart</span>
          <input
            class="a-button-input"
            type="submit"
            aria-labelledby="go-cart-label"
            value="Go to Cart"
          />
        </div>
      </main>
    `, { url: "https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=B000TEST01" });
    dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
      width: 120,
      height: 32,
      top: 10,
      left: 10,
      right: 130,
      bottom: 42,
    });

    const priorWindow = globalThis.window;
    const priorDocument = globalThis.document;
    const priorLocation = globalThis.location;
    const priorGetComputedStyle = globalThis.getComputedStyle;
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.location = dom.window.location;
    globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
    try {
      await expect(pageHighlightBulkConfirm()).resolves.toMatchObject({
        ok: false,
        emptyBulkPage: true,
      });
      expect(document.getElementById("go-cart-label").textContent).toBe("Go to Cart");
      expect(document.getElementById("__styx-bulk-ring")).toBeNull();
    } finally {
      globalThis.window = priorWindow;
      globalThis.document = priorDocument;
      globalThis.location = priorLocation;
      globalThis.getComputedStyle = priorGetComputedStyle;
      dom.window.close();
    }
  });
});
