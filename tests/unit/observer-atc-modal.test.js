import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { JSDOM } from "jsdom";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVER_PATH = resolve(__dirname, "../../observer.js");
const SRC = readFileSync(OBSERVER_PATH, "utf8");

function nextTick() {
  return new Promise((r) => setTimeout(r, 0));
}

// Loads observer.js into a JSDOM search-results page with one Amazon list in
// the snapshot, so the ATC intercept is armed and the picker shows a row.
// Mirrors the harness in observer-atc-intercept.
function loadObserver(html, url) {
  const messages = [];
  const listsSnapshot = {
    host: "www.amazon.com",
    fetchedAt: Date.now(),
    lists: [
      { listId: "cart-1", name: "Beach trip", count: 0, kind: "custom", access: "editable" },
    ],
  };
  const dom = new JSDOM(html, {
    url,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  dom.window.chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://test-id/${p}`,
      sendMessage(message, cb) {
        messages.push(message);
        if (message.type === "MC_ENSURE_AMAZON_LISTS") {
          if (cb) cb({ ok: true, ...listsSnapshot });
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
            "mc.amazonlists.v1": listsSnapshot,
            "mc.entitlement.v1": { tier: "free", premiumUntil: null },
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

// A search results page with one multi-variant tile and Amazon's variant
// picker modal open (rendered in an a-popover at the body root, the way Amazon
// does it). The modal's Add-to-cart button carries no ASIN in its own ancestor
// chain — the bug this fix addresses.
function pageHtml({ optionValue, title }) {
  const tileTitle =
    title || "12FT/18FT Portable Volleyball Net with Height Adjustable Poles";
  return `
    <!doctype html>
    <html>
      <head><title>Amazon.com : driveway volleyball net</title></head>
      <body>
        <div
          data-component-type="s-search-result"
          data-asin="PARENT1234"
          class="s-result-item"
        >
          <a class="a-link-normal" href="/dp/PARENT1234">
            <h2><span>${tileTitle}</span></h2>
          </a>
          <img class="s-image" src="https://m.media-amazon.com/images/I/net.jpg" />
          <div class="a-price"><span class="a-offscreen">$69.99</span></div>
          <button class="a-button-input" aria-label="Add to cart">Add to cart</button>
        </div>

        <div class="a-popover" id="a-popover-1">
          <div class="a-popover-wrapper">
            <select>
              <option value="${optionValue}">12FT Portable Volleyball Net</option>
            </select>
            <span class="a-button">
              <button aria-label="Add to cart" class="a-button-input">Add to cart</button>
            </span>
          </div>
        </div>
      </body>
    </html>
  `;
}

const SEARCH_URL = "https://www.amazon.com/s?k=driveway+volleyball+net";

describe("observer.js — variant-picker modal ATC", () => {
  it("routes the modal Add-to-cart to the picker using the child ASIN from the size dropdown", async () => {
    // Real Amazon option values are the child ASIN, sometimes with a trailing
    // merchant token (validated live: e.g. "B0CCL43LJG,ATVPDKIKX0DER").
    const { dom, messages } = loadObserver(
      pageHtml({ optionValue: "CHILD00001,ATVPDKIKX0DER" }),
      SEARCH_URL
    );
    const doc = dom.window.document;

    // 1. User clicks the tile (opens Amazon's modal) — stashes tile context.
    doc
      .querySelector(".s-image")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));

    // 2. User clicks Add-to-cart inside the modal.
    doc
      .querySelector(".a-popover button[aria-label='Add to cart']")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();

    const picker = doc.getElementById("__styx-picker");
    expect(picker).toBeTruthy();
    // Title comes from the stashed tile; ASIN is the chosen child variant.
    expect(picker.querySelector(".styx-pk-title").textContent).toContain(
      "Portable Volleyball Net"
    );

    picker
      .querySelector(".styx-pk-row")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();

    const add = messages.find((m) => m.type === "MC_ADD_ITEM_TO_AMAZON_LIST");
    expect(add).toBeTruthy();
    expect(add.asin).toBe("CHILD00001");
  });

  it("falls back to the stashed tile's parent ASIN when the modal exposes no child ASIN", async () => {
    const { dom, messages } = loadObserver(
      pageHtml({ optionValue: "Choose a size" }), // not an ASIN
      SEARCH_URL
    );
    const doc = dom.window.document;

    doc
      .querySelector(".s-image")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    doc
      .querySelector(".a-popover button[aria-label='Add to cart']")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();

    const picker = doc.getElementById("__styx-picker");
    expect(picker).toBeTruthy();

    picker
      .querySelector(".styx-pk-row")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();

    const add = messages.find((m) => m.type === "MC_ADD_ITEM_TO_AMAZON_LIST");
    expect(add).toBeTruthy();
    expect(add.asin).toBe("PARENT1234");
  });

  it("strips the 'Sponsored Ad -' prefix from the saved title", async () => {
    const { dom, messages } = loadObserver(
      pageHtml({
        optionValue: "CHILD00001",
        title: "Sponsored Ad - MangoStar Volleyball Net, 12ft/20ft Portable",
      }),
      SEARCH_URL
    );
    const doc = dom.window.document;

    doc
      .querySelector(".s-image")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    doc
      .querySelector(".a-popover button[aria-label='Add to cart']")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();

    const picker = doc.getElementById("__styx-picker");
    const title = picker.querySelector(".styx-pk-title").textContent;
    expect(title).not.toMatch(/sponsored/i);
    expect(title).toContain("MangoStar");

    picker
      .querySelector(".styx-pk-row")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();
    // The sponsored-prefix strip is verified on the picker title above (the
    // Amazon-list add message carries the asin, not the title).
    const add = messages.find((m) => m.type === "MC_ADD_ITEM_TO_AMAZON_LIST");
    expect(add.asin).toBe("CHILD00001");
  });
});
