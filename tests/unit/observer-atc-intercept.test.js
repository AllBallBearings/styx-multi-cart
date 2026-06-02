import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { JSDOM } from "jsdom";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVER_PATH = resolve(__dirname, "../../observer.js");
const SRC = readFileSync(OBSERVER_PATH, "utf8");

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function loadObserver(html, { url = "https://www.amazon.com/dp/B111111111" } = {}) {
  const messages = [];
  const dom = new JSDOM(html, {
    url,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });

  dom.window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(message);
        if (callback) callback({ ok: true });
      },
    },
    storage: {
      local: {
        get(_keys, callback) {
          callback({
            "mc.settings.v1": { interceptAtc: true },
            "mc.carts.v1": [
              {
                id: "cart-1",
                name: "Beach trip",
                savedAt: 1,
                lastUsedAt: 1,
                items: [],
              },
            ],
            "mc.entitlement.v1": { tier: "free", premiumUntil: null },
          });
        },
      },
      onChanged: {
        addListener() {},
      },
    },
  };

  dom.window.eval(SRC);
  return { dom, messages };
}

describe("observer.js ATC intercept", () => {
  it("uses data-asins from related-product submit inputs instead of the PDP ASIN", async () => {
    const { dom, messages } = loadObserver(`
      <!doctype html>
      <html>
        <head><title>Main PDP item</title></head>
        <body data-asin="B111111111">
          <h1 id="productTitle">Main PDP item</h1>
          <input
            type="submit"
            name="submit.addToCart"
            data-asins='["B0BVBKG522"]'
            data-hide-atc-button-on-success="false"
            data-mix-operations="AddToCart"
            data-numitems="1"
            data-reftag="pd_cart_d_dex_com_cart_typ_t1_d_sccl_1_atc_a"
            data-url="/cart/add-to-cart/ref=pd_cart_d_dex_com_cart_typ_t1_d_sccl_1_atc_a?_encoding=UTF8&amp;pd_rd_i=B0BVBKG522"
            aria-label="Add to cart, CUPSHE Women Swimsuit Bikini Set High Waisted Push Up Cheeky Drawstring Two Piece Bathing Suit"
            class="a-button-input"
          />
        </body>
      </html>
    `);

    const btn = dom.window.document.querySelector("input[name='submit.addToCart']");
    btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));

    const picker = dom.window.document.getElementById("__styx-picker");
    expect(picker).toBeTruthy();
    expect(picker.querySelector(".styx-pk-title").textContent).toContain("CUPSHE Women Swimsuit");

    picker
      .querySelector(".styx-pk-row")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();

    const addMessage = messages.find((msg) => msg.type === "MC_ADD_ITEM_TO_SAVED_CART");
    expect(addMessage).toMatchObject({
      savedCartId: "cart-1",
      item: {
        asin: "B0BVBKG522",
        title: "CUPSHE Women Swimsuit Bikini Set High Waisted Push Up Cheeky Drawstring Two Piece Bathing Suit",
        quantity: 1,
      },
    });
  });

  it("intercepts saved-for-later move-to-cart submit inputs", async () => {
    const { dom, messages } = loadObserver(
      `
        <!doctype html>
        <html>
          <head><title>Amazon Cart</title></head>
          <body>
            <div data-name="Saved Items">
              <div data-asin="B0BELLROY1" data-itemtype="saved" class="sc-list-item">
                <img
                  class="sc-product-image"
                  src="data:image/gif;base64,R0lGOD"
                  data-src="https://m.media-amazon.com/images/I/bellroy-duffel.jpg"
                />
                <input
                  name="submit.move-to-cart.b59c9685-aec5-4394-b631-e5428c0f7183"
                  data-action="move-to-cart"
                  aria-label="

                    Move to cart
                 Bellroy Lite Duffel (Super-Lightweight 30L Weekend Duffel Bag with Internal Organization) - Clay"
                  class="a-button-input"
                  type="submit"
                  value="Move to cart"
                />
              </div>
            </div>
          </body>
        </html>
      `,
      { url: "https://www.amazon.com/gp/cart/view.html" }
    );

    const btn = dom.window.document.querySelector("input[data-action='move-to-cart']");
    btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));

    const picker = dom.window.document.getElementById("__styx-picker");
    expect(picker).toBeTruthy();
    expect(picker.querySelector(".styx-pk-title").textContent).toContain("Bellroy Lite Duffel");

    picker
      .querySelector(".styx-pk-row")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();

    const addMessage = messages.find((msg) => msg.type === "MC_ADD_ITEM_TO_SAVED_CART");
    expect(addMessage).toMatchObject({
      savedCartId: "cart-1",
      item: {
        asin: "B0BELLROY1",
        title: "Bellroy Lite Duffel (Super-Lightweight 30L Weekend Duffel Bag with Internal Organization) - Clay",
        quantity: 1,
        image: "https://m.media-amazon.com/images/I/bellroy-duffel.jpg",
      },
    });
  });

  it("captures lazy-loaded recommendation images from dynamic image metadata", async () => {
    const { dom, messages } = loadObserver(`
      <!doctype html>
      <html>
        <head><title>Main PDP item</title></head>
        <body data-asin="B111111111">
          <h1 id="productTitle">Main PDP item</h1>
          <div class="a-carousel-card">
            <a href="/dp/B0DRESS123">
              <h2>Customers also bought</h2>
              <img
                class="s-image"
                src="https://images-na.ssl-images-amazon.com/images/G/01/loadIndicators/loading._CB.gif"
                data-a-dynamic-image='{"https://m.media-amazon.com/images/I/dress-small.jpg":[120,120],"https://m.media-amazon.com/images/I/dress-large.jpg":[600,600]}'
              />
            </a>
            <input
              type="submit"
              name="submit.addToCart"
              data-asins='["B0DRESS123"]'
              aria-label="Add to cart, Women's Red Dress"
              class="a-button-input"
            />
          </div>
        </body>
      </html>
    `);

    const btn = dom.window.document.querySelector("input[name='submit.addToCart']");
    btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));

    const picker = dom.window.document.getElementById("__styx-picker");
    expect(picker).toBeTruthy();
    expect(picker.querySelector(".styx-pk-title").textContent).toBe("Women's Red Dress");

    picker
      .querySelector(".styx-pk-row")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();

    const addMessage = messages.find((msg) => msg.type === "MC_ADD_ITEM_TO_SAVED_CART");
    expect(addMessage).toMatchObject({
      savedCartId: "cart-1",
      item: {
        asin: "B0DRESS123",
        title: "Women's Red Dress",
        image: "https://m.media-amazon.com/images/I/dress-large.jpg",
      },
    });
  });

  it("captures lazy-loaded PDP images from dynamic image metadata", async () => {
    const { dom, messages } = loadObserver(`
      <!doctype html>
      <html>
        <head><title>Main PDP item</title></head>
        <body data-asin="B0PDPIMAGE">
          <h1 id="productTitle">Main PDP item</h1>
          <img
            id="landingImage"
            src="https://images-na.ssl-images-amazon.com/images/G/01/loadIndicators/loading._CB.gif"
            data-a-dynamic-image='{"https://m.media-amazon.com/images/I/pdp-small.jpg":[100,100],"https://m.media-amazon.com/images/I/pdp-large.jpg":[800,800]}'
          />
          <input
            id="add-to-cart-button"
            type="submit"
            name="submit.add-to-cart"
            aria-label="Add to cart"
          />
        </body>
      </html>
    `);

    const btn = dom.window.document.getElementById("add-to-cart-button");
    btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));

    const picker = dom.window.document.getElementById("__styx-picker");
    expect(picker).toBeTruthy();

    picker
      .querySelector(".styx-pk-row")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();

    const addMessage = messages.find((msg) => msg.type === "MC_ADD_ITEM_TO_SAVED_CART");
    expect(addMessage).toMatchObject({
      savedCartId: "cart-1",
      item: {
        asin: "B0PDPIMAGE",
        title: "Main PDP item",
        image: "https://m.media-amazon.com/images/I/pdp-large.jpg",
      },
    });
  });

  it("uses PDP image data when the add-to-cart button already exposes the page ASIN", async () => {
    const { dom, messages } = loadObserver(`
      <!doctype html>
      <html>
        <head><title>Main PDP item</title></head>
        <body data-asin="B0PDPIMAGE">
          <h1 id="productTitle">Main PDP item</h1>
          <img
            id="landingImage"
            src="https://images-na.ssl-images-amazon.com/images/G/01/loadIndicators/loading._CB.gif"
            data-a-dynamic-image='{"https://m.media-amazon.com/images/I/pdp-small.jpg":[100,100],"https://m.media-amazon.com/images/I/pdp-large.jpg":[800,800]}'
          />
          <input
            id="add-to-cart-button"
            type="submit"
            name="submit.add-to-cart"
            data-asin="B0PDPIMAGE"
            aria-label="Add to cart"
          />
        </body>
      </html>
    `);

    const btn = dom.window.document.getElementById("add-to-cart-button");
    btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));

    const picker = dom.window.document.getElementById("__styx-picker");
    expect(picker).toBeTruthy();

    picker
      .querySelector(".styx-pk-row")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();

    const addMessage = messages.find((msg) => msg.type === "MC_ADD_ITEM_TO_SAVED_CART");
    expect(addMessage).toMatchObject({
      savedCartId: "cart-1",
      item: {
        asin: "B0PDPIMAGE",
        title: "Main PDP item",
        image: "https://m.media-amazon.com/images/I/pdp-large.jpg",
      },
    });
  });

  it("intercepts customization iframe add-to-cart buttons using the iframe URL ASIN", async () => {
    const { dom, messages } = loadObserver(
      `
        <!doctype html>
        <html>
          <head><title>Customize</title></head>
          <body>
            <button
              class="mantine-focus-auto mantine-active gc-button aui-primary mantine-Button-root"
              type="button"
              data-testid="gc-add-to-cart-button"
            >
              <span class="mantine-Button-inner">
                <span class="mantine-Button-label">
                  <span class="gc-button-text aui-button-text-size-default">Add to Cart</span>
                </span>
              </span>
            </button>
          </body>
        </html>
      `,
      {
        url: "https://www.amazon.com/customization/form?marketplaceId=ATVPDKIKX0DER&asin=B00JJID49S&sku=11027-120",
      }
    );

    const btn = dom.window.document.querySelector("[data-testid='gc-add-to-cart-button']");
    btn
      .querySelector(".gc-button-text")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));

    const picker = dom.window.document.getElementById("__styx-picker");
    expect(picker).toBeTruthy();

    picker
      .querySelector(".styx-pk-row")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();

    const addMessage = messages.find((msg) => msg.type === "MC_ADD_ITEM_TO_SAVED_CART");
    expect(addMessage).toMatchObject({
      savedCartId: "cart-1",
      item: {
        asin: "B00JJID49S",
        quantity: 1,
      },
    });
  });
});
