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

  // Diagnostic logging — mirrors the popup's Developer mode switch (the
  // mc.dev.v1 flag in chrome.storage.local). When it's on, dlog/dwarn print to
  // this page's console AND forward to the service worker's in-memory ring
  // buffer, so the popup's "Copy diagnostic logs" button can gather logs from
  // every context in one paste. When off, they're no-ops with effectively zero
  // overhead. Flip it via Settings → Developer mode in the popup.
  const MC_DEV_FLAG_KEY = "mc.dev.v1";
  const MC_LOG_CTX = "observer";
  let DEBUG = false;
  const mcStringifyArgs = (args) =>
    args
      .map((v) => {
        if (typeof v === "string") return v;
        try { return JSON.stringify(v); } catch (_) { return String(v); }
      })
      .join(" ");
  function mcForwardLog(level, args) {
    try {
      chrome.runtime.sendMessage({
        type: "MC_LOG_PUSH",
        entry: { ts: Date.now(), ctx: MC_LOG_CTX, level, url: location.href, msg: mcStringifyArgs(args) },
      });
    } catch (_) {
      // Extension context invalidated (e.g. reload/update) — ignore.
    }
  }
  const dlog = (...a) => { if (!DEBUG) return; console.log(...a); mcForwardLog("log", a); };
  const dwarn = (...a) => { if (!DEBUG) return; console.warn(...a); mcForwardLog("warn", a); };
  try {
    chrome.storage.local.get(MC_DEV_FLAG_KEY, (r) => {
      DEBUG = !!(r && r[MC_DEV_FLAG_KEY] === true);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (Object.prototype.hasOwnProperty.call(changes, MC_DEV_FLAG_KEY)) {
        DEBUG = changes[MC_DEV_FLAG_KEY].newValue === true;
      }
    });
    window.addEventListener("error", (e) => {
      if (!DEBUG) return;
      mcForwardLog("error", [`uncaught: ${e.message} @ ${e.filename}:${e.lineno}`]);
    });
    window.addEventListener("unhandledrejection", (e) => {
      if (!DEBUG) return;
      mcForwardLog("error", [`unhandledrejection: ${(e.reason && e.reason.message) || e.reason}`]);
    });
  } catch (_) {}

  dlog("[Styx ATC] observer.js loaded on", location.href);

  // ---- Page classification ------------------------------------------------

  function isProductPage() {
    // /dp/{ASIN}, /gp/product/{ASIN}, and /gp/aw/d/{ASIN} (mobile web PDP).
    return /\/(?:dp|gp\/product|gp\/aw\/d)\/[A-Z0-9]/i.test(location.pathname);
  }

  function isUpsellSurface() {
    // PDPs are never upsells — guard against the /gp/aw/d/ mobile-web PDP
    // being caught by the `aw` clause below.
    if (isProductPage()) return false;

    // URL-based detection. `aw/(c|o)` covers mobile cart + order surfaces
    // without swallowing the mobile PDP at /gp/aw/d/.
    if (/\/gp\/(?:buy|sw|coverage|aw\/(?:c|o)|cart\/aws)/i.test(location.pathname)) {
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
    // Prefer the hidden ASIN input inside the ATC form. Amazon's twister
    // widget rewrites this value as the user picks size/color/etc., so it
    // reflects the *child* (buyable) variant — which is what the bulk-add
    // endpoint requires. body[data-asin] and the /dp/ URL stay on the
    // parent ASIN even after the user changes variant.
    const ATC_FORM_SELECTORS = [
      "#addToCart_feature_div form input[name='ASIN']",
      "#addToCart_feature_div input[name='ASIN']",
      "form#addToCart input[name='ASIN']",
      "form[action*='/cart/add'] input[name='ASIN']",
    ];
    for (const sel of ATC_FORM_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && el.value && /^[A-Z0-9]{10}$/i.test(el.value)) {
        return el.value.toUpperCase();
      }
    }

    // Any other hidden ASIN input on the page — still typically the live
    // variant on PDPs, just not scoped to the ATC form.
    const anyAsinInput = document.querySelector(
      "input[name='ASIN'], input[name='asin']"
    );
    if (anyAsinInput && anyAsinInput.value && /^[A-Z0-9]{10}$/i.test(anyAsinInput.value)) {
      return anyAsinInput.value.toUpperCase();
    }

    // Fallbacks: parent-ish ASIN sources. Only reached when no twister
    // input is present (non-variant products, or pages where the ATC form
    // hasn't rendered yet).
    const bodyAsin =
      document.body && document.body.getAttribute("data-asin");
    if (bodyAsin && /^[A-Z0-9]{10}$/i.test(bodyAsin)) {
      return bodyAsin.toUpperCase();
    }

    const dpMatch = location.pathname.match(
      /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i
    );
    if (dpMatch) return dpMatch[1].toUpperCase();

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

  /**
   * Read the currently selected variant dimensions from Amazon's
   * "twister" widget. Each dimension lives in a container with an id
   * like `variation_color_name`, `variation_size_name`, etc., and the
   * selected value renders inside a `.selection` span.
   *
   * Returns a human-readable label like "Medium / Navy" — the order
   * matches whatever order Amazon renders the dimensions on the page.
   * Used downstream so the reconciliation UI can tell the user which
   * variant of an item failed in human terms, not just by ASIN.
   *
   * Returns "" for non-variant products (no twister widget).
   */
  function getVariantLabelFromPage() {
    const containers = document.querySelectorAll("[id^='variation_']");
    if (!containers.length) return "";
    const parts = [];
    for (const c of containers) {
      const sel = c.querySelector(".selection");
      const txt = sel && sel.textContent && sel.textContent.trim();
      if (txt) parts.push(txt);
    }
    return parts.join(" / ").slice(0, 200);
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
      variantLabel: getVariantLabelFromPage(),
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

  function getAriaLabelledByText(el) {
    if (!el || !el.getAttribute) return "";
    const ids = String(el.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean);
    if (!ids.length) return "";
    return ids
      .map((id) => {
        const label = document.getElementById(id);
        return label ? (label.innerText || label.textContent || "") : "";
      })
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getControlText(el) {
    if (!el) return "";
    return (
      el.getAttribute && el.getAttribute("aria-label") ||
      getAriaLabelledByText(el) ||
      el.getAttribute && el.getAttribute("title") ||
      el.innerText ||
      el.value ||
      el.textContent ||
      ""
    );
  }

  function getTitleFromAtcButton(btn) {
    if (!btn || !btn.getAttribute) return "";
    const raw = (
      btn.getAttribute("aria-label") ||
      btn.getAttribute("title") ||
      getAriaLabelledByText(btn) ||
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

  function isGenericTileTitle(title) {
    return (
      !title ||
      title === "(untitled)" ||
      /^(?:customers also bought|buy again|sponsored|add to cart|add to basket|previous(?:,\s*disabled)?|next(?:,\s*disabled)?)$/i.test(
        String(title).trim()
      )
    );
  }

  function readLikelyTitle(el) {
    if (!el) return "";
    const raw = (
      el.getAttribute && (el.getAttribute("title") || el.getAttribute("aria-label"))
    ) || el.textContent || "";
    const text = String(raw).replace(/\s+/g, " ").trim();
    if (!text) return "";
    if (isGenericTileTitle(text)) return "";
    if (/^(?:add|move)\s+to\s+(?:cart|basket)\b/i.test(text)) return "";
    if (/^\$?\d+(?:[.,]\d{2})?$/.test(text)) return "";
    if (/^\d+(?:\.\d+)?\s+out\s+of\s+5\s+stars/i.test(text)) return "";
    return text.slice(0, 200);
  }

  function buildItemFromTile(tile, asin) {
    if (!asin) {
      asin = tile.getAttribute("data-asin") || (
        tile.querySelector("[data-asin]") &&
        tile.querySelector("[data-asin]").getAttribute("data-asin")
      );
    }
    if (!asin) return null;

    // Title: prefer product-specific links/headings. Generic carousel controls
    // such as "Previous, Disabled" often have aria labels nearby and should
    // never win over the product name.
    const productLink = tile.querySelector(
      asin
        ? `a[href*='/dp/${asin}'], a[href*='/gp/product/${asin}']`
        : "a[href*='/dp/'], a[href*='/gp/product/']"
    );
    const titleEl =
      tile.querySelector(".sc-product-title") ||
      tile.querySelector("h2 a span, h2 span, h2") ||
      tile.querySelector("a.sc-product-link") ||
      tile.querySelector("a[href*='/dp/'] .a-size-base-plus.a-color-base.a-text-normal") ||
      tile.querySelector("a[href*='/gp/product/'] .a-size-base-plus.a-color-base.a-text-normal") ||
      tile.querySelector("a[href*='/dp/'] .a-size-medium.a-color-base.a-text-normal") ||
      tile.querySelector("a[href*='/gp/product/'] .a-size-medium.a-color-base.a-text-normal") ||
      tile.querySelector("a[href*='/dp/'] .a-size-base.a-color-base.a-text-normal") ||
      tile.querySelector("a[href*='/gp/product/'] .a-size-base.a-color-base.a-text-normal") ||
      tile.querySelector("a[href*='/dp/'] .a-truncate-full") ||
      tile.querySelector("a[href*='/gp/product/'] .a-truncate-full") ||
      productLink ||
      tile.querySelector("a.a-link-normal[title]") ||
      tile.querySelector("[aria-label][role='link']");
    let title = readLikelyTitle(titleEl);
    if (!title) {
      const linkWithLabel = tile.querySelector("a[aria-label]");
      title = readLikelyTitle(linkWithLabel);
    }
    if (!title) {
      title = readLikelyTitle(productLink);
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
          if (buttonTitle && isGenericTileTitle(fromTile.title)) {
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
        const title = isGenericTileTitle(pageItem.title) && buttonTitle
          ? buttonTitle
          : pageItem.title;
        return Object.assign({}, pageItem, {
          title,
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
    const candidate = target.closest("button, a, input, [role='button'], .a-button-inner, .a-button");
    if (!candidate) return null;
    const text = getControlText(candidate).toLowerCase();
    const looksAtc =
      text.includes("add to cart") ||
      text.includes("add to basket") ||
      text.includes("move to cart") ||
      text.includes("move to basket");
    if (!looksAtc) return null;
    if (candidate.matches && candidate.matches(".a-button-inner, .a-button")) {
      const input = candidate.querySelector(
        "input.a-button-input, input[type='submit'], button, [role='button']"
      );
      if (input) return input;
    }
    return candidate;
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
  let _settingsCache = {
    interceptAtc: true,
    theme: null,
  };
  let _cartsCache = [];
  let _storageHydrated = false;
  let _storageHydrationPromise = null;
  // Entitlement mirror — see lib/helpers.js / background.js for the source of
  // truth. Constants duplicated for the same "service-worker can't import
  // ESM" reason the other mirrors exist.
  const FREE_CART_LIMIT = 3;
  const PREMIUM_CART_LIMIT = 20;
  let _entitlementCache = {
    tier: "free",
    premiumUntil: null,
    autoRenew: false,
    source: null,
    lastChecked: 0,
  };

  function isPremiumActive(ent, nowMs) {
    if (!ent || ent.tier !== "premium") return false;
    // null premiumUntil on a premium tier === lifetime (never expires).
    // Mirrors isPremiumActive in lib/helpers.js + background.js.
    if (ent.premiumUntil == null) return true;
    return nowMs < Number(ent.premiumUntil);
  }

  function cartLimitFor(ent, nowMs) {
    return isPremiumActive(ent, nowMs) ? PREMIUM_CART_LIMIT : FREE_CART_LIMIT;
  }

  /**
   * Returns a Set of cart IDs that are currently editable, given the
   * current entitlement and the cart list. Mirrors computeCartAccess in
   * lib/helpers.js. Lapsed-premium and free-tier users with more carts
   * than their limit only get the top-N by lastUsedAt as editable.
   */
  function editableCartIds(carts, ent, nowMs) {
    if (!Array.isArray(carts) || carts.length === 0) return new Set();
    const n = cartLimitFor(ent, nowMs);
    const sorted = [...carts].sort((a, b) => {
      const lu = (Number(b.lastUsedAt) || 0) - (Number(a.lastUsedAt) || 0);
      if (lu !== 0) return lu;
      const sa = (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0);
      if (sa !== 0) return sa;
      return String(a.id).localeCompare(String(b.id));
    });
    return new Set(sorted.slice(0, n).map((c) => c.id));
  }

  /**
   * Two-group sort: editable carts alphabetically first, then read-only
   * carts alphabetically. Used by the picker AND mirrored in popup.js so
   * the user's cart order is consistent across surfaces.
   */
  function sortCartsForDisplay(carts, editableSet) {
    const cmpName = (a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), undefined, {
        sensitivity: "base",
        numeric: true,
      });
    const editable = [];
    const locked = [];
    for (const c of carts || []) {
      if (editableSet.has(c.id)) editable.push(c);
      else locked.push(c);
    }
    editable.sort(cmpName);
    locked.sort(cmpName);
    return editable.concat(locked);
  }

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

  // ---- Side panel --------------------------------------------------------
  //
  // The Styx panel is now a native Chrome side panel (chrome.sidePanel),
  // configured in manifest.json and opened from background.js on toolbar
  // click. The browser genuinely shrinks the page viewport, so Amazon lays
  // out correctly with no in-page reflow. The old in-page iframe overlay,
  // edge tab, collapse logic, page-offset CSS, and Amazon cart-strip
  // repositioning that used to live here were removed for that reason.

  // Read directly from chrome.storage.local. The content script has access
  // to it without round-tripping through the service worker, which removes
  // the race where clicking ATC before MC_LIST_CARTS responds caused the
  // intercept to fall through with an empty carts cache.
  function hydrateCachesFromStorage() {
    if (_storageHydrationPromise) return _storageHydrationPromise;
    _storageHydrationPromise = new Promise((resolve) => {
      try {
        chrome.storage.local.get(
          ["mc.settings.v1", "mc.carts.v1", "mc.entitlement.v1"],
          (result) => {
            if (chrome.runtime.lastError) {
              dwarn("[Styx ATC] storage.get failed:", chrome.runtime.lastError.message);
              _storageHydrated = true;
              resolve(false);
              return;
            }
            const settings = result["mc.settings.v1"];
            if (settings && typeof settings === "object") {
              _settingsCache = Object.assign({}, _settingsCache, settings);
              applyPickerTheme(document.getElementById(PICKER_ID));
            }
            const carts = result["mc.carts.v1"];
            if (Array.isArray(carts)) _cartsCache = carts;
            const ent = result["mc.entitlement.v1"];
            if (ent && typeof ent === "object") {
              _entitlementCache = Object.assign({}, _entitlementCache, ent);
            }
            dlog(
              "[Styx ATC] caches hydrated:",
              {
                interceptAtc: _settingsCache.interceptAtc,
                cartCount: _cartsCache.length,
                tier: _entitlementCache.tier,
              }
            );
            _storageHydrated = true;
            resolve(true);
          }
        );
      } catch (e) {
        dwarn("[Styx ATC] hydration error:", e);
        _storageHydrated = true;
        resolve(false);
      }
    });
    return _storageHydrationPromise;
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
          applyFabPulse(); // live-toggle the floating-button pulse
          // Apply or undo the "Lists → Carts" rebrand live on the lists page.
          if (isWishlistPage()) {
            if (relabelEnabled()) relabelStyxCarts();
            else revertStyxCarts();
          }
        }
      }
      if (changes["mc.carts.v1"]) {
        const next = changes["mc.carts.v1"].newValue;
        _cartsCache = Array.isArray(next) ? next : [];
      }
      if (changes["mc.entitlement.v1"]) {
        const next = changes["mc.entitlement.v1"].newValue;
        if (next && typeof next === "object") {
          _entitlementCache = Object.assign({}, _entitlementCache, next);
        }
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
        const text = getControlText(candidate).toLowerCase();
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
      async (e) => {
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

        let heldClick = false;
        if (!_storageHydrated) {
          dlog("[Styx ATC] holding ATC click until storage hydration completes");
          e.preventDefault();
          e.stopImmediatePropagation();
          heldClick = true;
          await hydrateCachesFromStorage();
        }

        function replayHeldClick() {
          if (!heldClick || !btn || !btn.isConnected) return;
          btn.dataset.styxBypass = "1";
          try { btn.click(); } catch (_err) { /* noop */ }
        }

        if (_settingsCache.restoring) {
          dlog("[Styx ATC] restore in progress after hydration — replaying click");
          replayHeldClick();
          return;
        }
        if (!_settingsCache.interceptAtc) {
          dlog("[Styx ATC] intercept disabled in settings → falling through");
          replayHeldClick();
          return;
        }
        if (!Array.isArray(_cartsCache) || !_cartsCache.length) {
          dlog("[Styx ATC] no saved carts → falling through");
          replayHeldClick();
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
          replayHeldClick();
          return;
        }

        dlog("[Styx ATC] intercepting click; opening picker", item);
        if (!heldClick) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
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
      #${PICKER_ID} .styx-pk-brand {
        display: flex; align-items: center; gap: 7px;
        padding: 9px 40px 8px 14px;
      }
      #${PICKER_ID} .styx-pk-brand-logo {
        width: 18px; height: 18px; flex-shrink: 0; border-radius: 4px;
      }
      #${PICKER_ID} .styx-pk-brand-name {
        font-size: 12px; font-weight: 700; letter-spacing: 0.01em; color: #f3efe6;
      }
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
        color: #ff9900; font-weight: 700;
      }
      #${PICKER_ID} .styx-pk-list {
        list-style: none; margin: 0; padding: 3px 10px 10px;
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
        transition: background 120ms ease, border-color 120ms ease, transform 100ms ease, box-shadow 120ms ease;
      }
      /* Editable carts: proactive orange outline + faint glow so the user
         can see at a glance which carts they can add to. */
      #${PICKER_ID} .styx-pk-row.styx-pk-editable {
        border-color: #ff9900;
        box-shadow: 0 0 0 1px rgba(255, 153, 0, 0.18);
      }
      #${PICKER_ID} .styx-pk-row:hover:not([disabled]) {
        background: #242a32; border-color: #ffb74d;
        transform: translateY(-1px);
        box-shadow: 0 0 0 1px rgba(255, 153, 0, 0.35), 0 4px 14px rgba(0,0,0,0.35);
      }
      #${PICKER_ID} .styx-pk-row[disabled] {
        opacity: 0.6; cursor: not-allowed; transform: none;
        border-color: #2a3038; box-shadow: none;
      }
      #${PICKER_ID} .styx-pk-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      #${PICKER_ID} .styx-pk-row-name { font-size: 13px; font-weight: 600; color: #f3efe6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${PICKER_ID} .styx-pk-row-count {
        font-size: 11px; color: #8a93a0; font-variant-numeric: tabular-nums;
        display: inline-flex; align-items: center; gap: 6px;
      }
      /* "Read-only" pill sits to the left of the item / qty count on locked
         carts. Muted yellow so it reads as a status, not an error. */
      #${PICKER_ID} .styx-pk-row-readonly {
        display: inline-flex; align-items: center;
        padding: 1px 6px;
        background: #3a2c0a;
        color: #ffe6a8;
        border: 1px solid #7a5d18;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        white-space: nowrap;
      }
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
      /* Inline upgrade screen — shown when the user taps a read-only row. */
      #${PICKER_ID} .styx-pk-upgrade {
        padding: 18px 18px 16px;
        display: flex; flex-direction: column; gap: 10px;
        animation: styxPkFade 160ms ease-out;
      }
      #${PICKER_ID} .styx-pk-upgrade-title {
        font-size: 16px; font-weight: 700; color: #f3efe6;
      }
      #${PICKER_ID} .styx-pk-upgrade-sub {
        font-size: 12px; color: #c2cbd6; line-height: 1.45;
      }
      #${PICKER_ID} .styx-pk-upgrade-plan {
        padding: 10px 12px; border-radius: 8px;
        background: #1f242b; border: 1px solid #2a3038;
      }
      #${PICKER_ID} .styx-pk-upgrade-features {
        margin: 0; padding-left: 18px;
        font-size: 12px; color: #c2cbd6; line-height: 1.5;
      }
      #${PICKER_ID} .styx-pk-upgrade-features b { color: #ff9900; font-weight: 700; }
      #${PICKER_ID} .styx-pk-upgrade-actions {
        display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px;
      }
      #${PICKER_ID} .styx-pk-upgrade-cta {
        flex: 1 1 0;
        display: flex; flex-direction: column; align-items: center; gap: 1px;
        appearance: none; padding: 8px 12px;
        background: #ff9900; color: #1a1209;
        border: 1px solid #e88a00; border-radius: 8px;
        font-size: 13px; font-weight: 700; font-family: inherit;
        line-height: 1.2; cursor: pointer;
      }
      #${PICKER_ID} .styx-pk-upgrade-cta-price { font-size: 11px; font-weight: 600; opacity: 0.85; }
      #${PICKER_ID} .styx-pk-upgrade-cta:disabled {
        opacity: 0.55; cursor: not-allowed;
      }
      #${PICKER_ID} .styx-pk-upgrade-back {
        flex-basis: 100%;
        appearance: none; padding: 8px 12px;
        background: transparent; color: #c2cbd6;
        border: 1px solid #3a414b; border-radius: 8px;
        font-size: 12px; font-weight: 600; font-family: inherit;
        cursor: pointer;
      }
      #${PICKER_ID} .styx-pk-upgrade-back:hover { background: #1f242b; color: #fff; }
      /* "+ Create new cart" affordance — lives just below the cart list so
         users can spin up a fresh cart mid-shop without leaving the page.
         Dashed border + muted base color marks it as an action row, not
         another saved cart. */
      #${PICKER_ID} .styx-pk-create-row {
        appearance: none; width: 100%; text-align: center;
        background: transparent; color: #c2cbd6;
        border: 1px dashed #3a414b; border-radius: 10px;
        padding: 9px 10px; margin: 2px 10px 8px;
        width: calc(100% - 20px);
        font-size: 12px; font-weight: 600; font-family: inherit;
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease, color 120ms ease, transform 100ms ease;
      }
      #${PICKER_ID} .styx-pk-create-row:hover {
        background: rgba(255, 153, 0, 0.06);
        border-color: #ff9900; color: #ff9900;
        transform: translateY(-1px);
      }
      /* Inline create-cart screen — swaps in for the list, mirrors the
         upgrade-screen pattern so we don't lose page context. */
      #${PICKER_ID} .styx-pk-create {
        padding: 14px 16px 16px;
        display: flex; flex-direction: column; gap: 10px;
        animation: styxPkFade 160ms ease-out;
      }
      #${PICKER_ID} .styx-pk-create-title {
        font-size: 14px; font-weight: 700; color: #f3efe6;
      }
      #${PICKER_ID} .styx-pk-create-sub {
        font-size: 12px; color: #8a93a0; line-height: 1.4;
      }
      #${PICKER_ID} .styx-pk-create-input {
        appearance: none; width: 100%;
        background: #11151a; color: #f3efe6;
        border: 1px solid #2a3038; border-radius: 8px;
        padding: 9px 10px; font-size: 13px; font-family: inherit;
        outline: none;
        transition: border-color 120ms ease, box-shadow 120ms ease;
      }
      #${PICKER_ID} .styx-pk-create-input:focus {
        border-color: #ff9900;
        box-shadow: 0 0 0 2px rgba(255, 153, 0, 0.22);
      }
      #${PICKER_ID} .styx-pk-create-input.styx-pk-create-error {
        border-color: #ff5d4d;
        box-shadow: 0 0 0 2px rgba(255, 93, 77, 0.22);
        animation: styxPkShake 220ms ease-out;
      }
      @keyframes styxPkShake {
        0%, 100% { transform: translateX(0); }
        25% { transform: translateX(-4px); }
        75% { transform: translateX(4px); }
      }
      #${PICKER_ID} .styx-pk-create-err {
        font-size: 11px; color: #ff8d80; min-height: 14px;
      }
      #${PICKER_ID} .styx-pk-create-actions {
        display: flex; gap: 8px; margin-top: 2px;
      }
      #${PICKER_ID} .styx-pk-create-submit {
        appearance: none; flex: 1;
        background: #ff9900; color: #1a1209;
        border: 1px solid #e88a00; border-radius: 8px;
        padding: 9px 12px; font-size: 13px; font-weight: 700;
        font-family: inherit; cursor: pointer;
      }
      #${PICKER_ID} .styx-pk-create-submit:disabled { opacity: 0.55; cursor: not-allowed; }
      #${PICKER_ID} .styx-pk-create-back {
        appearance: none;
        background: transparent; color: #c2cbd6;
        border: 1px solid #3a414b; border-radius: 8px;
        padding: 9px 12px; font-size: 12px; font-weight: 600;
        font-family: inherit; cursor: pointer;
      }
      #${PICKER_ID} .styx-pk-create-back:hover { background: #1f242b; color: #fff; }
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
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-brand-name,
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-title,
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-row-name,
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-upgrade-title,
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-upgrade-amount,
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-create-title {
        color: #131a22;
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-sub,
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-row-count,
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-upgrade-period,
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-create-sub {
        color: #7a8492;
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-upgrade-sub,
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-upgrade-features {
        color: #4a5360;
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-row,
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-upgrade-plan {
        background: #f7f3ec;
        border-color: #e0d9cc;
        color: #131a22;
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-row:hover:not([disabled]) {
        background: #ffffff;
        border-color: #ff9900;
        box-shadow: 0 0 0 1px rgba(255, 153, 0, 0.25), 0 4px 14px rgba(15,17,21,0.12);
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-row[disabled] {
        border-color: #e0d9cc;
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-row-readonly {
        background: #fff3cd;
        color: #7a4b00;
        border-color: #f0c36a;
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-escape,
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-upgrade-back,
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-create-row,
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-create-back {
        color: #4a5360;
        border-color: #c9bfae;
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-escape:hover,
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-upgrade-back:hover,
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-create-back:hover {
        background: #f7f3ec;
        color: #131a22;
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-confirm {
        background: rgba(255, 255, 255, 0.92);
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-upgrade-stub {
        background: rgba(255, 153, 0, 0.08);
        color: #7a4b00;
      }
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-create-input {
        background: #ffffff;
        color: #131a22;
        border-color: #c9bfae;
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

  /**
   * Swap the open picker's body to a "Renew Premium" CTA, with a Back
   * button to return to the cart list. Triggered when a user taps a
   * read-only row. Same picker DOM stays mounted so we don't lose the
   * Amazon page context.
   *
   * Phase 3 will replace the CTA's "Coming soon" stub with an
   * ExtensionPay.openPaymentPage() call.
   */
  function showPickerUpgradeScreen(root) {
    const modal = root.querySelector(".styx-pk-modal");
    if (!modal) return;
    // Preserve the existing innerHTML so Back can restore it without
    // re-rendering from scratch.
    if (!modal.dataset.styxOriginalHtml) {
      modal.dataset.styxOriginalHtml = modal.innerHTML;
    }
    modal.innerHTML = `
      <button type="button" class="styx-pk-close" data-styx-action="cancel" aria-label="Close">×</button>
      <div class="styx-pk-upgrade">
        <div class="styx-pk-upgrade-title">Renew Premium</div>
        <div class="styx-pk-upgrade-sub">
          This cart is read-only because your Premium has lapsed. Renew to
          add to all your saved carts again — they're still here, untouched.
        </div>
        <div class="styx-pk-upgrade-plan">
          <ul class="styx-pk-upgrade-features">
            <li>Unlimited carts</li>
            <li>Edit, restore, rename, merge — full functionality</li>
            <li>Cancel anytime; carts stay readable</li>
          </ul>
        </div>
        <div class="styx-pk-upgrade-actions">
          <button type="button" class="styx-pk-upgrade-cta" data-styx-action="upgrade-go" data-styx-plan="annual">
            <span class="styx-pk-upgrade-cta-label">Annual</span>
            <span class="styx-pk-upgrade-cta-price">$9.99 / yr</span>
          </button>
          <button type="button" class="styx-pk-upgrade-cta" data-styx-action="upgrade-go" data-styx-plan="lifetime">
            <span class="styx-pk-upgrade-cta-label">Lifetime</span>
            <span class="styx-pk-upgrade-cta-price">$19.99 once</span>
          </button>
          <button type="button" class="styx-pk-upgrade-back" data-styx-action="upgrade-back">← Back to carts</button>
        </div>
      </div>
    `;
  }

  function hidePickerUpgradeScreen(root) {
    const modal = root.querySelector(".styx-pk-modal");
    if (!modal || !modal.dataset.styxOriginalHtml) return;
    modal.innerHTML = modal.dataset.styxOriginalHtml;
    delete modal.dataset.styxOriginalHtml;
  }

  // Standalone Premium upgrade overlay for the on-page wishlist "Send All"
  // button. Reuses the picker's styx-pk-* styling (scoped under #__styx-picker)
  // and wires its own close + plan handlers. Shown when a free-tier user tries
  // to push a LOCKED custom cart to their Amazon cart.
  function openWishlistUpgrade() {
    injectPickerStyles();
    dismissPicker(); // clear any existing overlay reusing PICKER_ID
    const root = document.createElement("div");
    root.id = PICKER_ID;
    root.innerHTML = `
      <div class="styx-pk-backdrop" data-styx-action="cancel"></div>
      <div class="styx-pk-modal">
        <button type="button" class="styx-pk-close" data-styx-action="cancel" aria-label="Close">×</button>
        <div class="styx-pk-brand">
          <svg class="styx-pk-brand-logo" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#131a22"/><g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M12 8.6 L19 8.6 L18.3 11.8 L12.7 11.8 Z"/><path d="M12 8.6 L10.5 7.3"/></g><circle cx="13.7" cy="13.3" r="0.9" fill="#ff9900"/><circle cx="17.3" cy="13.3" r="0.9" fill="#ff9900"/><g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M4 14.4 L11 14.4 L10.3 17.6 L4.7 17.6 Z"/><path d="M4 14.4 L2.5 13.1"/></g><circle cx="5.9" cy="19.1" r="0.9" fill="#ff9900"/><circle cx="9.1" cy="19.1" r="0.9" fill="#ff9900"/><g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M21 14.4 L28 14.4 L27.3 17.6 L21.7 17.6 Z"/><path d="M21 14.4 L19.5 13.1"/></g><circle cx="22.9" cy="19.1" r="0.9" fill="#ff9900"/><circle cx="26.1" cy="19.1" r="0.9" fill="#ff9900"/><path d="M0 19.8 Q 4 18.4, 8 19.8 T 16 19.8 T 24 19.8 T 32 19.8 L 32 32 L 0 32 Z" fill="#1a3a5c" opacity="0.55"/><path d="M0 19.8 Q 4 18.4, 8 19.8 T 16 19.8 T 24 19.8 T 32 19.8" stroke="#5db5ff" stroke-width="1" fill="none" stroke-linecap="round"/></svg>
          <span class="styx-pk-brand-name">Styx Multi-Cart</span>
        </div>
        <div class="styx-pk-upgrade">
          <div class="styx-pk-upgrade-title">Premium cart</div>
          <div class="styx-pk-upgrade-sub">
            This cart is locked on the free plan. Upgrade to send it to your
            Amazon cart and unlock all your carts.
          </div>
          <div class="styx-pk-upgrade-plan">
            <ul class="styx-pk-upgrade-features">
              <li>Use <b>all</b> your Amazon-list carts</li>
              <li>Send any cart to your Amazon cart</li>
              <li>Cancel anytime</li>
            </ul>
          </div>
          <div class="styx-pk-upgrade-actions">
            <button type="button" class="styx-pk-upgrade-cta" data-styx-action="upgrade-go" data-styx-plan="annual">
              <span class="styx-pk-upgrade-cta-label">Annual</span>
              <span class="styx-pk-upgrade-cta-price">$9.99 / yr</span>
            </button>
            <button type="button" class="styx-pk-upgrade-cta" data-styx-action="upgrade-go" data-styx-plan="lifetime">
              <span class="styx-pk-upgrade-cta-label">Lifetime</span>
              <span class="styx-pk-upgrade-cta-price">$19.99 once</span>
            </button>
            <button type="button" class="styx-pk-upgrade-back" data-styx-action="cancel">← Not now</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(root);
    applyPickerTheme(root);
    root.addEventListener("click", (e) => {
      const actEl = e.target.closest("[data-styx-action]");
      if (!actEl) return;
      const act = actEl.dataset.styxAction;
      if (act === "cancel") {
        root.remove();
        return;
      }
      if (act === "upgrade-go") {
        const plan = actEl.getAttribute("data-styx-plan") || "annual";
        const buttons = root.querySelectorAll(".styx-pk-upgrade-cta");
        buttons.forEach((b) => (b.disabled = true));
        sendRequest({ type: "MC_OPEN_PAYMENT_PAGE", plan })
          .then((res) => {
            if (!res || !res.ok) buttons.forEach((b) => (b.disabled = false));
            else root.remove();
          })
          .catch(() => buttons.forEach((b) => (b.disabled = false)));
      }
    });
  }

  /**
   * Swap the picker body to an inline "Create new cart" form. Lets the
   * user spin up a fresh cart mid-shop without leaving the product page.
   * Submitting creates the cart AND drops the current item into it in a
   * single flow, then surfaces the same confirm overlay used by row
   * clicks. Back returns to the cart list without losing context.
   */
  function showPickerCreateScreen(root, item, qty) {
    const modal = root.querySelector(".styx-pk-modal");
    if (!modal) return;
    if (!modal.dataset.styxOriginalHtml) {
      modal.dataset.styxOriginalHtml = modal.innerHTML;
    }
    modal.innerHTML = `
      <button type="button" class="styx-pk-close" data-styx-action="cancel" aria-label="Close">×</button>
      <div class="styx-pk-create">
        <div class="styx-pk-create-title">New cart for this item</div>
        <div class="styx-pk-create-sub">
          Name it, and we'll add "${escapeHtml(truncateForLabel(item.title, 60))}" right in.
        </div>
        <input
          type="text"
          class="styx-pk-create-input"
          placeholder="e.g. Birthday gifts"
          maxlength="80"
          autocomplete="off"
          spellcheck="false"
        />
        <div class="styx-pk-create-err" aria-live="polite"></div>
        <div class="styx-pk-create-actions">
          <button type="button" class="styx-pk-create-back" data-styx-action="create-back">← Back</button>
          <button type="button" class="styx-pk-create-submit" data-styx-create-submit>Create &amp; add</button>
        </div>
      </div>
    `;

    const input = modal.querySelector(".styx-pk-create-input");
    const errSlot = modal.querySelector(".styx-pk-create-err");
    const submitBtn = modal.querySelector("[data-styx-create-submit]");
    const backBtn = modal.querySelector(".styx-pk-create-back");
    if (input) {
      // Defer focus so the swap animation doesn't eat it.
      setTimeout(() => { try { input.focus(); input.select(); } catch (_e) {} }, 0);
      input.addEventListener("input", () => {
        input.classList.remove("styx-pk-create-error");
        if (errSlot) errSlot.textContent = "";
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submitCreate();
        }
      });
    }

    async function submitCreate() {
      if (!input) return;
      const name = (input.value || "").trim();
      if (!name) {
        input.classList.add("styx-pk-create-error");
        if (errSlot) errSlot.textContent = "Give it a name first.";
        try { input.focus(); } catch (_e) {}
        return;
      }
      submitBtn && submitBtn.setAttribute("disabled", "");
      backBtn && backBtn.setAttribute("disabled", "");

      const createRes = await sendRequest({
        type: "MC_CREATE_EMPTY_CART",
        name,
      });
      if (!createRes || !createRes.ok) {
        // Free-tier cart-count limit (or any other gated denial) — surface
        // the existing upgrade screen so the user gets a real CTA instead
        // of an inline error.
        const looksLikeGate =
          createRes && (createRes.upsell || /premium|limit|locked|tier/i.test(String(createRes.reason || createRes.error || "")));
        if (looksLikeGate) {
          showPickerUpgradeScreen(root);
          return;
        }
        if (errSlot) errSlot.textContent = (createRes && createRes.error) || "Could not create cart.";
        submitBtn && submitBtn.removeAttribute("disabled");
        backBtn && backBtn.removeAttribute("disabled");
        return;
      }

      const newCart = createRes.cart;
      const addRes = await sendRequest({
        type: "MC_ADD_ITEM_TO_SAVED_CART",
        savedCartId: newCart.id,
        item: Object.assign({}, item, { quantity: qty }),
      });
      if (!addRes || !addRes.ok) {
        if (errSlot) errSlot.textContent = (addRes && addRes.error) || "Cart created, but could not add the item.";
        submitBtn && submitBtn.removeAttribute("disabled");
        backBtn && backBtn.removeAttribute("disabled");
        return;
      }

      const confirm = document.createElement("div");
      confirm.className = "styx-pk-confirm";
      confirm.textContent = `Added to "${newCart.name}" ✓`;
      modal.appendChild(confirm);
      setTimeout(dismissPicker, 1200);
    }

    if (submitBtn) submitBtn.addEventListener("click", submitCreate);
  }

  function hidePickerCreateScreen(root) {
    const modal = root.querySelector(".styx-pk-modal");
    if (!modal || !modal.dataset.styxOriginalHtml) return;
    modal.innerHTML = modal.dataset.styxOriginalHtml;
    delete modal.dataset.styxOriginalHtml;
  }

  // Picker title can be long. The body text only needs a teaser, so trim
  // hard with an ellipsis. Used by the create-cart screen subtitle.
  function truncateForLabel(s, max) {
    const str = String(s == null ? "" : s);
    if (str.length <= max) return str;
    return str.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
  }

  function onPickerKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // If we're on a swapped-in sub-screen (create or upgrade), Escape
      // should back out to the cart list, not destroy the whole picker.
      // The original-html stash is the signal that a swap is active.
      const root = document.getElementById(PICKER_ID);
      const modal = root && root.querySelector(".styx-pk-modal");
      if (modal && modal.dataset.styxOriginalHtml) {
        modal.innerHTML = modal.dataset.styxOriginalHtml;
        delete modal.dataset.styxOriginalHtml;
        return;
      }
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

    // Compute which carts are editable right now, then sort: editable A–Z
    // first, then read-only A–Z below. Locked rows are kept visible (and
    // clickable) so users can tap them to see the renewal CTA.
    const editable = editableCartIds(_cartsCache, _entitlementCache, Date.now());
    const sortedCarts = sortCartsForDisplay(_cartsCache, editable);

    const cartsHtml = sortedCarts
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
        const isEditable = editable.has(cart.id);
        // Locked rows: stay clickable (no `disabled` attribute) so a click
        // surfaces the renewal CTA. aria-disabled + the .styx-pk-locked
        // class give us the visual + a11y treatment.
        const rowClass = isEditable
          ? "styx-pk-row styx-pk-editable"
          : "styx-pk-row styx-pk-locked";
        const ariaAttr = isEditable
          ? ""
          : 'aria-disabled="true" title="Locked — click to renew Premium"';
        const readOnlyPill = isEditable
          ? ""
          : `<span class="styx-pk-row-readonly">Read-only</span>`;
        return `
          <li>
            <button type="button" class="${rowClass}" data-cart-id="${escapeHtml(cart.id)}" data-cart-name="${escapeHtml(cart.name)}" ${ariaAttr}>
              <div class="styx-pk-row-main">
                <div class="styx-pk-row-name">${escapeHtml(cart.name)}</div>
                <div class="styx-pk-row-count">${readOnlyPill}${(cart.items || []).length} ${itemWord} · ${totalQty} qty</div>
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
        <div class="styx-pk-brand">
          <svg class="styx-pk-brand-logo" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#131a22"/><g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M12 8.6 L19 8.6 L18.3 11.8 L12.7 11.8 Z"/><path d="M12 8.6 L10.5 7.3"/></g><circle cx="13.7" cy="13.3" r="0.9" fill="#ff9900"/><circle cx="17.3" cy="13.3" r="0.9" fill="#ff9900"/><g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M4 14.4 L11 14.4 L10.3 17.6 L4.7 17.6 Z"/><path d="M4 14.4 L2.5 13.1"/></g><circle cx="5.9" cy="19.1" r="0.9" fill="#ff9900"/><circle cx="9.1" cy="19.1" r="0.9" fill="#ff9900"/><g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M21 14.4 L28 14.4 L27.3 17.6 L21.7 17.6 Z"/><path d="M21 14.4 L19.5 13.1"/></g><circle cx="22.9" cy="19.1" r="0.9" fill="#ff9900"/><circle cx="26.1" cy="19.1" r="0.9" fill="#ff9900"/><path d="M0 19.8 Q 4 18.4, 8 19.8 T 16 19.8 T 24 19.8 T 32 19.8 L 32 32 L 0 32 Z" fill="#1a3a5c" opacity="0.55"/><path d="M0 19.8 Q 4 18.4, 8 19.8 T 16 19.8 T 24 19.8 T 32 19.8" stroke="#5db5ff" stroke-width="1" fill="none" stroke-linecap="round"/></svg>
          <span class="styx-pk-brand-name">Styx Multi-Cart</span>
        </div>
        <div class="styx-pk-header">
          ${thumbHtml}
          <div class="styx-pk-meta">
            <div class="styx-pk-title" title="${escapeHtml(item.title || "(untitled)")}" aria-label="${escapeHtml(item.title || "(untitled)")}">${escapeHtml(item.title || "(untitled)")}</div>
            <div class="styx-pk-sub">${priceBit}Qty <b>${qty}</b></div>
          </div>
        </div>
        <div class="styx-pk-prompt">Add to which saved cart?</div>
        <ul class="styx-pk-list">${cartsHtml}</ul>
        <button type="button" class="styx-pk-create-row" data-styx-action="create-new">+ Create new cart</button>
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
        } else if (action.dataset.styxAction === "upgrade-back") {
          hidePickerUpgradeScreen(root);
        } else if (action.dataset.styxAction === "upgrade-go") {
          // Deep-link the chosen plan's ExtPay checkout (background validates
          // the nickname; unknown/absent falls back to the full picker). The
          // background opens the checkout tab; we just fire and forget. Disable
          // both plan buttons so a double-tap can't open two tabs.
          const plan = action.dataset.styxPlan || null;
          const goBtns = root.querySelectorAll('[data-styx-action="upgrade-go"]');
          goBtns.forEach((b) => { b.disabled = true; });
          action.textContent = "Opening checkout…";
          sendRequest({ type: "MC_OPEN_PAYMENT_PAGE", plan }).then((res) => {
            if (!res || !res.ok) {
              goBtns.forEach((b) => { b.disabled = false; });
              action.textContent = "Try again";
            }
          });
        } else if (action.dataset.styxAction === "create-new") {
          showPickerCreateScreen(root, item, qty);
        } else if (action.dataset.styxAction === "create-back") {
          hidePickerCreateScreen(root);
        }
        return;
      }

      const row = e.target.closest(".styx-pk-row");
      if (!row) return;

      // Locked (read-only) row → swap the picker contents to a renewal CTA.
      // Lets the user discover *why* the row is dim without losing context
      // on the Amazon page.
      if (row.getAttribute("aria-disabled") === "true") {
        showPickerUpgradeScreen(root);
        return;
      }

      // Lock the UI while the round-trip happens. Remember which rows were
      // ALREADY locked (aria-disabled read-only carts) so we don't
      // accidentally promote them to editable on a subsequent failure.
      const pickerRows = Array.from(root.querySelectorAll(".styx-pk-row"));
      const preLocked = new Set(
        pickerRows
          .filter((r) => r.getAttribute("aria-disabled") === "true")
          .map((r) => r.dataset.cartId)
      );
      pickerRows.forEach((r) => r.setAttribute("disabled", ""));

      const cartId = row.dataset.cartId;
      const cartName = row.dataset.cartName || "cart";
      const res = await sendRequest({
        type: "MC_ADD_ITEM_TO_SAVED_CART",
        savedCartId: cartId,
        item: Object.assign({}, item, { quantity: qty }),
      });

      if (!res || !res.ok) {
        // Restore only the rows that were editable before the click — leave
        // read-only rows disabled.
        pickerRows.forEach((r) => {
          if (!preLocked.has(r.dataset.cartId)) r.removeAttribute("disabled");
        });
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

  // ---- Amazon wishlist "Send All to Amazon Cart" -------------------------

  const STYX_WL_BTN_ID = "styx-wishlist-add-all";
  const STYX_WL_LABEL = "Send All to Amazon Cart";

  function isWishlistPage() {
    return /\/hz\/wishlist\//i.test(location.pathname);
  }

  // Scrape every rendered wishlist item. Amazon lazy-loads items on scroll,
  // so this captures whatever is currently in the DOM at click time.
  function scrapeWishlistItems() {
    const seen = new Set();
    const out = [];
    const lis = document.querySelectorAll(
      "ul#g-items li[data-id], ol#g-items li[data-id], " +
        "#g-items li[data-itemid], li.g-item-sortable, li[data-id][data-itemid]"
    );
    lis.forEach((li) => {
      let asin = null;
      const link = li.querySelector(
        'a[href*="/dp/"], a[href*="/gp/product/"], a[href*="/gp/aw/d/"]'
      );
      if (link) asin = findAsinInUrl(link.getAttribute("href"));
      if (!asin) asin = findAsinFromButton(li);
      if (!asin || seen.has(asin)) return;
      seen.add(asin);

      let title = "";
      const nameEl = li.querySelector('[id^="itemName_"]') || link;
      if (nameEl) {
        title = (nameEl.getAttribute("title") || nameEl.textContent || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 200);
      }

      let qty = 1;
      const qEl = li.querySelector('[id^="itemRequested_"]');
      if (qEl) {
        const n = parseInt(String(qEl.textContent || "").replace(/\D+/g, ""), 10);
        if (n > 0) qty = Math.min(n, 99);
      }

      out.push({
        asin,
        title,
        quantity: qty,
        url: `https://${location.hostname}/dp/${asin}`,
      });
    });
    return out;
  }

  function setWishlistBtnLabel(btn, text) {
    const label = btn.querySelector(".a-button-text");
    if (label) label.textContent = text;
  }

  function injectWishlistButton() {
    if (document.getElementById(STYX_WL_BTN_ID)) return true;
    const title = document.getElementById("profile-list-name");
    if (!title || !title.parentNode) return false;

    const spacer = document.createElement("span");
    spacer.className = "a-letter-space";

    injectStyxBrandButtonStyles();
    const btn = document.createElement("span");
    btn.id = STYX_WL_BTN_ID;
    btn.className = "styx-brand-btn";
    btn.setAttribute("role", "button");
    btn.tabIndex = 0;
    btn.style.marginLeft = "12px";
    btn.innerHTML =
      STYX_MARK_SVG("styx-btn-mark") +
      '<span class="a-button-text">' + STYX_WL_LABEL + "</span>";

    // Insert "<spacer><button>" right after the list title.
    title.parentNode.insertBefore(btn, title.nextSibling);
    title.parentNode.insertBefore(spacer, btn);

    // Tier gate: if this list is a LOCKED custom cart (free tier, over the
    // 3-cart limit), gray the button and route clicks to the upgrade overlay
    // instead of pushing to the Amazon cart. Access comes from the cached
    // snapshot; on a cache miss it stays unlocked (fail-open).
    const wlMatch = location.pathname.match(/\/wishlist\/ls\/([A-Z0-9]{7,})/i);
    const wlListId = wlMatch ? wlMatch[1].toUpperCase() : null;
    let wlLocked = false;
    if (wlListId) {
      sendRequest({
        type: "MC_GET_LIST_ACCESS",
        listId: wlListId,
        host: location.hostname,
      })
        .then((res) => {
          if (res && res.ok && res.access === "locked") {
            wlLocked = true;
            btn.classList.add("styx-locked");
          }
        })
        .catch(() => {});
    }

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (wlLocked) {
        openWishlistUpgrade();
        return;
      }
      if (btn.dataset.busy === "1") return;

      const items = scrapeWishlistItems();
      if (!items.length) {
        setWishlistBtnLabel(btn, "No items found");
        setTimeout(() => setWishlistBtnLabel(btn, STYX_WL_LABEL), 2000);
        return;
      }

      btn.dataset.busy = "1";
      btn.classList.add("a-button-disabled");
      setWishlistBtnLabel(btn, `Adding ${items.length}…`);

      const res = await sendRequest({
        type: "MC_WISHLIST_ADD_ALL",
        items,
        host: location.hostname,
        listId: wlListId,
      });

      if (!res || !res.ok) {
        setWishlistBtnLabel(btn, (res && res.error) || "Try again");
        btn.dataset.busy = "";
        btn.classList.remove("a-button-disabled");
        setTimeout(() => setWishlistBtnLabel(btn, STYX_WL_LABEL), 2500);
        return;
      }

      // Background drives the confirm flow in a helper tab (often THIS tab,
      // which then navigates away). Reset the button in case it survives.
      setWishlistBtnLabel(btn, `Sending ${items.length} to cart…`);
      setTimeout(() => {
        btn.dataset.busy = "";
        btn.classList.remove("a-button-disabled");
        setWishlistBtnLabel(btn, STYX_WL_LABEL);
      }, 5000);
    });

    dlog("[Styx ATC] wishlist Send-All button injected");
    return true;
  }

  function initWishlist() {
    if (injectWishlistButton()) return;
    // The list title can render after document_idle (hydration / soft nav).
    // Watch the DOM briefly and inject as soon as it appears.
    let tries = 0;
    const mo = new MutationObserver(() => {
      if (injectWishlistButton() || ++tries > 40) mo.disconnect();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 20000);
  }

  // ---- Rebrand: Amazon "Lists" → "Styx Carts" -----------------------------
  //
  // Styx repurposes Amazon wish lists as reusable "carts". To reflect that on
  // Amazon's own surfaces, we relabel (text only, no behavior change):
  //   • the "Your Lists" page heading → "Your Styx Carts"
  //   • each CUSTOM list's name: the word "List" → "Cart" (case-preserving)
  // Amazon's system defaults keep their real names so their special behavior
  // stays recognizable — we never touch "Wish List" or "Alexa List".

  const STYX_CART_RELABEL_FLAG = "styxCartRelabeled";
  const STYX_CART_ORIG_ATTR = "data-styx-cart-orig";

  // Append " Cart" to every list name that doesn't already contain "cart".
  // Non-destructive: the original name stays readable, so even Amazon's
  // defaults keep their identity ("Wish List" → "Wish List Cart", "Mila Wish
  // List" → "Mila Wish List Cart"). Names already carrying "cart" ("Cart Jul
  // 11") are left untouched, which also makes this idempotent.
  function rebrandListName(name) {
    const trimmed = (name || "").trim();
    if (!trimmed) return null;
    if (/cart/i.test(trimmed)) return null; // already a "cart"
    return trimmed + " Cart";
  }

  function relabelEnabled() {
    return _settingsCache.relabelListsAsCarts !== false;
  }

  // Relabel a single text-bearing node, stashing the original so we can both
  // avoid double-processing AND revert cleanly when the toggle is turned off.
  function relabelNode(el, transform) {
    if (!el || el.dataset[STYX_CART_RELABEL_FLAG] === "1") return;
    const original = (el.textContent || "").trim();
    const next = transform(original);
    if (next && next !== original) {
      el.setAttribute(STYX_CART_ORIG_ATTR, original);
      el.textContent = next;
      el.dataset[STYX_CART_RELABEL_FLAG] = "1";
      el.title = next;
    }
  }

  function relabelStyxCarts() {
    if (!relabelEnabled()) return;
    // 1. Page heading: the active "Your Lists" tab.
    document
      .querySelectorAll(".a-tab-heading a, .a-tab-heading span")
      .forEach((el) => {
        if ((el.textContent || "").trim() === "Your Lists") {
          relabelNode(el, () => "Your Styx Carts");
        }
      });

    // 2. Sidebar list names (index + detail pages).
    document
      .querySelectorAll('[id^="wl-list-entry-title-"]')
      .forEach((el) => relabelNode(el, rebrandListName));

    // 3. The open list's detail heading.
    const detail = document.getElementById("profile-list-name");
    if (detail) relabelNode(detail, rebrandListName);
  }

  // Relabel the list names inside the PDP "Add to List" chooser popover (each
  // row is `#atwl-list-name-<listId>`). Amazon adds by the row's listId, not
  // its text, so renaming the visible label is display-only and safe.
  function relabelPdpListChooser() {
    if (!relabelEnabled()) return;
    document
      .querySelectorAll('[id^="atwl-list-name-"]')
      .forEach((el) => relabelNode(el, rebrandListName));
  }

  // Relabel a leaf element whose whole trimmed text exactly equals `from`.
  // Scoped to a root so we never touch matching strings elsewhere on the page.
  function relabelLeafPhrase(root, from, to) {
    root.querySelectorAll("*").forEach((el) => {
      if (el.children.length) return; // leaf text only
      if ((el.textContent || "").trim() === from) relabelNode(el, () => to);
    });
  }

  // Relabel a leaf whose text STARTS WITH `prefixRe`, swapping the matched
  // prefix for `replacement` and keeping the tail (e.g. "List name (required)"
  // → "Styx Cart name (required)"). Reversible via relabelNode.
  function relabelLeafPrefix(root, prefixRe, replacement) {
    root.querySelectorAll("*").forEach((el) => {
      if (el.children.length) return; // leaf text only
      const t = (el.textContent || "").trim();
      const m = t.match(prefixRe);
      if (!m || m.index !== 0) return;
      const next = replacement + t.slice(m[0].length);
      relabelNode(el, () => next);
    });
  }

  // Relabel the Amazon "Add to List" popover / confirmation modal to match the
  // Lists→Carts rebrand:
  //   • header "Add to List"            → "Add to Styx Cart"
  //   • "View Your List" button         → "View Your Styx Cart"
  //   • "N items added to <List>"       → list name gets " Cart" (rebrandListName)
  // Text-only + reversible (relabelNode stashes originals). Scoped to the
  // visible atwl popover so nothing else on the page is affected.
  function relabelAtlModal() {
    if (!relabelEnabled()) return;
    document.querySelectorAll(".a-popover-modal, .a-popover").forEach((pop) => {
      if (!pop.offsetWidth && !pop.offsetHeight) return; // hidden template
      const isAtl =
        pop.querySelector('[id^="atwl-"], [class*="atwl"]') ||
        /\b(Add to List|Add to Styx Cart)\b/.test(pop.textContent || "");
      if (!isAtl) return;

      // Fixed phrases first so the list-name pass below skips these nodes.
      relabelLeafPhrase(pop, "Add to List", "Add to Styx Cart");
      relabelLeafPhrase(pop, "View Your List", "View Your Styx Cart");

      // Confirmation header: Amazon renders "N item(s) added to" and the list
      // name as SIBLING spans (class huc-atwl-header-main), not nested. Rebrand
      // the name span — every header span that isn't the count/"added to"
      // prefix. Also covers the name being a link, in case the markup shifts.
      const PREFIX_RE = /item[s]?\s+added\s+to|^\s*\d+\s+item/i;
      pop
        .querySelectorAll(
          '.huc-atwl-header-main, [class*="atwl-header"] a[href*="wishlist"]'
        )
        .forEach((el) => {
          if (el.children.length) return; // leaf text only
          const t = (el.textContent || "").trim();
          if (!t || PREFIX_RE.test(t)) return; // skip the "N items added to" bit
          relabelNode(el, rebrandListName);
        });
    });
  }

  // Relabel Amazon's native "Create a new list or registry" modal so it reads
  // as creating a Styx Cart (with "Amazon list" kept in parens for clarity):
  //   • title  "Create a new list or registry" → "Create a new Styx Cart (Amazon list)"
  //   • field  "List name (required)"          → "Styx Cart name (required)"
  // Text-only + reversible; scoped to the visible modal via its title text.
  function relabelCreateListModal() {
    if (!relabelEnabled()) return;
    document
      .querySelectorAll(".a-popover-modal, .a-popover, [role='dialog'], .a-modal")
      .forEach((pop) => {
        if (!pop.offsetWidth && !pop.offsetHeight) return; // hidden template
        if (!/Create a new list or registry/i.test(pop.textContent || "")) return;
        relabelLeafPhrase(
          pop,
          "Create a new list or registry",
          "Create a new Styx Cart (Amazon list)"
        );
        // "List name" / "List name (required)" → "Styx Cart name …"
        relabelLeafPrefix(pop, /^List name/i, "Styx Cart name");
      });
  }

  // One pass over every Amazon Add-to-List surface (chooser rows + confirmation
  // modal). Called on init and from the debounced popover observer.
  function relabelPdpAtl() {
    relabelPdpListChooser();
    relabelAtlModal();
  }

  // Watch for Amazon's create-list modal on any page (it appears from the PDP
  // chooser and the lists page) and rebrand it. Top-frame only; debounced;
  // scans only the handful of popover/dialog containers so it's cheap.
  function initCreateListRelabel() {
    if (window.top !== window) return;
    if (!document.body) return;
    relabelCreateListModal();
    let timer = 0;
    const mo = new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = 0;
        relabelCreateListModal();
      }, 200);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // Undo every relabel we applied (used when the setting is toggled off live).
  function revertStyxCarts() {
    document
      .querySelectorAll("[" + STYX_CART_ORIG_ATTR + "]")
      .forEach((el) => {
        el.textContent = el.getAttribute(STYX_CART_ORIG_ATTR) || el.textContent;
        el.removeAttribute(STYX_CART_ORIG_ATTR);
        delete el.dataset[STYX_CART_RELABEL_FLAG];
        el.removeAttribute("title");
      });
  }

  function initStyxCartRelabel() {
    relabelStyxCarts();
    // Amazon hydrates the lists UI after load and re-renders on soft nav; keep
    // a debounced, idempotent pass running scoped to the lists container.
    const root =
      document.getElementById("wishlist-page") ||
      document.getElementById("a-page") ||
      document.documentElement;
    let timer = 0;
    const mo = new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = 0;
        relabelStyxCarts();
      }, 200);
    });
    mo.observe(root, { childList: true, subtree: true });
  }

  // ---- Cart page: "Save cart to a new list" → new Amazon wish list --------
  //
  // On the Amazon Shopping Cart page, drop a button in the buybox that saves
  // everything currently in the cart into a brand-new Amazon wish list. The
  // background (MC_SAVE_LIVE_CART_TO_LIST) scrapes the cart (reusing THIS tab),
  // creates the list, and adds the items via the same driver the popup uses
  // for saved carts. Nothing is stored as a Styx saved cart — it goes straight
  // to Amazon. The button names the list and shows status.

  const STYX_SAVE_CART_BTN_ID = "styx-save-cart";
  const STYX_SAVE_CART_LABEL = "Save cart to a new list";
  const STYX_SAVE_CART_STYLE_ID = "styx-save-cart-style";

  // ---- Shared Styx button branding ---------------------------------------
  // One visual language for every Styx-owned action button (cart page + PDP):
  // dark navy fill (matches the toolbar-icon tile), white bold label, and the
  // orange Styx cart mark. Kept in sync so the two buttons read as one system.
  const STYX_BTN_BG = "linear-gradient(180deg,#1f2d3d,#131a22)";
  const STYX_BTN_BORDER = "rgba(255,153,0,.55)";
  const STYX_BTN_RADIUS = "8px";
  const STYX_ORANGE = "#ff9900";

  // Orange Styx shopping-cart glyph. `cls` lets each caller size/position it.
  function STYX_MARK_SVG(cls) {
    return (
      '<svg class="' + cls + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="' + STYX_ORANGE + '" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M2.5 3.5h2.2l2.2 11.1a1.3 1.3 0 0 0 1.28 1.05h8.3a1.3 1.3 0 0 0 1.27-1.02L20.8 7.5H6"/>' +
      '<circle cx="9" cy="20" r="1.5"/><circle cx="17.5" cy="20" r="1.5"/></svg>'
    );
  }
  // URL-encoded form of the same mark for CSS ::before backgrounds (PDP button,
  // whose DOM belongs to Amazon so we can't inject a child node cleanly).
  const STYX_MARK_URI =
    "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='%23ff9900'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='M2.5%203.5h2.2l2.2%2011.1a1.3%201.3%200%200%200%201.28%201.05h8.3a1.3%201.3%200%200%200%201.27-1.02L20.8%207.5H6'/%3E%3Ccircle%20cx='9'%20cy='20'%20r='1.5'/%3E%3Ccircle%20cx='17.5'%20cy='20'%20r='1.5'/%3E%3C/svg%3E";

  // Shared branding for every Styx-injected inline button on Amazon pages
  // (currently the wishlist "Send All to Amazon Cart"). One class so all our
  // controls read as the same product: navy fill, orange border, white bold
  // label, orange cart mark, 8px radius — matching the PDP "Add to a Styx cart"
  // and cart-page "Save cart to a new list" buttons.
  const STYX_BRAND_BTN_STYLE_ID = "styx-brand-btn-style";
  function injectStyxBrandButtonStyles() {
    if (document.getElementById(STYX_BRAND_BTN_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYX_BRAND_BTN_STYLE_ID;
    style.textContent = `
      .styx-brand-btn {
        display: inline-flex; align-items: center; justify-content: center;
        gap: 6px; padding: 5px 10px; margin: 0; vertical-align: middle;
        font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
        font-size: 13px; line-height: 18px; font-weight: 700;
        border-radius: ${STYX_BTN_RADIUS}; border: 1px solid ${STYX_BTN_BORDER};
        background: ${STYX_BTN_BG}; color: #fff !important; cursor: pointer;
        text-decoration: none; white-space: nowrap;
        box-shadow: 0 1px 2px rgba(15,23,42,.25);
        transition: filter 120ms ease, opacity 120ms ease;
      }
      .styx-brand-btn:hover { filter: brightness(1.12); }
      /* Busy state ("Adding…"): keep the navy fill — force it past Amazon's
         global .a-button-disabled, which would otherwise paint the bg white. */
      .styx-brand-btn.a-button-disabled {
        background: ${STYX_BTN_BG} !important; opacity: .6; cursor: default;
      }
      /* Locked (free-tier over-limit) state: muted gray fill, readable text,
         still clickable (opens the upgrade overlay). */
      .styx-brand-btn.styx-locked {
        background: #d5d9de !important;
        border-color: rgba(0,0,0,.12) !important;
        opacity: 1 !important; filter: none !important; cursor: pointer;
        box-shadow: none;
      }
      .styx-brand-btn.styx-locked .a-button-text,
      .styx-brand-btn.styx-locked .styx-brand-btn-label { color: #6b7280 !important; }
      .styx-brand-btn.styx-locked .styx-btn-mark { opacity: .5; }
      .styx-brand-btn .a-button-text,
      .styx-brand-btn .styx-brand-btn-label {
        color: #fff !important; font-weight: 700 !important;
        padding: 0 !important; margin: 0 !important;
        line-height: 18px !important; font-size: 13px !important;
        height: auto !important; background: transparent !important;
        border: 0 !important; box-shadow: none !important; white-space: nowrap;
      }
      .styx-brand-btn .styx-btn-mark { width: 15px; height: 15px; flex: 0 0 auto; display: block; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---- Styx progress toast (on-page, for long list-save operations) -------
  const STYX_TOAST_ID = "styx-progress-toast";
  let _styxToastHideTimer = 0;

  function ensureStyxToastStyle() {
    if (document.getElementById("styx-toast-style")) return;
    const style = document.createElement("style");
    style.id = "styx-toast-style";
    style.textContent = `
      #${STYX_TOAST_ID} {
        position: fixed; top: 22px; left: 50%; z-index: 2147483000;
        display: flex; align-items: center; gap: 11px;
        max-width: 360px; padding: 13px 15px;
        border-radius: 12px; border: 1px solid ${STYX_BTN_BORDER};
        border-left: 4px solid ${STYX_ORANGE};
        background: ${STYX_BTN_BG}; color: #fff;
        font: 500 13px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
        box-shadow: 0 8px 28px rgba(0,0,0,.4);
        opacity: 0; transform: translate(-50%, -8px);
        transition: opacity 160ms ease, transform 160ms ease;
      }
      #${STYX_TOAST_ID}.styx-toast-in { opacity: 1; transform: translate(-50%, 0); }
      #${STYX_TOAST_ID} .styx-toast-spin {
        width: 18px; height: 18px; flex: 0 0 auto; border-radius: 50%;
        border: 2px solid rgba(255,153,0,.3); border-top-color: ${STYX_ORANGE};
        animation: styx-toast-spin 720ms linear infinite;
      }
      #${STYX_TOAST_ID}.styx-toast-done .styx-toast-spin,
      #${STYX_TOAST_ID}.styx-toast-error .styx-toast-spin { display: none; }
      #${STYX_TOAST_ID} .styx-toast-mark { width: 20px; height: 20px; flex: 0 0 auto; display: none; }
      #${STYX_TOAST_ID}.styx-toast-done .styx-toast-mark { display: block; }
      #${STYX_TOAST_ID} .styx-toast-body { min-width: 0; }
      #${STYX_TOAST_ID} .styx-toast-title { font-weight: 700; }
      #${STYX_TOAST_ID} .styx-toast-detail { color: #c9d4e0; margin-top: 2px; }
      #${STYX_TOAST_ID}.styx-toast-error { border-left-color: #e06565; }
      @keyframes styx-toast-spin { to { transform: rotate(360deg); } }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function showStyxToast(detail) {
    ensureStyxToastStyle();
    if (_styxToastHideTimer) { clearTimeout(_styxToastHideTimer); _styxToastHideTimer = 0; }
    let el = document.getElementById(STYX_TOAST_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = STYX_TOAST_ID;
      el.setAttribute("role", "status");
      el.innerHTML =
        '<div class="styx-toast-spin"></div>' +
        STYX_MARK_SVG("styx-toast-mark") +
        '<div class="styx-toast-body">' +
        '<div class="styx-toast-title">Building your Amazon list</div>' +
        '<div class="styx-toast-detail"></div></div>';
      document.body.appendChild(el);
      requestAnimationFrame(() => el.classList.add("styx-toast-in"));
    }
    el.classList.remove("styx-toast-done", "styx-toast-error");
    setStyxToastDetail(detail);
    return el;
  }

  function setStyxToastDetail(detail) {
    const el = document.getElementById(STYX_TOAST_ID);
    if (!el) return;
    const d = el.querySelector(".styx-toast-detail");
    if (d) d.textContent = detail || "";
  }

  function finishStyxToast(kind, title, detail, hideAfter) {
    const el = showStyxToast(detail);
    el.classList.add(kind === "error" ? "styx-toast-error" : "styx-toast-done");
    const t = el.querySelector(".styx-toast-title");
    if (t && title) t.textContent = title;
    setStyxToastDetail(detail);
    _styxToastHideTimer = setTimeout(() => dismissStyxToast(), hideAfter || 4000);
  }

  function dismissStyxToast() {
    const el = document.getElementById(STYX_TOAST_ID);
    if (!el) return;
    el.classList.remove("styx-toast-in");
    setTimeout(() => { try { el.remove(); } catch (_e) {} }, 220);
  }

  // Background pushes progress here during a cart→list save.
  try {
    chrome.runtime.onMessage.addListener((m) => {
      if (m && m.type === "MC_LIST_SAVE_PROGRESS") {
        showStyxToast(m.detail || "Working…");
      }
    });
  } catch (_e) { /* no runtime — ignore */ }

  function isCartPage() {
    const p = location.pathname;
    // Desktop cart (/gp/cart/view.html) and the short /cart route. Exclude the
    // /gp/cart/aws upsell interstitial (handled as an upsell surface).
    if (/\/gp\/cart\/view\.html/i.test(p)) return true;
    if (/^\/cart\/?$/i.test(p)) return true;
    return false;
  }

  function setSaveCartLabel(btn, text) {
    const label = btn.querySelector(".styx-save-cart-label");
    if (label) label.textContent = text;
  }

  function injectSaveCartButton() {
    if (document.getElementById(STYX_SAVE_CART_BTN_ID)) return true;

    // Anchor to the buybox (subtotal + Proceed to Checkout). Absent on an
    // empty cart, so this naturally no-ops when there's nothing to save.
    const buyBox =
      document.getElementById("sc-buy-box") ||
      document.getElementById("sc-buy-box-ptc-button");
    if (!buyBox) return false;
    const ptc = document.getElementById("sc-buy-box-ptc-button");
    const anchor = (ptc && ptc.closest(".a-button-stack, .sc-buy-box-ptc")) || ptc;
    const container = (anchor && anchor.parentNode) || buyBox;
    if (!container) return false;

    if (!document.getElementById(STYX_SAVE_CART_STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYX_SAVE_CART_STYLE_ID;
      style.textContent = `
        #${STYX_SAVE_CART_BTN_ID} {
          display: flex; align-items: center; justify-content: center; gap: 7px;
          width: 100%; box-sizing: border-box;
          margin-top: 10px; padding: 9px 12px;
          font-size: 13px; line-height: 18px; font-weight: 700;
          text-align: center; border-radius: ${STYX_BTN_RADIUS};
          border: 1px solid ${STYX_BTN_BORDER};
          background: ${STYX_BTN_BG};
          color: #ffffff; cursor: pointer;
          box-shadow: 0 1px 2px rgba(15,23,42,.25);
          transition: filter 120ms ease, opacity 120ms ease;
        }
        #${STYX_SAVE_CART_BTN_ID}:hover { filter: brightness(1.12); }
        #${STYX_SAVE_CART_BTN_ID}:disabled { opacity: 0.6; cursor: default; }
        #${STYX_SAVE_CART_BTN_ID} .styx-btn-mark {
          width: 17px; height: 17px; flex: 0 0 auto; display: block;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = STYX_SAVE_CART_BTN_ID;
    btn.title = "Save everything in this cart to a new Amazon wish list";
    btn.innerHTML =
      STYX_MARK_SVG("styx-btn-mark") +
      '<span class="styx-save-cart-label">' + STYX_SAVE_CART_LABEL + "</span>";

    // Place it right under Proceed to Checkout.
    if (anchor && anchor.nextSibling) {
      container.insertBefore(btn, anchor.nextSibling);
    } else {
      container.appendChild(btn);
    }

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;

      const defaultName = `Cart ${new Date().toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })}`;
      const raw = window.prompt("Name your new Amazon list:", defaultName);
      if (raw === null) return; // user cancelled
      const name = raw.trim() || defaultName;

      btn.disabled = true;
      setSaveCartLabel(btn, "Saving to Amazon…");
      showStyxToast(
        "Opening Amazon tabs to add each item — please keep this tab open."
      );

      // Long-running: background creates the list + adds items via Amazon tabs,
      // streaming progress into the toast, and on success navigates THIS tab to
      // the finished list (so the success state is the list page itself).
      const res = await sendRequest({
        type: "MC_SAVE_LIVE_CART_TO_LIST",
        name,
        host: location.hostname,
      });

      if (res && res.ok) {
        // Background is navigating this tab to the list; keep the toast up as a
        // "done" state in case navigation is briefly delayed.
        const added = res.added || 0;
        finishStyxToast(
          "done",
          "List saved",
          res.failed
            ? `Saved ${added}/${res.total} to "${name}". ${res.failed} need a manual add. Opening your list…`
            : `Saved ${added} item${added === 1 ? "" : "s"} to "${name}". Opening your list…`,
          8000
        );
      } else {
        finishStyxToast("error", "Couldn't save to Amazon", (res && res.error) || "Please try again.", 6000);
        btn.disabled = false;
        setSaveCartLabel(btn, STYX_SAVE_CART_LABEL);
      }
    });

    dlog("[Styx ATC] Save-this-cart button injected");
    return true;
  }

  function initSaveCart() {
    injectSaveCartButton();
    // The buybox re-renders on quantity changes / item removal, which drops
    // our button. Keep a debounced, idempotent re-check running, scoped to
    // the active cart form to bound the cost.
    const root =
      document.getElementById("sc-active-cart") ||
      document.getElementById("activeCartViewForm") ||
      document.documentElement;
    let timer = 0;
    const mo = new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = 0;
        injectSaveCartButton();
      }, 250);
    });
    mo.observe(root, { childList: true, subtree: true });
  }

  // ---- PDP: surface "Save to a List" above "Add to Cart" ------------------
  //
  // Amazon renders the native "Add to List" split-button far below the buybox
  // (#wishlistButtonStack: a default-list button + a ▼ caret that opens the
  // multi-list chooser). We RELOCATE that real node above Add to Cart so
  // a single real click reaches Amazon's own chooser and the user picks any
  // named list. We MOVE the node (never clone): a clone's click is trusted but
  // unbound, whereas moving preserves Amazon's a-declarative handler (verified
  // live — the moved caret still loads the chooser). No background round-trip:
  // the user's own trusted click is the entire mechanism, which is also why
  // this sidesteps Amazon's anti-automation on programmatic list writes.

  const STYX_PDP_ATL_FLAG = "styxAtlRelocated"; // dataset marker on the stack
  const STYX_PDP_ATL_STYLE_ID = "styx-pdp-atl-style";

  // The split-button caret (▼) that opens Amazon's multi-list chooser. Same
  // resolution order as the background driver's pageAddToList (validated live).
  function findAtlCaret(stack) {
    return (
      (stack && stack.querySelector("#add-to-wishlist-button")) ||
      document.getElementById("add-to-wishlist-button") ||
      (stack && stack.querySelector(".a-button-splitdropdown input")) ||
      document.getElementById("wishListDropDown") ||
      null
    );
  }

  // Make the main (left) "Save to a Styx cart" button open the chooser dropdown
  // instead of silently adding to the default list — i.e. behave like the caret.
  // Capture-phase so we run before Amazon's own handler; only intercept clicks
  // on the main button, leaving the real caret and everything else untouched.
  function wireMainButtonOpensChooser(stack) {
    if (!stack || stack.dataset.styxAtlRedirect === "1") return;
    const mainBtn = stack.querySelector("#wishListMainButton");
    if (!mainBtn) return;
    stack.addEventListener(
      "click",
      (e) => {
        if (!mainBtn.contains(e.target)) return; // only the main button
        const caret = findAtlCaret(stack);
        if (!caret || mainBtn.contains(caret)) return; // no separate caret → default
        e.preventDefault();
        e.stopImmediatePropagation();
        caret.click(); // opens the multi-list chooser
      },
      true
    );
    stack.dataset.styxAtlRedirect = "1";
  }

  function stylePdpAddToListButton(stack) {
    // Keep Amazon's button DOM and classes intact so its bound handlers and
    // split-button behavior survive. These overrides are visual only.
    if (!document.getElementById(STYX_PDP_ATL_STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYX_PDP_ATL_STYLE_ID;
      // Branded to match the cart-page "Save cart to a new list" button: navy
      // fill, white bold label, orange Styx cart mark, 8px radius. Amazon's
      // split-button DOM/classes stay intact (handlers survive) — visual only.
      style.textContent = `
        #wishlistButtonStack[data-styx-atl-relocated="1"] {
          width: 100%;
          margin: 0 0 10px !important;
          padding: 0;
          border-radius: ${STYX_BTN_RADIUS};
          overflow: hidden;
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.25);
        }
        #wishlistButtonStack[data-styx-atl-relocated="1"] .a-button {
          background: ${STYX_BTN_BG} !important;
          border-color: ${STYX_BTN_BORDER} !important;
          box-shadow: none !important;
        }
        #wishlistButtonStack[data-styx-atl-relocated="1"] .a-button-inner {
          background: transparent !important;
        }
        #wishlistButtonStack[data-styx-atl-relocated="1"] .a-button-text {
          color: #ffffff !important;
          font-weight: 700 !important;
          text-shadow: none !important;
        }
        #wishlistButtonStack[data-styx-atl-relocated="1"] #wishListMainButton-announce::before {
          content: "";
          display: inline-block;
          width: 16px; height: 16px;
          margin-right: 7px;
          vertical-align: -3px;
          background: url("${STYX_MARK_URI}") no-repeat center / contain;
        }
        #wishlistButtonStack[data-styx-atl-relocated="1"] .a-button:hover {
          filter: brightness(1.12);
        }
        #wishlistButtonStack[data-styx-atl-relocated="1"]:focus-within {
          outline: 3px solid rgba(255, 153, 0, 0.35);
          outline-offset: 2px;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    const label =
      stack.querySelector("#wishListMainButton-announce") ||
      stack.querySelector("#wishListMainButton .a-button-text");
    // Match the Lists→Carts rebrand: when it's on, this reads as a Styx cart
    // action; off, keep Amazon's native wording so the surface stays coherent.
    if (label) {
      label.textContent = relabelEnabled() ? "Add to a Styx cart" : "Add to List";
    }

    // Left button opens the chooser instead of adding to the default list.
    wireMainButtonOpensChooser(stack);
  }

  // With the rebrand on, relabel Amazon's own "Add to Cart" so the destination
  // is explicit next to our "Add to a Styx cart" button. Reversible via
  // relabelNode (revertStyxCarts restores it when the toggle is turned off).
  function relabelAtcButton() {
    if (!relabelEnabled()) return;
    const atc = document.getElementById("add-to-cart-button");
    if (!atc) return;
    const wrap = atc.closest(".a-button");
    const label =
      (wrap && wrap.querySelector(".a-button-text")) ||
      document.getElementById("submit.add-to-cart-announce");
    if (label) relabelNode(label, () => "Add directly to Amazon cart");
  }

  function injectPdpAddToListButton() {
    const atc = document.getElementById("add-to-cart-button");
    if (!atc) return false; // not a buyable PDP (or buybox not hydrated yet)

    const stack = document.getElementById("wishlistButtonStack");
    if (!stack) return false; // wishlist widget not rendered (yet)

    // Put the list action immediately before the Add-to-Cart stack.
    const atcStack = atc.closest(".a-button-stack") || atc.parentElement;
    if (!atcStack || !atcStack.parentNode) return false;

    // Idempotent: already relocated and sitting immediately before Add to Cart.
    if (
      stack.dataset[STYX_PDP_ATL_FLAG] === "1" &&
      atcStack.previousElementSibling === stack
    ) {
      stylePdpAddToListButton(stack);
      return true;
    }

    atcStack.parentNode.insertBefore(stack, atcStack);
    stack.dataset[STYX_PDP_ATL_FLAG] = "1";
    stylePdpAddToListButton(stack);
    dlog("[Styx ATC] relocated Save-to-a-List above Add to Cart");
    return true;
  }

  function initPdpAddToList() {
    injectPdpAddToListButton();
    relabelAtcButton();
    // The buybox hydrates after document_idle and re-renders on variant
    // changes and soft navigations — each can spawn a fresh, unrelocated
    // widget. Keep a debounced, idempotent re-check running, scoped to the
    // stable product container to bound the cost.
    const root = document.getElementById("dp") || document.documentElement;
    let timer = 0;
    const mo = new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = 0;
        injectPdpAddToListButton();
        relabelAtcButton();
      }, 250);
    });
    mo.observe(root, { childList: true, subtree: true });

    // The "Add to List" chooser popover is fetched on caret-click and appended
    // to <body> (outside #dp), so it needs its own watcher to catch + rebrand
    // the list names as they render. Debounced + idempotent (relabelNode flags
    // each node), scoped to body.
    relabelPdpAtl();
    let chooserTimer = 0;
    const chooserMo = new MutationObserver(() => {
      if (chooserTimer) return;
      chooserTimer = setTimeout(() => {
        chooserTimer = 0;
        relabelPdpAtl();
      }, 150);
    });
    chooserMo.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
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
  if (isWishlistPage()) initWishlist();
  if (isWishlistPage()) initStyxCartRelabel();
  if (onProduct) initPdpAddToList();
  if (isCartPage()) initSaveCart();
  initCreateListRelabel();

  // ------------------------------------------------------------------------
  // Floating UI — the primary surface for the extension. A round button
  // pinned to the bottom-right of the viewport (showing the extension icon)
  // toggles a draggable modal that embeds popup.html in an iframe, so every
  // control/behaviour of the old side panel is reused verbatim. The toolbar
  // icon also toggles it (background forwards MC_TOGGLE_FLOATING).
  //
  // observer.js runs in all frames; this UI must exist only in the top frame.
  // ------------------------------------------------------------------------
  const FAB_ID = "__styx-fab";
  const FAB_MODAL_ID = "__styx-fab-modal";
  const FAB_STYLE_ID = "__styx-fab-style";
  const FAB_POS_KEY = "styx.fab.pos.v1"; // per-tab dragged position
  const FAB_OPEN_KEY = "styx.fab.open.v1"; // per-tab open/closed memory
  const FAB_WIDTH = 400;
  const FAB_MARGIN = 20;

  function injectFloatingStyles() {
    if (document.getElementById(FAB_STYLE_ID)) return;
    const css = `
      #${FAB_ID} {
        position: fixed; right: ${FAB_MARGIN}px; bottom: ${FAB_MARGIN}px;
        z-index: 2147483640;
        width: 56px; height: 56px; padding: 0;
        border: none; border-radius: 50%;
        background: #131a22; cursor: pointer;
        box-shadow: 0 6px 20px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.06);
        display: flex; align-items: center; justify-content: center;
        transition: transform .12s ease, box-shadow .12s ease;
      }
      #${FAB_ID}:hover { transform: translateY(-2px);
        box-shadow: 0 10px 26px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,153,0,0.5); }
      #${FAB_ID}:active { transform: translateY(0); }
      #${FAB_ID} img { width: 34px; height: 34px; pointer-events: none; display: block; }
      #${FAB_ID}[hidden] { display: none; }

      /* Orange pulse ring around the button as a reminder to use it. Toggled
         by the "Pulse the floating button" setting (on by default). */
      @keyframes styx-fab-pulse {
        0%   { box-shadow: 0 6px 20px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.06), 0 0 0 0 rgba(255,153,0,0.55); }
        70%  { box-shadow: 0 6px 20px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.06), 0 0 0 14px rgba(255,153,0,0); }
        100% { box-shadow: 0 6px 20px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.06), 0 0 0 0 rgba(255,153,0,0); }
      }
      #${FAB_ID}.styx-fab-pulse { animation: styx-fab-pulse 2s ease-out infinite; }
      #${FAB_ID}.styx-fab-pulse:hover { animation-play-state: paused; }
      /* Motion-averse users still get a cue: a steady orange ring, no pulse. */
      @media (prefers-reduced-motion: reduce) {
        #${FAB_ID}.styx-fab-pulse {
          animation: none;
          box-shadow: 0 6px 20px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.06), 0 0 0 4px rgba(255,153,0,0.55);
        }
      }

      #${FAB_MODAL_ID} {
        position: fixed; right: ${FAB_MARGIN}px; bottom: ${FAB_MARGIN}px;
        z-index: 2147483641;
        width: ${FAB_WIDTH}px; height: min(640px, calc(100vh - ${FAB_MARGIN * 2}px));
        display: flex; flex-direction: column;
        background: #131a22; border-radius: 12px; overflow: hidden;
        box-shadow: 0 18px 50px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          "Helvetica Neue", Arial, sans-serif;
      }
      #${FAB_MODAL_ID}[hidden] { display: none; }
      #${FAB_MODAL_ID} .styx-fab-bar {
        display: flex; align-items: center; gap: 8px;
        height: 36px; flex: 0 0 36px; padding: 0 6px 0 12px;
        background: #0f151c; cursor: move; user-select: none;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      #${FAB_MODAL_ID} .styx-fab-bar-title {
        flex: 1; min-width: 0; font-size: 12px; font-weight: 600;
        color: #f3efe6; letter-spacing: .2px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      #${FAB_MODAL_ID} .styx-fab-bar-close {
        flex: 0 0 auto; width: 26px; height: 26px; padding: 0;
        border: none; border-radius: 6px; background: transparent;
        color: #8a93a0; font-size: 16px; line-height: 1; cursor: pointer;
      }
      #${FAB_MODAL_ID} .styx-fab-bar-close:hover { background: rgba(255,255,255,0.08); color: #fff; }
      #${FAB_MODAL_ID} .styx-fab-frame {
        flex: 1 1 auto; width: 100%; border: none; background: #131a22;
      }
      #${FAB_MODAL_ID}.styx-fab-dragging { user-select: none; }
      #${FAB_MODAL_ID}.styx-fab-dragging .styx-fab-frame { pointer-events: none; }
    `;
    const style = document.createElement("style");
    style.id = FAB_STYLE_ID;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function readStoredOpen() {
    try { return sessionStorage.getItem(FAB_OPEN_KEY) === "1"; } catch (_e) { return false; }
  }
  function writeStoredOpen(open) {
    try { sessionStorage.setItem(FAB_OPEN_KEY, open ? "1" : "0"); } catch (_e) { /* ignore */ }
  }
  function readStoredPos() {
    try {
      const raw = sessionStorage.getItem(FAB_POS_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (typeof p.left === "number" && typeof p.top === "number") return p;
    } catch (_e) { /* ignore */ }
    return null;
  }
  function writeStoredPos(pos) {
    try { sessionStorage.setItem(FAB_POS_KEY, JSON.stringify(pos)); } catch (_e) { /* ignore */ }
  }

  // Clamp a left/top so the modal stays mostly on-screen after viewport changes.
  function clampPos(left, top, el) {
    const w = el.offsetWidth || FAB_WIDTH;
    const h = el.offsetHeight || 400;
    const maxLeft = Math.max(0, window.innerWidth - w);
    const maxTop = Math.max(0, window.innerHeight - Math.min(h, 80));
    return {
      left: Math.min(Math.max(0, left), maxLeft),
      top: Math.min(Math.max(0, top), maxTop)
    };
  }

  function applyPos(modal, pos) {
    modal.style.left = pos.left + "px";
    modal.style.top = pos.top + "px";
    modal.style.right = "auto";
    modal.style.bottom = "auto";
  }

  // Toggle the orange pulse ring on the floating button from the current
  // setting (on by default). Called on init and on live settings changes.
  function applyFabPulse() {
    const fab = document.getElementById(FAB_ID);
    if (!fab) return;
    fab.classList.toggle("styx-fab-pulse", _settingsCache.fabPulse !== false);
  }

  function initFloatingUi() {
    // Top frame only — Amazon embeds many iframes; the FAB belongs on the page.
    if (window.top !== window) return;
    if (!document.body) return;
    if (document.getElementById(FAB_ID)) return;

    injectFloatingStyles();

    const fab = document.createElement("button");
    fab.id = FAB_ID;
    fab.type = "button";
    fab.setAttribute("aria-label", "Open Styx Multi-Cart");
    const icon = document.createElement("img");
    try { icon.src = chrome.runtime.getURL("icons/icon48.png"); } catch (_e) { /* ignore */ }
    icon.alt = "";
    fab.appendChild(icon);

    const modal = document.createElement("div");
    modal.id = FAB_MODAL_ID;
    modal.hidden = true;

    const bar = document.createElement("div");
    bar.className = "styx-fab-bar";
    const title = document.createElement("span");
    title.className = "styx-fab-bar-title";
    title.textContent = "Styx Multi-Cart";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "styx-fab-bar-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "✕";
    bar.appendChild(title);
    bar.appendChild(closeBtn);

    const frame = document.createElement("iframe");
    frame.className = "styx-fab-frame";
    // Lazily set src on first open so we don't spin up popup.js on every page.
    frame.dataset.src = (() => {
      try { return chrome.runtime.getURL("popup.html") + "?surface=floating"; }
      catch (_e) { return ""; }
    })();

    modal.appendChild(bar);
    modal.appendChild(frame);
    document.body.appendChild(fab);
    document.body.appendChild(modal);
    applyFabPulse();

    // Restore a dragged position from this tab's session, if any.
    const storedPos = readStoredPos();
    if (storedPos) applyPos(modal, clampPos(storedPos.left, storedPos.top, modal));

    // Close when the user clicks anywhere outside the modal (i.e. on the page).
    // Clicks inside the iframe don't reach this document, so they never count as
    // "outside"; only true page clicks and the (hidden) FAB are checked.
    function onDocPointerDown(e) {
      if (modal.hidden) return;
      if (modal.contains(e.target)) return;
      if (e.target === fab || fab.contains(e.target)) return;
      closeModal();
    }
    function openModal() {
      if (!frame.src && frame.dataset.src) frame.src = frame.dataset.src;
      modal.hidden = false;
      fab.hidden = true;
      writeStoredOpen(true);
      // Defer so the click that opened the modal doesn't immediately close it.
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      setTimeout(() => {
        if (!modal.hidden) {
          document.addEventListener("pointerdown", onDocPointerDown, true);
        }
      }, 0);
    }
    function closeModal() {
      modal.hidden = true;
      fab.hidden = false;
      writeStoredOpen(false);
      document.removeEventListener("pointerdown", onDocPointerDown, true);
    }
    function toggleModal() {
      if (modal.hidden) openModal(); else closeModal();
    }

    fab.addEventListener("click", openModal);
    closeBtn.addEventListener("click", closeModal);

    // Drag the modal by its title bar. Switches from right/bottom anchoring to
    // left/top on first move, then persists the position for this tab.
    let dragging = false;
    let dx = 0;
    let dy = 0;
    bar.addEventListener("pointerdown", (e) => {
      if (e.target === closeBtn || closeBtn.contains(e.target)) return;
      dragging = true;
      const rect = modal.getBoundingClientRect();
      dx = e.clientX - rect.left;
      dy = e.clientY - rect.top;
      applyPos(modal, { left: rect.left, top: rect.top });
      modal.classList.add("styx-fab-dragging");
      try { bar.setPointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
      e.preventDefault();
    });
    bar.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const pos = clampPos(e.clientX - dx, e.clientY - dy, modal);
      applyPos(modal, pos);
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      modal.classList.remove("styx-fab-dragging");
      try { bar.releasePointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
      const rect = modal.getBoundingClientRect();
      writeStoredPos({ left: rect.left, top: rect.top });
    }
    bar.addEventListener("pointerup", endDrag);
    bar.addEventListener("pointercancel", endDrag);

    // Keep the modal on-screen if the window shrinks after a drag.
    window.addEventListener("resize", () => {
      if (modal.hidden || modal.style.left === "" || modal.style.left === "auto") return;
      const pos = clampPos(parseInt(modal.style.left, 10) || 0, parseInt(modal.style.top, 10) || 0, modal);
      applyPos(modal, pos);
    });

    // Toolbar icon → background forwards this to toggle the modal.
    try {
      chrome.runtime.onMessage.addListener((m) => {
        if (m && m.type === "MC_TOGGLE_FLOATING") toggleModal();
      });
    } catch (_e) { /* no runtime — ignore */ }

    // Restore open state across Amazon's full-page navigations.
    if (readStoredOpen()) openModal();
  }

  // Run after the const/function declarations above are initialized (avoids a
  // temporal-dead-zone ReferenceError if called earlier in the init sequence).
  initFloatingUi();
})();
