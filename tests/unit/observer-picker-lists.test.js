import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { JSDOM } from "jsdom";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, "../../observer.js"), "utf8");

function nextTick() {
  return new Promise((r) => setTimeout(r, 0));
}

// Storage seeded with an Amazon-list snapshot (mc.amazonlists.v1) and NO local
// carts, so the picker runs in "lists mode".
function loadObserver(html, url) {
  const messages = [];
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const lists = [
    { listId: "L1WISH00000", name: "Wish List", count: 5, kind: "wishlist", access: "editable", url: "https://www.amazon.com/hz/wishlist/ls/L1WISH00000" },
    { listId: "L2BEACH0000", name: "Beach trip", count: 2, kind: "custom", access: "editable", url: "https://www.amazon.com/hz/wishlist/ls/L2BEACH0000" },
  ];
  dom.window.chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://test-id/${p}`,
      sendMessage(message, cb) {
        messages.push(message);
        // ENSURE returns the same snapshot so the background refresh is a no-op.
        if (message.type === "MC_ENSURE_AMAZON_LISTS") {
          if (cb) cb({ ok: true, host: "www.amazon.com", fetchedAt: Date.now(), lists });
          return;
        }
        if (cb) cb({ ok: true });
      },
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({
            "mc.settings.v1": { interceptAtc: true },
            "mc.carts.v1": [],
            "mc.entitlement.v1": { tier: "premium", premiumUntil: Date.now() + 1e11 },
            "mc.amazonlists.v1": { host: "www.amazon.com", fetchedAt: Date.now(), lists },
          });
        },
        set(_obj, cb) {
          if (cb) cb();
        },
      },
      onChanged: { addListener() {} },
    },
  };
  dom.window.eval(SRC);
  return { dom, messages };
}

const PDP = `
  <!doctype html>
  <html><head><title>Some Product</title></head>
  <body>
    <div data-asin="B0TESTASN0" class="a-section">
      <input type="submit" name="submit.addToCart" aria-label="Add to cart" class="a-button-input" />
    </div>
  </body></html>
`;

describe("observer.js — picker in Amazon-lists mode", () => {
  it("lists the Amazon lists (including Wish List) and routes a row click to MC_ADD_ITEM_TO_AMAZON_LIST", async () => {
    const { dom, messages } = loadObserver(PDP, "https://www.amazon.com/dp/B0TESTASN0");
    const doc = dom.window.document;

    doc
      .querySelector("input[name='submit.addToCart']")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();

    const picker = doc.getElementById("__styx-picker");
    expect(picker).toBeTruthy();
    const names = [...picker.querySelectorAll(".styx-pk-row-name")].map((n) => n.textContent);
    expect(names).toContain("Wish List");
    expect(names).toContain("Beach trip");

    // Every row is an Amazon-list target (data-list-id), not a local cart.
    const wishRow = [...picker.querySelectorAll(".styx-pk-row")].find(
      (r) => r.querySelector(".styx-pk-row-name").textContent === "Wish List"
    );
    expect(wishRow.dataset.listId).toBe("L1WISH00000");

    wishRow.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();

    const add = messages.find((m) => m.type === "MC_ADD_ITEM_TO_AMAZON_LIST");
    expect(add).toBeTruthy();
    expect(add).toMatchObject({ listId: "L1WISH00000", asin: "B0TESTASN0", host: "www.amazon.com" });
    // The old local-cart path must NOT be used in lists mode.
    expect(messages.find((m) => m.type === "MC_ADD_ITEM_TO_SAVED_CART")).toBeFalsy();
  });
});
