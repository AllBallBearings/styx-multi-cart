/**
 * observer.js — runs on Amazon product pages and upsell/attach pages.
 *
 * Two jobs:
 *  1. On a product page (/dp/, /gp/product/), when the user clicks
 *     "Add to Cart", tell background.js the ASIN + title so the next
 *     upsell observation can be linked to it.
 *  2. On an upsell/attach surface, when the user picks a coverage option
 *     or declines, tell background.js so it can store the choice
 *     (24 h TTL) for later replay during cart restore.
 *
 * This script is intentionally read-only — it never auto-clicks anything.
 * Replay happens inside restoreCart via chrome.scripting.executeScript.
 */

(function () {
  "use strict";

  const DEBUG = false;
  const dlog = (...a) => { if (DEBUG) console.log(...a); };
  const dwarn = (...a) => { if (DEBUG) console.warn(...a); };

  dlog("[Styx ATC] observer.js loaded on", location.href);

  // ---- Page classification ------------------------------------------------

  function isProductPage() {
    return /\/(?:dp|gp\/product)\/[A-Z0-9]/i.test(location.pathname);
  }

  function isUpsellSurface() {
    // URL-based detection
    if (/\/gp\/(?:buy|sw|coverage|aw|cart\/aws)/i.test(location.pathname)) {
      return true;
    }
    if (
      /attach|warranty|protection|service-plan|coverage/i.test(
        location.pathname + location.search
      )
    ) {
      return true;
    }
    // DOM-based detection (modal sidesheet style)
    if (
      document.querySelector(
        "input[type='radio'][name='attachSiCoverageName'], " +
          "input[name='submit.attach-warranty-handler-no-warranty'], " +
          "input[name='submit.attach-sidesheet-no-coverage'], " +
          "input[name='submit.add-to-cart-no-warranty']"
      )
    ) {
      return true;
    }
    return false;
  }

  // Observer now runs on every Amazon page so the ATC intercept can
  // catch clicks no matter where the user is (product detail, search
  // results, deals, etc.). We still detect the original page contexts
  // to decide which scrapers + upsell flow to enable.
  const onProduct = isProductPage();
  const onUpsell = isUpsellSurface();
  dlog("[Styx ATC] page classification", {
    pathname: location.pathname,
    onProduct,
    onUpsell,
  });

  // ---- Helpers ------------------------------------------------------------

  function accessibleDocuments() {
    const docs = [document];
    try {
      if (window.parent && window.parent !== window && window.parent.document) {
        docs.push(window.parent.document);
      }
    } catch (_e) { /* cross-origin or sandboxed parent */ }
    try {
      if (
        window.top &&
        window.top !== window &&
        window.top.document &&
        !docs.includes(window.top.document)
      ) {
        docs.push(window.top.document);
      }
    } catch (_e) { /* cross-origin or sandboxed top */ }
    return docs;
  }

  function getAsinFromPage() {
    const bodyAsin =
      document.body && document.body.getAttribute("data-asin");
    if (bodyAsin) return bodyAsin;

    const dpMatch = location.pathname.match(
      /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i
    );
    if (dpMatch) return dpMatch[1].toUpperCase();

    const asinInput = document.querySelector(
      "input[name='ASIN'], input[name='asin']"
    );
    if (asinInput && asinInput.value) return asinInput.value;

    try {
      const params = new URLSearchParams(location.search || "");
      for (const name of ["asin", "ASIN", "pd_rd_i"]) {
        const asin = firstValidAsin(params.get(name));
        if (asin) return asin;
      }
    } catch (_e) { /* ignore */ }

    return null;
  }

  function getProductTitle() {
    for (const doc of accessibleDocuments()) {
      const t = doc.getElementById("productTitle");
      if (t && t.textContent) return t.textContent.trim().slice(0, 200);
    }
    const mainTitle = accessibleDocuments()
      .map((doc) => doc.title || "")
      .find((title) => title && !/^Customize$/i.test(title.trim()));
    if (mainTitle) return mainTitle.replace(/^Amazon\.com\s*[:|-]\s*/, "").trim().slice(0, 200);
    return (document.title || "").replace(/^Amazon\.com\s*[:|-]\s*/, "").trim();
  }

  function isUsableImageUrl(url) {
    return Boolean(
      url &&
        !url.startsWith("data:") &&
        !url.includes("loadIndicators") &&
        !url.includes("transparent-pixel")
    );
  }

  function pickLargestDynamicImage(img) {
    const dyn = img && img.getAttribute("data-a-dynamic-image");
    if (!dyn) return "";
    try {
      const map = JSON.parse(dyn);
      let best = "";
      let bestArea = -1;
      for (const url of Object.keys(map || {})) {
        if (!isUsableImageUrl(url)) continue;
        const dims = map[url] || [0, 0];
        const area = (Number(dims[0]) || 0) * (Number(dims[1]) || 0);
        if (area > bestArea) {
          best = url;
          bestArea = area;
        }
      }
      return best;
    } catch (_e) {
      return "";
    }
  }

  function pickFromSrcset(value) {
    if (!value) return "";
    const parts = String(value)
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(isUsableImageUrl);
    return parts.length ? parts[parts.length - 1] : "";
  }

  function getImageUrlFromImg(img) {
    if (!img || (img.closest && img.closest(".sc-list-item-spinner"))) return "";
    const hires = img.getAttribute("data-old-hires");
    return (
      (isUsableImageUrl(hires) ? hires : "") ||
      pickLargestDynamicImage(img) ||
      (isUsableImageUrl(img.currentSrc) ? img.currentSrc : "") ||
      (isUsableImageUrl(img.getAttribute("data-src")) ? img.getAttribute("data-src") : "") ||
      pickFromSrcset(img.getAttribute("data-srcset") || img.getAttribute("srcset")) ||
      (isUsableImageUrl(img.getAttribute("src")) ? img.getAttribute("src") : "")
    );
  }

  function getProductImageFromPage() {
    // Try the hi-res/lazy-load attributes before visible src; Amazon often
    // leaves a placeholder in src until its own lazy loader runs.
    const candidates = [
      "#landingImage",
      "#imgBlkFront",
      "#main-image-container img",
      "#imageBlock img",
      "img.a-dynamic-image",
      "img[data-a-dynamic-image]",
      "img[data-old-hires]",
      "img[data-src]",
    ];
    for (const doc of accessibleDocuments()) {
      for (const sel of candidates) {
        const img = doc.querySelector(sel);
        if (!img) continue;
        const url = getImageUrlFromImg(img);
        if (url) return url;
      }
    }
    return "";
  }

  function getProductPriceFromPage() {
    // Amazon ships several pricing widgets. Try the most reliable first.
    const candidates = [
      "#corePriceDisplay_desktop_feature_div .a-offscreen",
      "#corePrice_feature_div .a-offscreen",
      "#priceblock_ourprice",
      "#priceblock_dealprice",
      "#priceblock_saleprice",
      ".a-price .a-offscreen",
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.textContent) {
        const txt = el.textContent.trim();
        if (txt) return txt;
      }
    }
    return "";
  }

  function getProductQuantityFromPage() {
    const select = document.getElementById("quantity");
    if (select && select.value) {
      const n = parseInt(select.value, 10);
      if (n > 0) return Math.min(n, 99);
    }
    const input = document.getElementById("qty");
    if (input && input.value) {
      const n = parseInt(input.value, 10);
      if (n > 0) return Math.min(n, 99);
    }
    return 1;
  }

  function buildItemFromProductPage() {
    const asin = getAsinFromPage();
    if (!asin) return null;
    return {
      asin,
      title: getProductTitle(),
      quantity: getProductQuantityFromPage(),
      price: getProductPriceFromPage(),
      image: getProductImageFromPage(),
      url: `https://${location.hostname}/dp/${asin}`,
    };
  }

  /**
   * Find the ASIN that owns a given ATC button by walking up the
   * ancestor chain. Most surfaces put data-asin on some ancestor div,
   * but recommendation rails often put the ASIN payload on the submit
   * control itself as data-asins='["B..."]'.
   */
  function firstValidAsin(value) {
    if (!value) return null;
    const text = String(value);
    const direct = text.match(/^[A-Z0-9]{10}$/i);
    if (direct) return direct[0].toUpperCase();
    const embedded = text.match(/\b([A-Z0-9]{10})\b/i);
    return embedded ? embedded[1].toUpperCase() : null;
  }

  function findAsinInJsonishList(value) {
    if (!value) return null;
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        for (const candidate of parsed) {
          const asin = firstValidAsin(candidate);
          if (asin) return asin;
        }
      }
    } catch (_e) {
      // Amazon sometimes ships JSON-ish attributes; fall through to regex.
    }
    return firstValidAsin(value);
  }

  function findAsinInUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(String(value), location.origin);
      const paramNames = ["asin", "ASIN", "pd_rd_i"];
      for (const name of paramNames) {
        const asin = firstValidAsin(url.searchParams.get(name));
        if (asin) return asin;
      }
      const pathMatch = url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
      if (pathMatch) return pathMatch[1].toUpperCase();
    } catch (_e) {
      // Ignore malformed relative fragments and use the generic fallback.
    }
    return firstValidAsin(value);
  }

  function findAsinFromButton(btn) {
    let el = btn;
    for (let i = 0; i < 16 && el && el !== document.body; i++) {
      if (el.getAttribute) {
        const attrCandidates = [
          ["data-asin", firstValidAsin],
          ["data-csa-c-asin", firstValidAsin],
          ["data-asins", findAsinInJsonishList],
          ["data-url", findAsinInUrl],
        ];
        for (const [name, reader] of attrCandidates) {
          const asin = reader(el.getAttribute(name));
          if (asin) return asin;
        }
        // Some Amazon tile IDs encode the ASIN as `gridCell-{ASIN}` /
        // `gridElement-{ASIN}` / `atc-container-{ASIN}`.
        const id = el.id || "";
        const m = id.match(/[-_]([A-Z0-9]{10})$/i);
        if (m) return m[1].toUpperCase();
      }
      el = el.parentElement;
    }
    return null;
  }

  function getTitleFromAtcButton(btn) {
    if (!btn || !btn.getAttribute) return "";
    const raw = (
      btn.getAttribute("aria-label") ||
      btn.getAttribute("title") ||
      btn.value ||
      btn.textContent ||
      ""
    ).trim();
    return raw
      .replace(/^(?:add|move)\s+to\s+(?:cart|basket)\s*,?\s*/i, "")
      .trim()
      .slice(0, 200);
  }

  function getQuantityFromAtcButton(btn) {
    if (!btn || !btn.getAttribute) return 1;
    const n = parseInt(btn.getAttribute("data-numitems") || "", 10);
    return n > 0 ? Math.min(n, 99) : 1;
  }

  /**
   * Find the product-tile container that holds the title/image/price
   * for a given ASIN. Tries Amazon's well-known ID conventions
   * (`gridCell-{ASIN}`, `gridElement-{ASIN}`) and the search-results
   * card type, then falls back to the nearest [data-asin] ancestor of
   * the button.
   */
  function findTileForAsin(asin, btn) {
    if (asin) {
      const ids = [
        `gridCell-${asin}`,
        `gridElement-${asin}`,
        `widgetFactory-card-${asin}`,
      ];
      for (const id of ids) {
        const t = document.getElementById(id);
        if (t) return t;
      }
      const linked = document.querySelector(
        `[data-asin='${asin}'], a[href*='/dp/${asin}'], a[href*='/gp/product/${asin}']`
      );
      if (linked) {
        const linkedTile =
          linked.closest("[data-component-type='s-search-result'], .sc-list-item, .a-carousel-card, li[data-uuid], [data-cel-widget], [role='listitem']") ||
          linked.closest("div, li");
        if (linkedTile) return linkedTile;
      }
    }
    const TILE_SELECTORS = [
      "[data-component-type='s-search-result']",
      ".sc-list-item",
      ".a-carousel-card",
      "li[data-uuid]",
      "[data-cel-widget][data-csa-c-asin]",
      "[data-csa-c-item-id]",
      "[role='listitem']",
    ];
    for (const sel of TILE_SELECTORS) {
      const t = btn.closest(sel);
      if (t) return t;
    }
    // Some recommendation rails don't mark the card with product data;
    // the submit input owns data-asins and the nearest useful ancestor
    // only reveals itself by containing the product image/link.
    let card = btn.parentElement;
    for (let i = 0; i < 12 && card && card !== document.body; i++) {
      if (
        card.querySelector &&
        card.querySelector("img") &&
        card.querySelector("a[href*='/dp/'], a[href*='/gp/product/'], .sc-product-title, h2")
      ) {
        return card;
      }
      card = card.parentElement;
    }
    // Last resort: nearest data-asin ancestor, no height filter.
    let el = btn.parentElement;
    for (let i = 0; i < 16 && el && el !== document.body; i++) {
      if (el.hasAttribute && el.hasAttribute("data-asin")) return el;
      el = el.parentElement;
    }
    return null;
  }

  function buildItemFromTile(tile, asin) {
    if (!asin) {
      asin = tile.getAttribute("data-asin") || (
        tile.querySelector("[data-asin]") &&
        tile.querySelector("[data-asin]").getAttribute("data-asin")
      );
    }
    if (!asin) return null;

    // Title: prefer the h2 (search), then aria-labelled link, then any link
    const titleEl =
      tile.querySelector(".sc-product-title") ||
      tile.querySelector("h2 a span, h2 span, h2") ||
      tile.querySelector("[aria-label][role='link']") ||
      tile.querySelector("a.a-link-normal[title]") ||
      tile.querySelector("a.sc-product-link");
    let title = "";
    if (titleEl) {
      title = (titleEl.getAttribute("title") || titleEl.textContent || "").trim();
    }
    if (!title) {
      const linkWithLabel = tile.querySelector("a[aria-label]");
      if (linkWithLabel) title = linkWithLabel.getAttribute("aria-label") || "";
    }
    title = (title || "(untitled)").slice(0, 200);

    function isUsableImageUrl(url) {
      return Boolean(
        url &&
          !url.startsWith("data:") &&
          !url.includes("loadIndicators") &&
          !url.includes("transparent-pixel")
      );
    }

    function pickLargestDynamicImage(img) {
      const dyn = img && img.getAttribute("data-a-dynamic-image");
      if (!dyn) return "";
      try {
        const map = JSON.parse(dyn);
        let best = "";
        let bestArea = -1;
        for (const url of Object.keys(map || {})) {
          if (!isUsableImageUrl(url)) continue;
          const dims = map[url] || [0, 0];
          const area = (Number(dims[0]) || 0) * (Number(dims[1]) || 0);
          if (area > bestArea) {
            best = url;
            bestArea = area;
          }
        }
        return best;
      } catch (_e) {
        return "";
      }
    }

    function pickFromSrcset(value) {
      if (!value) return "";
      const parts = String(value)
        .split(",")
        .map((part) => part.trim().split(/\s+/)[0])
        .filter(isUsableImageUrl);
      return parts.length ? parts[parts.length - 1] : "";
    }

    function getImageUrlFromImg(img) {
      if (!img || (img.closest && img.closest(".sc-list-item-spinner"))) return "";
      return (
        pickLargestDynamicImage(img) ||
        (isUsableImageUrl(img.currentSrc) ? img.currentSrc : "") ||
        (isUsableImageUrl(img.getAttribute("data-src")) ? img.getAttribute("data-src") : "") ||
        pickFromSrcset(img.getAttribute("data-srcset") || img.getAttribute("srcset")) ||
        (isUsableImageUrl(img.getAttribute("src")) ? img.getAttribute("src") : "")
      );
    }

    const imgCandidates = [
      tile.querySelector("img.sc-product-image"),
      tile.querySelector("img.s-image"),
      tile.querySelector("img[data-a-dynamic-image]"),
      tile.querySelector("img[data-src]"),
      tile.querySelector("img[data-srcset]"),
      tile.querySelector("img[srcset]"),
      tile.querySelector("img[data-image-latency]"),
      ...Array.from(tile.querySelectorAll("img")).slice(0, 8),
    ].filter(Boolean);
    let image = "";
    for (const img of imgCandidates) {
      image = getImageUrlFromImg(img);
      if (image) break;
    }

    // Price: .a-offscreen is the screen-reader text (full formatted price);
    // .a-price-whole + .a-price-fraction is the visible variant.
    const priceFull = tile.querySelector(".a-price .a-offscreen");
    let price = priceFull ? (priceFull.textContent || "").trim() : "";
    if (!price) {
      const whole = tile.querySelector(".a-price-whole");
      const frac = tile.querySelector(".a-price-fraction");
      if (whole) {
        price = "$" + (whole.textContent || "").trim();
        if (frac) price += "." + (frac.textContent || "").replace(/[^\d]/g, "").slice(0, 2);
      }
    }

    return {
      asin: asin.toUpperCase(),
      title,
      quantity: 1, // tiles don't expose a qty selector; PDP does
      price,
      image,
      url: `https://${location.hostname}/dp/${asin}`,
    };
  }

  /**
   * Pick the best scraping strategy for the click.
   *  1. Find the ASIN by walking up the click target's ancestors (most
   *     surfaces put it on a div somewhere).
   *  2. Find a tile container for that ASIN — either via Amazon's
   *     `gridCell-{ASIN}` ID convention or a generic selector.
   *  3. Scrape title/image/price from the tile.
   *  4. If we're on a /dp/ page and steps 1-3 failed, fall back to the
   *     page-global scrapers.
   *  5. As a last resort, if we have the ASIN but no usable tile, return
   *     a minimal item so the picker can still open.
   */
  function buildItemForClick(btn) {
    const asin = findAsinFromButton(btn);
    if (asin) {
      const quantity = getQuantityFromAtcButton(btn);
      const buttonTitle = getTitleFromAtcButton(btn);
      const pageItem = buildItemFromProductPage();
      const sameAsPageItem =
        pageItem && pageItem.asin === String(asin).toUpperCase();
      const tile = findTileForAsin(asin, btn);
      if (tile) {
        const fromTile = buildItemFromTile(tile, asin);
        if (fromTile) {
          if (
            buttonTitle &&
            (
              !fromTile.title ||
              fromTile.title === "(untitled)" ||
              /^customers also bought$/i.test(fromTile.title)
            )
          ) {
              fromTile.title = buttonTitle;
          }
          if (sameAsPageItem) {
            if (!fromTile.image && pageItem.image) fromTile.image = pageItem.image;
            if (!fromTile.price && pageItem.price) fromTile.price = pageItem.price;
            if (pageItem.variantLabel) fromTile.variantLabel = pageItem.variantLabel;
          }
          return Object.assign(fromTile, { quantity });
        }
      }
      if (sameAsPageItem) {
        return Object.assign({}, pageItem, {
          title: buttonTitle || pageItem.title,
          quantity,
        });
      }
      // Minimal fallback — we know the ASIN but couldn't enrich.
      return {
        asin: asin.toUpperCase(),
        title: buttonTitle || "(item)",
        quantity,
        price: "",
        image: "",
        url: `https://${location.hostname}/dp/${asin}`,
      };
    }
    const pageItem = buildItemFromProductPage();
    if (pageItem) return pageItem;
    return null;
  }

  function send(message) {
    try {
      chrome.runtime.sendMessage(message, () => {
        // swallow chrome.runtime.lastError — extension may have been
        // disabled/reloaded; nothing we can do from here
        void chrome.runtime.lastError;
      });
    } catch (_e) {
      // No-op: extension context invalid (e.g., user just disabled it).
    }
  }

  // ---- Product page: capture ATC click ------------------------------------

  const ATC_SELECTORS = [
    // Product detail page (PDP)
    "#add-to-cart-button",
    "input#add-to-cart-button",
    "input[name='submit.add-to-cart']",
    "input[name='submit.addToCart']",
    "button[name='submit.add-to-cart']",
    "#submit\\.add-to-cart input",
    "span#submit\\.add-to-cart input",
    // Search results tiles + ad/widget rails (button form, camelCase)
    "button[name='submit.addToCart']",
    // Catch-all: any control labeled "Add to cart" via aria-label. Covers
    // newer Amazon surfaces (search, "deals", recommendation rails) where
    // the name attribute varies but the label is stable.
    "button[aria-label^='Add to cart' i]",
    "a[aria-label^='Add to cart' i]",
    "input[aria-label^='Add to cart' i]",
    // Gift/customization iframe flow. The final post-customization ATC is
    // a Mantine button inside /customization/form, not a normal Amazon
    // submit input.
    "button[data-testid='gc-add-to-cart-button' i]",
    "[role='button'][data-testid='gc-add-to-cart-button' i]",
    // Cart / saved-for-later surfaces. Amazon renders "Move to cart" as
    // a submit input with data-action or a generated submit.move-to-cart.*
    // name rather than the normal add-to-cart names.
    "input[data-action='move-to-cart' i]",
    "button[data-action='move-to-cart' i]",
    "input[name^='submit.move-to-cart.' i]",
    "button[name^='submit.move-to-cart.' i]",
    "input[aria-label^='Move to cart' i]",
    "button[aria-label^='Move to cart' i]",
  ];

  /**
   * Walk up the click target looking for an ATC control. Uses
   * `closest()` with a comma-separated selector so depth is unlimited
   * (some Amazon surfaces wrap buttons 10+ levels deep).
   */
  function findAtcButton(target) {
    if (!target || !target.closest) return null;
    // closest() with multiple selectors as one comma-separated string.
    const combined = ATC_SELECTORS.join(",");
    try {
      const hit = target.closest(combined);
      if (hit) return hit;
    } catch (_e) {
      // Fall back to per-selector iteration if combined parses badly
      // in some browser engine variant.
      for (const sel of ATC_SELECTORS) {
        try {
          const hit = target.closest(sel);
          if (hit) return hit;
        } catch (_inner) { /* skip */ }
      }
    }
    const candidate = target.closest("button, a, input, [role='button']");
    if (!candidate) return null;
    const text = (
      candidate.innerText ||
      candidate.value ||
      candidate.getAttribute("aria-label") ||
      candidate.textContent ||
      ""
    ).toLowerCase();
    const looksAtc =
      text.includes("add to cart") ||
      text.includes("add to basket") ||
      text.includes("move to cart") ||
      text.includes("move to basket");
    return looksAtc ? candidate : null;
  }

  function watchAtcClicks() {
    document.addEventListener(
      "click",
      (e) => {
        const btn = findAtcButton(e.target);
        if (!btn) return;
        const item = buildItemForClick(btn);
        if (!item || !item.asin) return;
        send({
          type: "MC_OBSERVE_ATC",
          asin: item.asin,
          title: item.title || getProductTitle(),
          host: location.hostname,
        });
      },
      true // capture phase — get the click before Amazon's own listeners
    );
  }

  // ---- Intercept: route ATC clicks to a saved-cart picker -----------------

  // Cached so click handlers don't pay a runtime.sendMessage round-trip.
  // Refreshed via chrome.storage.onChanged below.
  let _settingsCache = { interceptAtc: true, theme: null };
  let _cartsCache = [];

  function sendRequest(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: "No response" });
        });
      } catch (_e) {
        resolve({ ok: false, error: "Extension context invalid" });
      }
    });
  }

  // Read directly from chrome.storage.local. The content script has access
  // to it without round-tripping through the service worker, which removes
  // the race where clicking ATC before MC_LIST_CARTS responds caused the
  // intercept to fall through with an empty carts cache.
  function hydrateCachesFromStorage() {
    try {
      chrome.storage.local.get(["mc.settings.v1", "mc.carts.v1"], (result) => {
        if (chrome.runtime.lastError) {
          dwarn("[Styx ATC] storage.get failed:", chrome.runtime.lastError.message);
          return;
        }
        const settings = result["mc.settings.v1"];
        if (settings && typeof settings === "object") {
          _settingsCache = Object.assign({}, _settingsCache, settings);
          applyPickerTheme(document.getElementById(PICKER_ID));
        }
        const carts = result["mc.carts.v1"];
        if (Array.isArray(carts)) _cartsCache = carts;
        dlog(
          "[Styx ATC] caches hydrated:",
          { interceptAtc: _settingsCache.interceptAtc, cartCount: _cartsCache.length }
        );
      });
    } catch (e) {
      dwarn("[Styx ATC] hydration error:", e);
    }
  }

  function watchStorageForChanges() {
    if (!chrome.storage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes["mc.settings.v1"]) {
        const next = changes["mc.settings.v1"].newValue;
        if (next && typeof next === "object") {
          _settingsCache = Object.assign({}, _settingsCache, next);
          applyPickerTheme(document.getElementById(PICKER_ID));
        }
      }
      if (changes["mc.carts.v1"]) {
        const next = changes["mc.carts.v1"].newValue;
        _cartsCache = Array.isArray(next) ? next : [];
      }
    });
  }

  /**
   * Diagnostic — logs every click that looks ATC-shaped (an ancestor
   * button/link/input whose text or aria-label mentions "add" + "cart"
   * or "buy now"), so we can see what selectors Amazon is using on
   * pages where the intercept misses. Remove once selector coverage
   * is solid.
   */
  function installAtcDiagnostic() {
    document.addEventListener(
      "click",
      (e) => {
        if (!e.target || !e.target.closest) return;
        const candidate = e.target.closest("button, a, input, [role='button']");
        if (!candidate) return;
        const text = (
          candidate.innerText ||
          candidate.value ||
          candidate.getAttribute("aria-label") ||
          ""
        ).toLowerCase();
        const looksAtc =
          text.indexOf("add to cart") >= 0 ||
          text.indexOf("add to basket") >= 0 ||
          text.indexOf("move to cart") >= 0 ||
          text.indexOf("move to basket") >= 0 ||
          text.indexOf("buy now") >= 0;
        if (!looksAtc) return;
        const matchedBySelectors = !!findAtcButton(e.target);
        dlog("[Styx ATC] diagnostic — ATC-shaped click", {
          matchedBySelectors,
          tag: candidate.tagName,
          name: candidate.getAttribute("name"),
          id: candidate.id,
          ariaLabel: candidate.getAttribute("aria-label"),
          text: text.slice(0, 60),
          classes: (candidate.className || "").toString().slice(0, 120),
        });
      },
      true
    );
  }

  function installAtcIntercept() {
    document.addEventListener(
      "click",
      (e) => {
        const btn = findAtcButton(e.target);
        if (!btn) return;

        // Diagnostic — visible in DevTools so a user can see exactly why
        // the intercept did or didn't fire.
        dlog("[Styx ATC] click on ATC button", {
          interceptAtc: _settingsCache.interceptAtc,
          restoring: !!_settingsCache.restoring,
          cartCount: _cartsCache.length,
          bypass: btn.dataset.styxBypass === "1",
        });

        // During a cart restore, background.js sets restoring:true in
        // mc.settings.v1. We stand down completely so programmatic ATC
        // clicks from pageAddToCart go straight to Amazon's handlers
        // without showing the picker. This is more reliable than the
        // DOM-attribute approach (btn.dataset.styxBypass) because the
        // storage flag is shared across executeScript execution contexts.
        if (_settingsCache.restoring) {
          dlog("[Styx ATC] restore in progress — letting click through");
          return;
        }

        // Escape-hatch path: the picker's "Just add to Amazon cart" button
        // re-clicks the original ATC after setting this flag. We must let
        // that click pass through untouched so Amazon's handlers AND the
        // existing watchAtcClicks() listener (for upsell recording) run.
        if (btn.dataset.styxBypass === "1") {
          delete btn.dataset.styxBypass;
          dlog("[Styx ATC] bypass flag set — letting click through");
          return;
        }

        if (!_settingsCache.interceptAtc) {
          dlog("[Styx ATC] intercept disabled in settings → falling through");
          return;
        }
        if (!Array.isArray(_cartsCache) || !_cartsCache.length) {
          dlog("[Styx ATC] no saved carts → falling through");
          return;
        }

        const item = buildItemForClick(btn);
        if (!item) {
          // Dump the ancestor chain so we can see what data-asin /
          // [data-component-type] / [data-cel-widget] markers exist
          // on this surface and pick selectors that catch it.
          const chain = [];
          let el = btn;
          for (let i = 0; i < 16 && el && el !== document.body; i++) {
            chain.push({
              tag: el.tagName,
              id: el.id || null,
              dataAsin: el.getAttribute && el.getAttribute("data-asin"),
              dataCelWidget: el.getAttribute && el.getAttribute("data-cel-widget"),
              dataComponentType: el.getAttribute && el.getAttribute("data-component-type"),
              dataUuid: el.getAttribute && el.getAttribute("data-uuid"),
              role: el.getAttribute && el.getAttribute("role"),
              classes: ((el.className || "") + "").slice(0, 80),
              offsetHeight: el.offsetHeight,
            });
            el = el.parentElement;
          }
          dlog("[Styx ATC] could not read ASIN → falling through. Ancestor chain:", chain);
          return;
        }

        dlog("[Styx ATC] intercepting click; opening picker", item);
        e.preventDefault();
        e.stopImmediatePropagation();
        openCartPicker(btn, item);
      },
      true
    );
  }

  // ---- Upsell surface: capture user's chosen option -----------------------

  function getOptionDetails(radio) {
    const container =
      radio.closest("[data-coverage-option], .a-row, .a-section, label, li") ||
      radio.parentElement;
    if (!container) return { label: "", price: "", duration: null };

    const text = (container.innerText || container.textContent || "").trim();
    // First non-empty line is typically the coverage name.
    const label = (text.split("\n").map((s) => s.trim()).find(Boolean) || "")
      .slice(0, 140);

    const priceMatch = text.match(/\$\s?\d+(?:\.\d{2})?/);
    const price = priceMatch ? priceMatch[0].replace(/\s+/g, "") : "";

    let duration = null;
    const durMatch = text.match(/(\d+)\s*[-\s]?(year|yr|month|mo)\b/i);
    if (durMatch) {
      const n = parseInt(durMatch[1], 10);
      duration = /year|yr/i.test(durMatch[0]) ? n * 12 : n;
    }
    return { label, price, duration };
  }

  function isDeclineControl(el) {
    if (!el || !el.getAttribute) return false;
    const name = el.getAttribute("name") || "";
    if (
      name === "submit.attach-warranty-handler-no-warranty" ||
      name === "submit.attach-sidesheet-no-coverage" ||
      name === "submit.add-to-cart-no-warranty" ||
      name === "submit.no-thanks"
    ) {
      return true;
    }
    const id = (el.id || "").toLowerCase();
    if (id === "attachsinocoverage" || id === "sinocoverage") return true;

    const t = (el.value || el.textContent || el.getAttribute("aria-label") || "")
      .toLowerCase()
      .trim();
    if (
      t === "no thanks" ||
      t === "no, thanks" ||
      t === "no coverage" ||
      t === "skip protection" ||
      t === "no protection"
    ) {
      return true;
    }
    return false;
  }

  function isCoverageRadio(el) {
    if (!el || el.type !== "radio") return false;
    const name = (el.getAttribute && el.getAttribute("name")) || "";
    if (name === "attachSiCoverageName") return true;
    if (/coverage|warranty|protection/i.test(name)) return true;
    return false;
  }

  function isContinueControl(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag !== "INPUT" && tag !== "BUTTON" && tag !== "A") return false;
    const t = (el.value || el.textContent || el.getAttribute("aria-label") || "")
      .toLowerCase()
      .trim();
    return (
      t.includes("continue") ||
      t.includes("add to cart") ||
      t.includes("proceed to checkout") ||
      t.includes("proceed") ||
      t === "next"
    );
  }

  function watchUpsellClicks() {
    // Coverage selection (a radio click) is staged here and recorded only
    // when the user finalizes via the Continue button. That way we don't
    // record a passing radio click the user then changed their mind on.
    let pendingAccept = null;

    document.addEventListener(
      "click",
      (e) => {
        let el = e.target;
        if (!el) return;

        for (let i = 0; i < 6 && el && el !== document; i++) {
          // Decline: record immediately (Amazon usually submits on click).
          if (isDeclineControl(el)) {
            send({ type: "MC_OBSERVE_UPSELL_CHOICE", choice: "declined" });
            pendingAccept = null;
            return;
          }
          // Accept: stage the option details; record on Continue click.
          if (isCoverageRadio(el)) {
            pendingAccept = getOptionDetails(el);
            return;
          }
          // Continue: finalize a previously staged acceptance.
          if (isContinueControl(el)) {
            if (pendingAccept) {
              send({
                type: "MC_OBSERVE_UPSELL_CHOICE",
                choice: "accepted",
                optionLabel: pendingAccept.label,
                optionPrice: pendingAccept.price,
                optionDuration: pendingAccept.duration,
              });
              pendingAccept = null;
            }
            return;
          }
          el = el.parentElement;
        }
      },
      true
    );
  }

  // ---- Picker overlay -----------------------------------------------------

  const PICKER_ID = "__styx-picker";
  const PICKER_STYLE_ID = "__styx-picker-style";

  function resolvePickerTheme() {
    const theme = _settingsCache && _settingsCache.theme;
    if (theme === "dark" || theme === "light") return theme;
    return window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function applyPickerTheme(root) {
    if (!root) return;
    root.dataset.styxTheme = resolvePickerTheme();
  }

  function isUsablePickerThumb(url) {
    return Boolean(
      url &&
        !url.startsWith("data:") &&
        !url.includes("loadIndicators") &&
        !url.includes("transparent-pixel")
    );
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function injectPickerStyles() {
    if (document.getElementById(PICKER_STYLE_ID)) return;
    const css = `
      #${PICKER_ID} {
        position: fixed; inset: 0; z-index: 2147483646;
        display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          "Helvetica Neue", Arial, sans-serif;
        color: #f3efe6;
      }
      #${PICKER_ID} .styx-pk-backdrop {
        position: absolute; inset: 0;
        background: rgba(8, 12, 18, 0.62);
        backdrop-filter: blur(3px);
        animation: styxPkFade 140ms ease-out;
      }
      #${PICKER_ID} .styx-pk-modal {
        position: relative;
        width: 380px; max-width: calc(100vw - 24px);
        max-height: 78vh; overflow: hidden;
        display: flex; flex-direction: column;
        background: #161a1f;
        border: 1px solid #2a3038;
        border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.4);
        animation: styxPkIn 200ms cubic-bezier(0.2, 0.7, 0.3, 1.15);
      }
      @keyframes styxPkFade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes styxPkIn {
        from { opacity: 0; transform: translateY(8px) scale(0.97); }
        to   { opacity: 1; transform: translateY(0)   scale(1);    }
      }
      #${PICKER_ID} .styx-pk-close {
        position: absolute; top: 8px; right: 8px;
        width: 28px; height: 28px; padding: 0;
        background: transparent; color: #c2cbd6;
        border: 0; border-radius: 50%; cursor: pointer;
        font-size: 20px; line-height: 1;
      }
      #${PICKER_ID} .styx-pk-close:hover { background: rgba(255,255,255,0.08); color: #fff; }
      #${PICKER_ID} .styx-pk-header {
        display: flex; gap: 12px; padding: 14px 40px 12px 14px;
        border-bottom: 1px solid #2a3038;
      }
      #${PICKER_ID} .styx-pk-thumb {
        width: 56px; height: 56px; flex-shrink: 0;
        border-radius: 8px; background: #11151a;
        border: 1px solid #2a3038;
        object-fit: contain;
      }
      #${PICKER_ID} .styx-pk-meta { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; }
      #${PICKER_ID} .styx-pk-title {
        font-size: 13px; font-weight: 600; color: #f3efe6;
        overflow: hidden; text-overflow: ellipsis;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      }
      #${PICKER_ID} .styx-pk-sub { font-size: 11px; color: #8a93a0; font-variant-numeric: tabular-nums; }
      #${PICKER_ID} .styx-pk-sub b { color: #ff9900; font-weight: 600; }
      #${PICKER_ID} .styx-pk-prompt {
        padding: 10px 14px 6px; font-size: 11px;
        text-transform: uppercase; letter-spacing: 0.06em;
        color: #8a93a0; font-weight: 700;
      }
      #${PICKER_ID} .styx-pk-list {
        list-style: none; margin: 0; padding: 0 10px 10px;
        overflow-y: auto; flex: 1;
        display: flex; flex-direction: column; gap: 6px;
      }
      #${PICKER_ID} .styx-pk-row {
        appearance: none; width: 100%; text-align: left;
        background: #1f242b; border: 1px solid #2a3038;
        border-radius: 10px; padding: 9px 10px;
        display: flex; align-items: center; gap: 10px;
        cursor: pointer; color: #f3efe6;
        font-family: inherit;
        transition: background 120ms ease, border-color 120ms ease, transform 100ms ease;
      }
      #${PICKER_ID} .styx-pk-row:hover {
        background: #242a32; border-color: #ff9900;
        transform: translateY(-1px);
      }
      #${PICKER_ID} .styx-pk-row[disabled] { opacity: 0.55; cursor: default; transform: none; }
      #${PICKER_ID} .styx-pk-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      #${PICKER_ID} .styx-pk-row-name { font-size: 13px; font-weight: 600; color: #f3efe6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${PICKER_ID} .styx-pk-row-count { font-size: 11px; color: #8a93a0; font-variant-numeric: tabular-nums; }
      #${PICKER_ID} .styx-pk-row-thumbs { display: flex; gap: 3px; flex-shrink: 0; }
      #${PICKER_ID} .styx-pk-row-thumb {
        width: 28px; height: 28px; border-radius: 4px;
        background: #11151a; border: 1px solid #2a3038;
        object-fit: contain;
      }
      #${PICKER_ID} .styx-pk-footer {
        padding: 10px 14px 14px; border-top: 1px solid #2a3038;
        display: flex; justify-content: stretch;
      }
      #${PICKER_ID} .styx-pk-escape {
        appearance: none; flex: 1;
        background: transparent; color: #c2cbd6;
        border: 1px solid #3a414b; border-radius: 8px;
        padding: 8px 12px; font-size: 12px; font-weight: 600;
        font-family: inherit; cursor: pointer;
      }
      #${PICKER_ID} .styx-pk-escape:hover { background: #1f242b; color: #fff; }
      #${PICKER_ID} .styx-pk-confirm {
        position: absolute; inset: 0;
        display: flex; align-items: center; justify-content: center;
        background: rgba(22, 26, 31, 0.92);
        font-size: 14px; font-weight: 600; color: #34d399;
        text-align: center; padding: 24px;
        animation: styxPkFade 140ms ease-out;
      }
      #${PICKER_ID}[data-styx-theme="light"] {
        color: #131a22;
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-backdrop {
        background: rgba(15, 17, 21, 0.35);
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-modal {
        background: #ffffff;
        border-color: #c9bfae;
        box-shadow: 0 1px 2px rgba(15,17,21,0.08), 0 12px 32px rgba(15,17,21,0.18);
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-close {
        color: #4a5360;
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-close:hover {
        background: rgba(15,17,21,0.06);
        color: #131a22;
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-header,
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-footer {
        border-color: #e0d9cc;
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-thumb,
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-row-thumb {
        background: #f7f3ec;
        border-color: #e0d9cc;
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-title,
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-row-name {
        color: #131a22;
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-sub,
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-prompt,
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-row-count {
        color: #7a8492;
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-row {
        background: #f7f3ec;
        border-color: #e0d9cc;
        color: #131a22;
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-row:hover {
        background: #ffffff;
        border-color: #ff9900;
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-escape {
        color: #4a5360;
        border-color: #c9bfae;
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-escape:hover {
        background: #f7f3ec;
        color: #131a22;
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-confirm {
        background: rgba(255, 255, 255, 0.92);
      }
    `;
    const style = document.createElement("style");
    style.id = PICKER_STYLE_ID;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function dismissPicker() {
    const root = document.getElementById(PICKER_ID);
    if (root) root.remove();
    document.removeEventListener("keydown", onPickerKeydown, true);
  }

  function onPickerKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismissPicker();
    }
  }

  function openCartPicker(originalAtcButton, item) {
    injectPickerStyles();
    dismissPicker(); // never stack two pickers

    const root = document.createElement("div");
    root.id = PICKER_ID;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    applyPickerTheme(root);

    const qty = Math.max(1, Math.min(99, Number(item.quantity) || 1));
    const priceBit = item.price ? `${escapeHtml(item.price)} · ` : "";

    const cartsHtml = _cartsCache
      .map((cart) => {
        const totalQty = (cart.items || []).reduce(
          (n, it) => n + (Number(it.quantity) || 1),
          0
        );
        const itemWord = cart.items && cart.items.length === 1 ? "item" : "items";
        const thumbs = (cart.items || [])
          .slice(0, 3)
          .filter((it) => isUsablePickerThumb(it && it.image))
          .map(
            (it) =>
              `<img class="styx-pk-row-thumb" src="${escapeHtml(it.image)}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.remove()" />`
          )
          .join("");
        return `
          <li>
            <button type="button" class="styx-pk-row" data-cart-id="${escapeHtml(cart.id)}" data-cart-name="${escapeHtml(cart.name)}">
              <div class="styx-pk-row-main">
                <div class="styx-pk-row-name">${escapeHtml(cart.name)}</div>
                <div class="styx-pk-row-count">${(cart.items || []).length} ${itemWord} · ${totalQty} qty</div>
              </div>
              <div class="styx-pk-row-thumbs">${thumbs}</div>
            </button>
          </li>`;
      })
      .join("");

    const thumbHtml = isUsablePickerThumb(item.image)
      ? `<img class="styx-pk-thumb" src="${escapeHtml(item.image)}" alt="" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'" />`
      : `<div class="styx-pk-thumb"></div>`;

    root.innerHTML = `
      <div class="styx-pk-backdrop" data-styx-action="cancel"></div>
      <div class="styx-pk-modal" role="document">
        <button type="button" class="styx-pk-close" data-styx-action="cancel" aria-label="Close">×</button>
        <div class="styx-pk-header">
          ${thumbHtml}
          <div class="styx-pk-meta">
            <div class="styx-pk-title">${escapeHtml(item.title || "(untitled)")}</div>
            <div class="styx-pk-sub">${priceBit}Qty <b>${qty}</b></div>
          </div>
        </div>
        <div class="styx-pk-prompt">Add to which saved cart?</div>
        <ul class="styx-pk-list">${cartsHtml}</ul>
        <div class="styx-pk-footer">
          <button type="button" class="styx-pk-escape" data-styx-action="escape">Just add to Amazon cart</button>
        </div>
      </div>
    `;

    document.body.appendChild(root);
    document.addEventListener("keydown", onPickerKeydown, true);

    root.addEventListener("click", async (e) => {
      const action = e.target.closest("[data-styx-action]");
      if (action) {
        if (action.dataset.styxAction === "cancel") {
          dismissPicker();
        } else if (action.dataset.styxAction === "escape") {
          dismissPicker();
          // Re-fire the ATC click without intercept. The bypass flag is
          // consumed by the intercept listener so Amazon's handlers AND
          // the existing upsell observer get the click.
          if (originalAtcButton && originalAtcButton.isConnected) {
            originalAtcButton.dataset.styxBypass = "1";
            try { originalAtcButton.click(); } catch (_err) { /* noop */ }
          }
        }
        return;
      }

      const row = e.target.closest(".styx-pk-row");
      if (!row) return;
      if (row.hasAttribute("disabled")) return;

      // Lock the UI while the round-trip happens.
      Array.from(root.querySelectorAll(".styx-pk-row")).forEach((r) =>
        r.setAttribute("disabled", "")
      );

      const cartId = row.dataset.cartId;
      const cartName = row.dataset.cartName || "cart";
      const res = await sendRequest({
        type: "MC_ADD_ITEM_TO_SAVED_CART",
        savedCartId: cartId,
        item: Object.assign({}, item, { quantity: qty }),
      });

      if (!res || !res.ok) {
        Array.from(root.querySelectorAll(".styx-pk-row")).forEach((r) =>
          r.removeAttribute("disabled")
        );
        const sub = root.querySelector(".styx-pk-sub");
        if (sub) {
          sub.textContent = (res && res.error) || "Could not add item.";
          sub.style.color = "#ff8d80";
        }
        return;
      }

      const verb = res.action === "bumped" ? "Quantity bumped in" : "Added to";
      const modal = root.querySelector(".styx-pk-modal");
      const confirm = document.createElement("div");
      confirm.className = "styx-pk-confirm";
      confirm.textContent = `${verb} "${cartName}" ✓`;
      modal.appendChild(confirm);
      setTimeout(dismissPicker, 1200);
    });
  }

  // ---- Boot ---------------------------------------------------------------

  // Always install the ATC intercept on Amazon pages. It's a single
  // document-level capture listener — cheap, and it lets us catch ATC
  // clicks no matter where Amazon decided to render them this week.
  //
  // The intercept is installed FIRST so it sees clicks before
  // watchAtcClicks does. When it activates, stopImmediatePropagation
  // blocks watchAtcClicks. The escape-hatch re-click sets a bypass
  // flag so the upsell observer still fires on that path.
  installAtcIntercept();
  installAtcDiagnostic();
  if (onProduct) watchAtcClicks();
  watchStorageForChanges();
  // Hydrate caches by reading chrome.storage.local directly — content
  // scripts have permission, so no service-worker round-trip is needed.
  // Eliminates the race where clicking ATC right after page load fell
  // through because MC_LIST_CARTS hadn't responded yet.
  hydrateCachesFromStorage();
  if (onUpsell) watchUpsellClicks();
})();
