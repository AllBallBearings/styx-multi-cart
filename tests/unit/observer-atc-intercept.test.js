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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Reconstruct the item the observer built for a click: title/image come from
// the picker header, asin/quantity from the MC_ADD_ITEM_TO_AMAZON_LIST message
// the row click sends. (The picker targets Amazon lists, so there is no nested
// `item` payload anymore.)
function builtItem(picker, messages) {
  const add = messages.find((m) => m.type === "MC_ADD_ITEM_TO_AMAZON_LIST") || {};
  const titleEl = picker.querySelector(".styx-pk-title");
  const thumb = picker.querySelector(".styx-pk-thumb");
  return {
    asin: add.asin,
    quantity: add.quantity,
    listId: add.listId,
    title: titleEl ? titleEl.textContent.trim() : "",
    image: thumb && thumb.tagName === "IMG" ? thumb.getAttribute("src") : "",
  };
}

function loadObserver(
  html,
  {
    url = "https://www.amazon.com/dp/B111111111",
    settings = {},
    storageDelayMs = 0,
    prepareWindow,
  } = {}
) {
  const messages = [];
  const storedSettings = Object.assign(
    { interceptAtc: true },
    settings
  );
  // The picker targets the user's Amazon lists (mc.amazonlists.v1 snapshot).
  // Seed one editable list ("cart-1") so a picker row renders and row clicks
  // route to MC_ADD_ITEM_TO_AMAZON_LIST.
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

  if (prepareWindow) prepareWindow(dom.window);

  dom.window.chrome = {
    runtime: {
      lastError: null,
      getURL(path) {
        return `chrome-extension://test-id/${path}`;
      },
      sendMessage(message, callback) {
        messages.push(message);
        if (message.type === "MC_ENSURE_AMAZON_LISTS") {
          if (callback) callback({ ok: true, ...listsSnapshot });
          return;
        }
        if (callback) callback({ ok: true });
      },
    },
    storage: {
      local: {
        get(_keys, callback) {
          const payload = {
            "mc.settings.v1": storedSettings,
            "mc.amazonlists.v1": listsSnapshot,
            "mc.entitlement.v1": { tier: "free", premiumUntil: null },
          };
          // Real chrome.storage returns a promise when no callback is given
          // (observer's guide/hint flags use that form).
          if (!callback) return Promise.resolve(payload);
          if (storageDelayMs > 0) {
            setTimeout(() => callback(payload), storageDelayMs);
          } else {
            callback(payload);
          }
        },
        set(obj, callback) {
          if (obj && obj["mc.settings.v1"]) {
            Object.assign(storedSettings, obj["mc.settings.v1"]);
          }
          if (callback) callback();
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
  it("holds submit.addToCart clicks until saved carts hydrate", async () => {
    const { dom } = loadObserver(
      `
        <!doctype html>
        <html>
          <head><title>Buy Again</title></head>
          <body>
            <div data-asin="B0NBMOUNT1" class="a-section">
              <input
                type="submit"
                name="submit.addToCart"
                aria-label="Add to cart, NB Smoovex Single Computer Monitor Mount, Monitor Stand fits up to 32 Inch, Mechanical Spring Monitor Arm, VESA 75/100 mm, Model-A5(Black)"
                class="a-button-input"
              />
            </div>
          </body>
        </html>
      `,
      {
        url: "https://www.amazon.com/gp/buyagain",
        storageDelayMs: 20,
      }
    );

    const btn = dom.window.document.querySelector("input[name='submit.addToCart']");
    let nativeClickCount = 0;
    btn.addEventListener("click", () => {
      nativeClickCount += 1;
    });

    btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(nativeClickCount).toBe(0);
    await delay(30);

    const picker = dom.window.document.getElementById("__styx-picker");
    expect(picker).toBeTruthy();
    expect(picker.querySelector(".styx-pk-title").textContent).toContain("NB Smoovex");
    expect(nativeClickCount).toBe(0);
  });

  it("uses Buy Again product-link text when the button label is generic", async () => {
    const { dom, messages } = loadObserver(
      `
        <!doctype html>
        <html>
          <head><title>Buy Again</title></head>
          <body>
            <div data-asin="B0NBMOUNT1" class="a-section">
              <a class="a-link-normal" href="/dp/B0NBMOUNT1">
                <span class="a-size-base-plus a-color-base a-text-normal">
                  NB Smoovex Single Computer Monitor Mount, Monitor Stand fits up to 32 Inch
                </span>
              </a>
              <input
                type="submit"
                name="submit.addToCart"
                aria-label="Add to cart"
                class="a-button-input"
              />
            </div>
          </body>
        </html>
      `,
      { url: "https://www.amazon.com/gp/buyagain" }
    );

    const btn = dom.window.document.querySelector("input[name='submit.addToCart']");
    btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));

    const picker = dom.window.document.getElementById("__styx-picker");
    expect(picker).toBeTruthy();
    expect(picker.querySelector(".styx-pk-title").textContent).toContain("NB Smoovex");

    picker
      .querySelector(".styx-pk-row")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();

    expect(builtItem(picker, messages)).toMatchObject({
      listId: "cart-1",
      asin: "B0NBMOUNT1",
      title: "NB Smoovex Single Computer Monitor Mount, Monitor Stand fits up to 32 Inch",
    });
  });

  it("intercepts icon buttons whose submit input is labelled by sibling text", async () => {
    const { dom, messages } = loadObserver(
      `
        <!doctype html>
        <html>
          <head><title>Amazon widget</title></head>
          <body>
            <span class="a-button-inner">
              <i class="a-icon a-icon-cart"></i>
              <input
                type="submit"
                data-asin="B0G6KRDS4N"
                data-offerlistingid="L%2BCwruu7%2B0Gbj7ZeSB48FRpjcUaoIduD"
                class="a-button-input"
                aria-labelledby="a-autoid-1-announce"
              />
              <span class="a-button-text" aria-hidden="true" id="a-autoid-1-announce">Add to Cart</span>
            </span>
          </body>
        </html>
      `,
      { url: "https://www.amazon.com/gp/buyagain" }
    );

    const visibleText = dom.window.document.getElementById("a-autoid-1-announce");
    visibleText.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));

    const picker = dom.window.document.getElementById("__styx-picker");
    expect(picker).toBeTruthy();

    picker
      .querySelector(".styx-pk-row")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();

    expect(builtItem(picker, messages)).toMatchObject({
      listId: "cart-1",
      asin: "B0G6KRDS4N",
      quantity: 1,
    });
  });

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

    expect(builtItem(picker, messages)).toMatchObject({
      listId: "cart-1",
      asin: "B0BVBKG522",
      title: "CUPSHE Women Swimsuit Bikini Set High Waisted Push Up Cheeky Drawstring Two Piece Bathing Suit",
      quantity: 1,
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

    expect(builtItem(picker, messages)).toMatchObject({
      listId: "cart-1",
      asin: "B0BELLROY1",
      title: "Bellroy Lite Duffel (Super-Lightweight 30L Weekend Duffel Bag with Internal Organization) - Clay",
      quantity: 1,
      image: "https://m.media-amazon.com/images/I/bellroy-duffel.jpg",
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

    expect(builtItem(picker, messages)).toMatchObject({
      listId: "cart-1",
      asin: "B0DRESS123",
      title: "Women's Red Dress",
      image: "https://m.media-amazon.com/images/I/dress-large.jpg",
    });
  });

  it("does not use carousel previous/next controls as the picker product title", async () => {
    const { dom, messages } = loadObserver(`
      <!doctype html>
      <html>
        <head><title>Main PDP item</title></head>
        <body data-asin="B111111111">
          <h1 id="productTitle">Main PDP item</h1>
          <div class="a-carousel-card">
            <a role="link" aria-label="Previous, Disabled"></a>
            <a class="a-link-normal" href="/dp/B0DRESS123">
              <span class="a-truncate-full">Women's Red Pleated Dress with Tie Waist</span>
              <img
                class="s-image"
                src="https://m.media-amazon.com/images/I/dress.jpg"
              />
            </a>
            <input
              type="submit"
              name="submit.addToCart"
              data-asins='["B0DRESS123"]'
              aria-label="Add to cart"
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
    const title = picker.querySelector(".styx-pk-title");
    expect(title.textContent).toBe("Women's Red Pleated Dress with Tie Waist");
    expect(title.getAttribute("title")).toBe("Women's Red Pleated Dress with Tie Waist");

    picker
      .querySelector(".styx-pk-row")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();

    expect(builtItem(picker, messages)).toMatchObject({
      listId: "cart-1",
      asin: "B0DRESS123",
      title: "Women's Red Pleated Dress with Tie Waist",
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

    expect(builtItem(picker, messages)).toMatchObject({
      listId: "cart-1",
      asin: "B0PDPIMAGE",
      title: "Main PDP item",
      image: "https://m.media-amazon.com/images/I/pdp-large.jpg",
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

    expect(builtItem(picker, messages)).toMatchObject({
      listId: "cart-1",
      asin: "B0PDPIMAGE",
      title: "Main PDP item",
      image: "https://m.media-amazon.com/images/I/pdp-large.jpg",
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

    expect(builtItem(picker, messages)).toMatchObject({
      listId: "cart-1",
      asin: "B00JJID49S",
      quantity: 1,
    });
  });

  // relabelAtcButton itself: only the button it actually relabels may be
  // marked direct. Regression guard for a real bug found while fixing this —
  // the first version marked the button whenever the rebrand toggle merely
  // *defaulted* on, even on ordinary product pages with no "Add to a Styx
  // cart" companion button, which made every plain Add-to-Cart click skip
  // the picker.
  describe("relabelAtcButton marking", () => {
    function pdpWithBuyboxRelocationHtml() {
      // Minimal shape of Amazon's real buybox: the wishlist widget (which
      // injectPdpAddToListButton relocates) and the ATC control inside a
      // .a-button wrapper carrying its visible label, which relabelAtcButton
      // rewrites.
      return `
        <!doctype html>
        <html>
          <head><title>Product</title></head>
          <body>
            <div data-asin="B0NBMOUNT1" class="a-section">
              <div id="wishlistButtonStack"></div>
              <span class="a-button a-button-primary">
                <span class="a-button-inner">
                  <input
                    type="submit"
                    id="add-to-cart-button"
                    name="submit.add-to-cart"
                    class="a-button-input"
                  />
                  <span class="a-button-text">Add to Cart</span>
                </span>
              </span>
            </div>
          </body>
        </html>
      `;
    }

    it("marks and relabels the ATC button on a page with the wishlist buybox, and clicking it skips the picker", async () => {
      const { dom } = loadObserver(pdpWithBuyboxRelocationHtml(), {
        url: "https://www.amazon.com/dp/B0NBMOUNT1",
      });
      const btn = dom.window.document.getElementById("add-to-cart-button");

      // relabelAtcButton ran automatically at init (initPdpAddToList), no
      // manual flag-poking needed. This harness doesn't mock chrome.i18n, so
      // t() falls back to the raw key (matches its real fallback behavior
      // when a message is unavailable) rather than the localized string.
      expect(btn.dataset.styxDirectAtc).toBe("1");
      expect(btn.closest(".a-button").querySelector(".a-button-text").textContent).toBe(
        "observer_addDirectlyToAmazonCart"
      );

      let nativeClicks = 0;
      btn.addEventListener("click", () => { nativeClicks += 1; });
      btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await nextTick();

      expect(nativeClicks).toBe(1);
      expect(dom.window.document.getElementById("__styx-picker")).toBeNull();
    });

    it("does NOT mark an ordinary ATC button with no wishlist buybox present — the picker still opens", async () => {
      const { dom } = loadObserver(
        `
          <!doctype html>
          <html>
            <head><title>Product</title></head>
            <body>
              <div data-asin="B0NBMOUNT1" class="a-section">
                <input
                  type="submit"
                  id="add-to-cart-button"
                  name="submit.add-to-cart"
                  aria-label="Add to cart"
                  class="a-button-input"
                />
              </div>
            </body>
          </html>
        `,
        { url: "https://www.amazon.com/dp/B0NBMOUNT1", storageDelayMs: 20 }
      );
      const btn = dom.window.document.getElementById("add-to-cart-button");
      expect(btn.dataset.styxDirectAtc).toBeUndefined();

      btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await delay(30);

      expect(dom.window.document.getElementById("__styx-picker")).toBeTruthy();
    });
  });

  // "Add directly to Amazon cart" (relabelAtcButton) sits next to our own
  // "Add to a Styx cart" button on the PDP buybox. Its whole point is to skip
  // the picker. Bug: clicking it still opened the picker, and even via the
  // picker's own "Add to Amazon cart" escape hatch, picking a protection-plan
  // option re-opened the picker a second time because Amazon's upsell flow
  // fires its own completing click on a DIFFERENT element than the one that
  // was bypassed, which the one-shot bypass flag didn't cover.
  describe("direct-to-cart button and its grace window", () => {
    function directAtcHtml() {
      return `
        <!doctype html>
        <html>
          <head><title>Product</title></head>
          <body>
            <div data-asin="B0NBMOUNT1" class="a-section">
              <input
                type="submit"
                id="add-to-cart-button"
                name="submit.add-to-cart"
                aria-label="Add to cart"
                class="a-button-input"
              />
            </div>
            <!-- Stands in for a control the upsell/coverage modal renders
                 elsewhere in the page to actually complete the add. -->
            <button id="upsell-complete" aria-label="Add to cart">Add to Cart</button>
          </body>
        </html>
      `;
    }

    it("a button marked direct (relabelAtcButton) never opens the picker", async () => {
      const { dom } = loadObserver(directAtcHtml(), {
        url: "https://www.amazon.com/dp/B0NBMOUNT1",
      });
      const btn = dom.window.document.getElementById("add-to-cart-button");
      // What relabelAtcButton marks once the "Add to a Styx cart" rebrand is on.
      btn.dataset.styxDirectAtc = "1";
      let nativeClicks = 0;
      btn.addEventListener("click", () => { nativeClicks += 1; });

      btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await nextTick();

      expect(nativeClicks).toBe(1);
      expect(dom.window.document.getElementById("__styx-picker")).toBeNull();
    });

    it("stands down for a few seconds after, so the upsell flow's own completing click (a different element) also passes through", async () => {
      const { dom } = loadObserver(directAtcHtml(), {
        url: "https://www.amazon.com/dp/B0NBMOUNT1",
      });
      const btn = dom.window.document.getElementById("add-to-cart-button");
      btn.dataset.styxDirectAtc = "1";
      btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await nextTick();

      const upsell = dom.window.document.getElementById("upsell-complete");
      let upsellClicks = 0;
      upsell.addEventListener("click", () => { upsellClicks += 1; });
      upsell.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await nextTick();

      expect(upsellClicks).toBe(1);
      expect(dom.window.document.getElementById("__styx-picker")).toBeNull();
    });

    it("the picker's own escape hatch gets the same grace window, so picking a protection-plan option does not re-open the picker", async () => {
      const { dom } = loadObserver(directAtcHtml(), {
        url: "https://www.amazon.com/dp/B0NBMOUNT1",
      });
      const btn = dom.window.document.getElementById("add-to-cart-button");
      // Not marked direct this time — a normal intercepted click opens the picker.
      btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await nextTick();
      const picker = dom.window.document.getElementById("__styx-picker");
      expect(picker).toBeTruthy();

      picker
        .querySelector('[data-styx-action="escape"]')
        .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await nextTick();
      expect(dom.window.document.getElementById("__styx-picker")).toBeNull();

      // Simulate the protection-plan upsell's own completing click, on a
      // different element than the one that was bypassed.
      const upsell = dom.window.document.getElementById("upsell-complete");
      upsell.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await nextTick();

      expect(dom.window.document.getElementById("__styx-picker")).toBeNull();
    });
  });
});
