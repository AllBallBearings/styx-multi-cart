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

  // ---- i18n ---------------------------------------------------------------
  // chrome.i18n is available in content-script contexts, so on-page injected
  // UI (buttons, modals, toasts) resolves _locales/<locale>/messages.json the
  // same way the popup does. `t()` mirrors popup.js's helper.
  function t(key, subs) {
    try {
      const msg = chrome.i18n.getMessage(key, subs);
      return msg || key;
    } catch (_e) {
      return key;
    }
  }
  function itemCountTextObserver(n) {
    return n === 1 ? t("popup_count_item_one", [n]) : t("popup_count_item_other", [n]);
  }

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
    let text = String(raw).replace(/\s+/g, " ").trim();
    // Sponsored search tiles prefix the accessible name with "Sponsored Ad - ";
    // strip it so saved items read as the plain product name.
    text = text.replace(/^sponsored(?:\s+ad)?\s*[-–—:]\s*/i, "").trim();
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

  // Last product tile the user engaged with, remembered so we can attribute a
  // subsequent Amazon variant-picker modal (which carries no tile context) back
  // to the right product. See maybeStashTile / buildItemFromAtcModal.
  let _lastTileAtc = null;
  const TILE_STASH_TTL_MS = 120000; // 2 min — long enough to pick a size

  /**
   * Record the product tile behind a click, so that when a multi-variant item
   * on search results opens Amazon's "choose a size" modal (whose Add-to-cart
   * button has no ASIN in its ancestor chain), we can still recover which
   * product it was. Cheap: only does work when the click is inside a tile that
   * exposes a data-asin.
   */
  function maybeStashTile(target) {
    if (!target || !target.closest) return;
    const tile = target.closest(
      "[data-component-type='s-search-result'][data-asin], [data-asin]"
    );
    if (!tile) return;
    const asin = firstValidAsin(tile.getAttribute("data-asin"));
    if (!asin) return;
    try {
      const item = buildItemFromTile(tile, asin);
      if (item && item.asin) {
        _lastTileAtc = Object.assign({}, item, { ts: Date.now() });
      }
    } catch (_e) { /* best-effort */ }
  }

  /**
   * True when a control lives inside Amazon's add-to-cart / variant-picker
   * popover or an equivalent modal, rather than a normal page tile/PDP.
   */
  function isInsideAtcModal(el) {
    if (!el || !el.closest) return false;
    return !!el.closest(
      ".a-popover, .a-popover-wrapper, [data-a-popover], [id^='a-popover'], " +
        "[role='dialog'], .a-modal-scroller, form[action*='add-to-cart' i], " +
        "form[action*='cart/add' i]"
    );
  }

  /** Read the variant label the user picked in the modal's Size dropdown. */
  function getVariantLabelFromModal(scope) {
    if (!scope) return "";
    const prompt = scope.querySelector(".a-dropdown-prompt");
    if (prompt && prompt.textContent) return prompt.textContent.trim().slice(0, 200);
    const select = scope.querySelector("select");
    if (select && select.selectedIndex >= 0 && select.options[select.selectedIndex]) {
      const t = select.options[select.selectedIndex].textContent;
      if (t) return t.trim().slice(0, 200);
    }
    return "";
  }

  /**
   * Resolve the ASIN for an Add-to-cart click inside Amazon's variant-picker
   * modal. The modal reflects the CHILD (chosen-size) ASIN in a few places;
   * prefer those, then fall back to the parent ASIN from the tile we stashed
   * when the modal opened.
   */
  function getAsinFromAtcModal(btn) {
    const scope =
      btn.closest(
        ".a-popover, .a-popover-wrapper, [data-a-popover], [id^='a-popover'], " +
          "[role='dialog'], .a-modal-scroller, form[action*='cart' i]"
      ) || document;
    // 1. Hidden ASIN input in the modal's add-to-cart form (child variant).
    const asinInput = scope.querySelector(
      "input[name='ASIN'], input[name='asin'], input[name*='asin' i][value]"
    );
    if (asinInput) {
      const a = firstValidAsin(asinInput.value);
      if (a) return a;
    }
    // 2. Selected <option> in the size dropdown — value or data-asin.
    const select = scope.querySelector("select");
    if (select && select.selectedIndex >= 0 && select.options[select.selectedIndex]) {
      const opt = select.options[select.selectedIndex];
      const a =
        firstValidAsin(opt.value) ||
        firstValidAsin(opt.getAttribute("data-asin"));
      if (a) return a;
    }
    // 3. A product link inside the modal.
    const link = scope.querySelector(
      "a[href*='/dp/'], a[href*='/gp/product/']"
    );
    if (link) {
      const a = findAsinInUrl(link.getAttribute("href"));
      if (a) return a;
    }
    // 4. data-asin on any modal container.
    const marked = scope.querySelector && scope.querySelector("[data-asin]");
    if (marked) {
      const a = firstValidAsin(marked.getAttribute("data-asin"));
      if (a) return a;
    }
    return null;
  }

  /**
   * Build a cart item for an Add-to-cart click inside the variant-picker modal.
   * Uses the modal's own ASIN when readable, otherwise the stashed tile's
   * parent ASIN. Enriches title/image/price from the stashed tile, since the
   * modal exposes little of that reliably.
   */
  function buildItemFromAtcModal(btn) {
    if (!isInsideAtcModal(btn)) return null;
    const stash =
      _lastTileAtc && Date.now() - _lastTileAtc.ts < TILE_STASH_TTL_MS
        ? _lastTileAtc
        : null;
    const asin = getAsinFromAtcModal(btn) || (stash && stash.asin) || null;
    if (!asin) return null;
    const variantLabel = getVariantLabelFromModal(
      btn.closest(".a-popover, [role='dialog'], form") || document
    );
    return {
      asin: String(asin).toUpperCase(),
      title: (stash && stash.title) || getProductTitle() || "(item)",
      quantity: getQuantityFromAtcButton(btn),
      price: (stash && stash.price) || "",
      image: (stash && stash.image) || "",
      url: `https://${location.hostname}/dp/${asin}`,
      variantLabel: variantLabel || (stash && stash.variantLabel) || "",
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
   *  5. Amazon's variant-picker modal (search multi-variant): recover from
   *     the modal + the stashed tile.
   *  6. As a last resort, if we have the ASIN but no usable tile, return
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
        title: buttonTitle || t("observer_genericItem"),
        quantity,
        price: "",
        image: "",
        url: `https://${location.hostname}/dp/${asin}`,
      };
    }
    const pageItem = buildItemFromProductPage();
    if (pageItem) return pageItem;
    // Amazon's variant-picker modal (search results, multi-variant items): the
    // Add-to-cart button carries no ASIN in its ancestor chain and there's no
    // /dp/ page context. Recover from the modal + the tile we stashed when the
    // sheet opened, so the click still routes to a Styx cart.
    const modalItem = buildItemFromAtcModal(btn);
    if (modalItem) return modalItem;
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
  // Snapshot of the user's Amazon lists (the real carts), mirrored from the
  // SW's mc.amazonlists.v1 cache. The picker offers these as targets; the
  // per-list `access` field carries lock state. See MC_ENSURE_AMAZON_LISTS.
  const AMAZON_LISTS_CACHE_KEY = "mc.amazonlists.v1";
  let _amazonListsCache = { fetchedAt: 0, host: null, lists: [] };
  let _storageHydrated = false;
  let _storageHydrationPromise = null;

  /**
   * Two-group sort: editable lists alphabetically first, then read-only
   * lists alphabetically. Used by the picker so target order is stable.
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
          resolve(response || { ok: false, error: t("popup_err_noSwResponse") });
        });
      } catch (_e) {
        resolve({ ok: false, error: t("observer_extensionContextInvalid") });
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
  // to it without round-tripping through the service worker, so settings and
  // the Amazon-lists snapshot are available before the first ATC click.
  function hydrateCachesFromStorage() {
    if (_storageHydrationPromise) return _storageHydrationPromise;
    _storageHydrationPromise = new Promise((resolve) => {
      try {
        chrome.storage.local.get(
          ["mc.settings.v1", AMAZON_LISTS_CACHE_KEY],
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
            const listSnap = result[AMAZON_LISTS_CACHE_KEY];
            if (listSnap && Array.isArray(listSnap.lists)) {
              _amazonListsCache = listSnap;
            }
            dlog(
              "[Styx ATC] caches hydrated:",
              {
                interceptAtc: _settingsCache.interceptAtc,
                listCount: (_amazonListsCache.lists || []).length,
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
      if (changes[AMAZON_LISTS_CACHE_KEY]) {
        const next = changes[AMAZON_LISTS_CACHE_KEY].newValue;
        if (next && Array.isArray(next.lists)) _amazonListsCache = next;
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
        // Remember the tile behind every click (cheap, no-op off tiles) so a
        // multi-variant item that opens Amazon's size modal can be attributed
        // back to its product when the modal's Add-to-cart is later clicked.
        maybeStashTile(e.target);

        const btn = findAtcButton(e.target);
        if (!btn) return;

        // Diagnostic — visible in DevTools so a user can see exactly why
        // the intercept did or didn't fire.
        dlog("[Styx ATC] click on ATC button", {
          interceptAtc: _settingsCache.interceptAtc,
          restoring: !!_settingsCache.restoring,
          listCount: (_amazonListsCache.lists || []).length,
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

        // Escape-hatch path: the picker's "Add to Amazon cart" button
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
        // No local-cart / list-presence gate: the picker fetches the user's
        // Amazon lists on open (fetch-then-show), so intercept whenever it's
        // enabled and we can read the item. A user with zero lists still gets
        // the picker's "Create new cart" + escape hatch.

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
        position: fixed; inset: 0; z-index: 2147483647 !important;
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
      #${PICKER_ID} .styx-pk-loading,
      #${PICKER_ID} .styx-pk-empty {
        padding: 14px 10px; text-align: center;
        color: #9aa4b0; font-size: 13px;
      }
      #${PICKER_ID} .styx-pk-loading::after {
        content: ""; display: inline-block; width: 12px; height: 12px;
        margin-left: 8px; vertical-align: -2px;
        border: 2px solid #3a424c; border-top-color: #ff9900;
        border-radius: 50%; animation: styx-pk-spin 0.7s linear infinite;
      }
      @keyframes styx-pk-spin { to { transform: rotate(360deg); } }
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
        background: #ffd814; color: #0f1111;
        border: 1px solid #fcd200; border-radius: 8px;
        padding: 8px 12px; font-size: 12px; font-weight: 700;
        font-family: inherit; cursor: pointer;
      }
      #${PICKER_ID} .styx-pk-escape:hover { background: #f7ca00; }
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
        appearance: none; -webkit-appearance: none; width: 100%;
        background: #11151a; color: #f3efe6;
        border: 1px solid #2a3038; border-radius: 8px;
        padding: 9px 10px; font-size: 13px; font-family: inherit;
        outline: none;
        user-select: text !important; -webkit-user-select: text !important;
        pointer-events: auto !important;
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
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-upgrade-back,
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-create-row,
      #${PICKER_ID}[data-styx-theme="light"] .styx-pk-create-back {
        color: #4a5360;
        border-color: #c9bfae;
      }
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
        user-select: text !important;
        -webkit-user-select: text !important;
        pointer-events: auto !important;
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
    restoreCompetingOverlays();
  }

  // While our picker is open it may sit ON TOP of one of Amazon's own overlays
  // — most importantly the multi-variant "choose a size" modal, which the ATC
  // intercept deliberately opens over (see buildItemFromAtcModal). Those
  // overlays run a focus-trap that yanks focus straight back into themselves the
  // instant our create-cart field takes it, leaving a caret that swallows every
  // keystroke. Marking the competing overlay `inert` for the picker's lifetime
  // makes it (and any focus-lock target inside it) unfocusable, so the trap
  // can't fire and our field keeps focus. Tagged so we only ever un-inert the
  // overlays we inerted, and restored on dismiss.
  function neutralizeCompetingOverlays() {
    const picker = document.getElementById(PICKER_ID);
    if (!picker) return;
    document
      .querySelectorAll("[role='dialog'], .a-modal-scroller, .a-popover-modal")
      .forEach((el) => {
        // Never touch our own picker, anything inside it, or an ancestor of it.
        if (el === picker || picker.contains(el) || el.contains(picker)) return;
        if (el.inert) return; // already inert — leave it as we found it
        if (!el.offsetWidth && !el.offsetHeight) return; // hidden template
        try {
          el.setAttribute("inert", "");
          el.dataset.styxInerted = "1";
        } catch (_e) {
          /* inert unsupported — nothing we can do, field may still misbehave */
        }
      });
  }

  function restoreCompetingOverlays() {
    document.querySelectorAll('[data-styx-inerted="1"]').forEach((el) => {
      el.removeAttribute("inert");
      delete el.dataset.styxInerted;
    });
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
  function showPickerUpgradeScreen(root, reason = "locked") {
    const modal = root.querySelector(".styx-pk-modal");
    if (!modal) return;
    // Preserve the existing innerHTML so Back can restore it without
    // re-rendering from scratch.
    if (!modal.dataset.styxOriginalHtml) {
      modal.dataset.styxOriginalHtml = modal.innerHTML;
    }
    const isLimit = reason === "limit";
    const title = isLimit ? t("observer_upgrade_limitTitle") : t("observer_upgrade_renewTitle");
    const sub = isLimit
      ? t("observer_upgrade_limitSub")
      : t("observer_upgrade_renewSub");

    modal.innerHTML = `
      <button type="button" class="styx-pk-close" data-styx-action="cancel" aria-label="${escapeHtml(t("observer_close"))}">×</button>
      <div class="styx-pk-upgrade">
        <div class="styx-pk-upgrade-title">${title}</div>
        <div class="styx-pk-upgrade-sub">${sub}</div>
        <div class="styx-pk-upgrade-plan">
          <ul class="styx-pk-upgrade-features">
            <li>${t("observer_upgrade_feature_unlimited")}</li>
            <li>${t("observer_upgrade_feature_fullEditing")}</li>
            <li>${t("observer_upgrade_feature_cancelAnytime")}</li>
          </ul>
        </div>
        <div class="styx-pk-upgrade-actions">
          <button type="button" class="styx-pk-upgrade-cta" data-styx-action="upgrade-go" data-styx-plan="annual">
            <span class="styx-pk-upgrade-cta-label">${t("popup_paywall_annual")}</span>
            <span class="styx-pk-upgrade-cta-price">${t("popup_paywall_annualPrice")}</span>
          </button>
          <button type="button" class="styx-pk-upgrade-cta" data-styx-action="upgrade-go" data-styx-plan="lifetime">
            <span class="styx-pk-upgrade-cta-label">${t("popup_paywall_lifetime")}</span>
            <span class="styx-pk-upgrade-cta-price">${t("popup_paywall_lifetimePrice")}</span>
          </button>
          <button type="button" class="styx-pk-upgrade-back" data-styx-action="upgrade-back">${t("observer_backToCarts")}</button>
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
        <button type="button" class="styx-pk-close" data-styx-action="cancel" aria-label="${escapeHtml(t("observer_close"))}">×</button>
        <div class="styx-pk-brand">
          <svg class="styx-pk-brand-logo" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#131a22"/><g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M12 8.6 L19 8.6 L18.3 11.8 L12.7 11.8 Z"/><path d="M12 8.6 L10.5 7.3"/></g><circle cx="13.7" cy="13.3" r="0.9" fill="#ff9900"/><circle cx="17.3" cy="13.3" r="0.9" fill="#ff9900"/><g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M4 14.4 L11 14.4 L10.3 17.6 L4.7 17.6 Z"/><path d="M4 14.4 L2.5 13.1"/></g><circle cx="5.9" cy="19.1" r="0.9" fill="#ff9900"/><circle cx="9.1" cy="19.1" r="0.9" fill="#ff9900"/><g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M21 14.4 L28 14.4 L27.3 17.6 L21.7 17.6 Z"/><path d="M21 14.4 L19.5 13.1"/></g><circle cx="22.9" cy="19.1" r="0.9" fill="#ff9900"/><circle cx="26.1" cy="19.1" r="0.9" fill="#ff9900"/><path d="M0 19.8 Q 4 18.4, 8 19.8 T 16 19.8 T 24 19.8 T 32 19.8 L 32 32 L 0 32 Z" fill="#1a3a5c" opacity="0.55"/><path d="M0 19.8 Q 4 18.4, 8 19.8 T 16 19.8 T 24 19.8 T 32 19.8" stroke="#5db5ff" stroke-width="1" fill="none" stroke-linecap="round"/></svg>
          <span class="styx-pk-brand-name">Styx Multi-Cart</span>
        </div>
        <div class="styx-pk-upgrade">
          <div class="styx-pk-upgrade-title">${t("observer_upgrade_premiumCartTitle")}</div>
          <div class="styx-pk-upgrade-sub">
            ${t("observer_upgrade_premiumCartSub")}
          </div>
          <div class="styx-pk-upgrade-plan">
            <ul class="styx-pk-upgrade-features">
              <li>${t("observer_upgrade_feature_allCarts")}</li>
              <li>${t("observer_upgrade_feature_sendAny")}</li>
              <li>${t("observer_upgrade_feature_cancelAnytime")}</li>
            </ul>
          </div>
          <div class="styx-pk-upgrade-actions">
            <button type="button" class="styx-pk-upgrade-cta" data-styx-action="upgrade-go" data-styx-plan="annual">
              <span class="styx-pk-upgrade-cta-label">${t("popup_paywall_annual")}</span>
              <span class="styx-pk-upgrade-cta-price">${t("popup_paywall_annualPrice")}</span>
            </button>
            <button type="button" class="styx-pk-upgrade-cta" data-styx-action="upgrade-go" data-styx-plan="lifetime">
              <span class="styx-pk-upgrade-cta-label">${t("popup_paywall_lifetime")}</span>
              <span class="styx-pk-upgrade-cta-price">${t("popup_paywall_lifetimePrice")}</span>
            </button>
            <button type="button" class="styx-pk-upgrade-back" data-styx-action="cancel">${t("observer_notNow")}</button>
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
  function showPickerCreateScreen(root, item, qty, ctx) {
    const createHost = (ctx && ctx.host) || null;
    const modal = root.querySelector(".styx-pk-modal");
    if (!modal) return;
    if (!modal.dataset.styxOriginalHtml) {
      modal.dataset.styxOriginalHtml = modal.innerHTML;
    }
    modal.innerHTML = `
      <button type="button" class="styx-pk-close" data-styx-action="cancel" aria-label="${escapeHtml(t("observer_close"))}">×</button>
      <div class="styx-pk-create">
        <div class="styx-pk-create-title">${t("observer_create_title")}</div>
        <div class="styx-pk-create-sub">
          ${t("observer_create_sub", [escapeHtml(truncateForLabel(item.title, 60))])}
        </div>
        <input
          type="text"
          class="styx-pk-create-input"
          tabindex="0"
          placeholder="${escapeHtml(t("popup_save_input_placeholder"))}"
          maxlength="80"
          autocomplete="off"
          spellcheck="false"
          autofocus
        />
        <div class="styx-pk-create-err" aria-live="polite"></div>
        <div class="styx-pk-create-actions">
          <button type="button" class="styx-pk-create-back" data-styx-action="create-back">${t("observer_back")}</button>
          <button type="button" class="styx-pk-create-submit" data-styx-create-submit>${t("observer_create_submit")}</button>
        </div>
      </div>
    `;

    const input = modal.querySelector(".styx-pk-create-input");
    const errSlot = modal.querySelector(".styx-pk-create-err");
    const submitBtn = modal.querySelector("[data-styx-create-submit]");
    const backBtn = modal.querySelector(".styx-pk-create-back");
    if (input) {
      const doFocus = () => {
        try {
          input.focus();
        } catch (_e) {}
      };
      // Defer focus so the swap animation doesn't eat it.
      setTimeout(doFocus, 0);
      setTimeout(doFocus, 50);
      requestAnimationFrame(doFocus);

      const stopProp = (e) => e.stopPropagation();
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          submitCreate();
        }
      });
      input.addEventListener("keyup", stopProp);
      input.addEventListener("keypress", stopProp);
      input.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        doFocus();
      });
      input.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        doFocus();
      });
      input.addEventListener("click", (e) => {
        e.stopPropagation();
        doFocus();
      });
      input.addEventListener("focus", stopProp);

      input.addEventListener("input", () => {
        input.classList.remove("styx-pk-create-error");
        if (errSlot) errSlot.textContent = "";
      });
    }

    async function submitCreate() {
      if (!input) return;
      const name = (input.value || "").trim();
      if (!name) {
        input.classList.add("styx-pk-create-error");
        if (errSlot) errSlot.textContent = t("observer_create_needName");
        try { input.focus(); } catch (_e) {}
        return;
      }
      submitBtn && submitBtn.setAttribute("disabled", "");
      backBtn && backBtn.setAttribute("disabled", "");

      // Create a new Amazon list seeded with this item (one SW round-trip that
      // drives Amazon). The new list IS the cart — there is no local store.
      if (errSlot) errSlot.textContent = t("observer_create_creating");
      const res = await sendRequest({
        type: "MC_CREATE_AMAZON_LIST_WITH_ITEM",
        name,
        host: createHost,
        asin: item.asin,
        quantity: qty,
      });
      if (!res || !res.ok) {
        if (res && res.limitReached) {
          showPickerUpgradeScreen(root, "limit");
          return;
        }
        if (errSlot) errSlot.textContent = (res && res.error) || t("observer_err_createListFailed");
        submitBtn && submitBtn.removeAttribute("disabled");
        backBtn && backBtn.removeAttribute("disabled");
        return;
      }
      const confirm = document.createElement("div");
      confirm.className = "styx-pk-confirm";
      confirm.textContent = t("observer_addedTo", [name]);
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

  // The picker always offers the user's Amazon lists (the real carts) from the
  // SW snapshot. Empty targets mean the snapshot hasn't warmed yet; the caller
  // fetches it (MC_ENSURE_AMAZON_LISTS) and re-renders.
  function parseCartCount(val) {
    if (val == null || val === "") return null;
    const n = Number(val);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function buildPickerTargets() {
    const lists =
      _amazonListsCache && Array.isArray(_amazonListsCache.lists)
        ? _amazonListsCache.lists
        : [];
    const targets = lists.map((l) => ({
      id: String(l.listId),
      name: l.name || "Amazon list",
      count: parseCartCount(l.count),
      isList: true,
      kind: l.kind || "custom",
      access: l.access || "editable",
    }));
    const editableSet = new Set(
      targets.filter((t) => t.access === "editable").map((t) => t.id)
    );
    return {
      targets,
      editableSet,
      host: (_amazonListsCache && _amazonListsCache.host) || null,
    };
  }

  function renderTargetRows(sortedCarts, ctx) {
    return sortedCarts
      .map((cart) => {
        const count = parseCartCount(cart.count);
        const countText = count !== null
          ? t(count === 1 ? "popup_count_item_one" : "popup_count_item_other", [count])
          : t("observer_genericCart");
        const isEditable = ctx.editableSet.has(cart.id);
        const rowClass = isEditable
          ? "styx-pk-row styx-pk-editable"
          : "styx-pk-row styx-pk-locked";
        const ariaAttr = isEditable
          ? ""
          : `aria-disabled="true" title="${escapeHtml(t("observer_lockedRenewTitle"))}"`;
        const readOnlyPill = isEditable
          ? ""
          : `<span class="styx-pk-row-readonly">${t("observer_readOnly")}</span>`;
        const metaBits = [readOnlyPill, countText].filter(Boolean).join(" · ");
        const countHtml = `<div class="styx-pk-row-count">${metaBits}</div>`;
        return `
          <li>
            <button type="button" class="${rowClass}" data-cart-id="${escapeHtml(cart.id)}" data-cart-name="${escapeHtml(cart.name)}" data-list-id="${escapeHtml(cart.id)}" ${ariaAttr}>
              <div class="styx-pk-row-main">
                <div class="styx-pk-row-name">${escapeHtml(cart.name)}</div>
                ${countHtml}
              </div>
              <div class="styx-pk-row-thumbs"></div>
            </button>
          </li>`;
      })
      .join("");
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

    // Targets are the user's Amazon lists (the real carts). `ctx` is closed
    // over by the click handler below and passed to the create-new screen.
    // On a cold cache (no snapshot yet) targets are empty — show a loading
    // row while the MC_ENSURE_AMAZON_LISTS fetch below fills them in.
    let ctx = buildPickerTargets();
    const sortedCarts = sortCartsForDisplay(ctx.targets, ctx.editableSet);

    const cartsHtml = sortedCarts.length
      ? renderTargetRows(sortedCarts, ctx)
      : `<li class="styx-pk-loading" aria-live="polite">${t("popup_lists_loading")}</li>`;

    const thumbHtml = isUsablePickerThumb(item.image)
      ? `<img class="styx-pk-thumb" src="${escapeHtml(item.image)}" alt="" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'" />`
      : `<div class="styx-pk-thumb"></div>`;

    root.innerHTML = `
      <div class="styx-pk-backdrop" data-styx-action="cancel"></div>
      <div class="styx-pk-modal" role="document">
        <button type="button" class="styx-pk-close" data-styx-action="cancel" aria-label="${escapeHtml(t("observer_close"))}">×</button>
        <div class="styx-pk-brand">
          <svg class="styx-pk-brand-logo" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#131a22"/><g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M12 8.6 L19 8.6 L18.3 11.8 L12.7 11.8 Z"/><path d="M12 8.6 L10.5 7.3"/></g><circle cx="13.7" cy="13.3" r="0.9" fill="#ff9900"/><circle cx="17.3" cy="13.3" r="0.9" fill="#ff9900"/><g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M4 14.4 L11 14.4 L10.3 17.6 L4.7 17.6 Z"/><path d="M4 14.4 L2.5 13.1"/></g><circle cx="5.9" cy="19.1" r="0.9" fill="#ff9900"/><circle cx="9.1" cy="19.1" r="0.9" fill="#ff9900"/><g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M21 14.4 L28 14.4 L27.3 17.6 L21.7 17.6 Z"/><path d="M21 14.4 L19.5 13.1"/></g><circle cx="22.9" cy="19.1" r="0.9" fill="#ff9900"/><circle cx="26.1" cy="19.1" r="0.9" fill="#ff9900"/><path d="M0 19.8 Q 4 18.4, 8 19.8 T 16 19.8 T 24 19.8 T 32 19.8 L 32 32 L 0 32 Z" fill="#1a3a5c" opacity="0.55"/><path d="M0 19.8 Q 4 18.4, 8 19.8 T 16 19.8 T 24 19.8 T 32 19.8" stroke="#5db5ff" stroke-width="1" fill="none" stroke-linecap="round"/></svg>
          <span class="styx-pk-brand-name">Styx Multi-Cart</span>
        </div>
        <div class="styx-pk-header">
          ${thumbHtml}
          <div class="styx-pk-meta">
            <div class="styx-pk-title" title="${escapeHtml(item.title || t("popup_untitled"))}" aria-label="${escapeHtml(item.title || t("popup_untitled"))}">${escapeHtml(item.title || t("popup_untitled"))}</div>
            <div class="styx-pk-sub">${priceBit}${escapeHtml(t("observer_qtyLabel"))} <b>${qty}</b></div>
          </div>
        </div>
        <div class="styx-pk-prompt">${t("observer_addToWhichCart")}</div>
        <ul class="styx-pk-list">${cartsHtml}</ul>
        <button type="button" class="styx-pk-create-row" data-styx-action="create-new">${t("observer_createNewCartRow")}</button>
        <div class="styx-pk-footer">
          <button type="button" class="styx-pk-escape" data-styx-action="escape">${t("observer_addToAmazonCart")}</button>
        </div>
      </div>
    `;

    document.body.appendChild(root);
    document.addEventListener("keydown", onPickerKeydown, true);
    // Disable any Amazon overlay we opened over (e.g. its "choose a size"
    // modal) so its focus-trap can't steal the create-cart field's focus.
    neutralizeCompetingOverlays();

    // Refresh the Amazon-list snapshot in the background: fills the list in if
    // the cache was cold, and keeps counts current. Only re-renders while the
    // main list screen is showing (not a swapped-in create/upgrade screen).
    sendRequest({ type: "MC_ENSURE_AMAZON_LISTS", maxAgeMs: 120000 }).then((res) => {
      if (document.getElementById(PICKER_ID) !== root) return;
      if (res && res.ok && Array.isArray(res.lists)) {
        _amazonListsCache = {
          fetchedAt: res.fetchedAt || Date.now(),
          host: res.host || null,
          lists: res.lists,
        };
      }
      const modal = root.querySelector(".styx-pk-modal");
      if (modal && modal.dataset.styxOriginalHtml) return; // on a sub-screen
      const ul = root.querySelector(".styx-pk-list");
      if (!ul) return;
      ctx = buildPickerTargets();
      const sorted = sortCartsForDisplay(ctx.targets, ctx.editableSet);
      ul.innerHTML = sorted.length
        ? renderTargetRows(sorted, ctx)
        : `<li class="styx-pk-empty">${t("observer_noAmazonListsYet")}</li>`;
    });

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
          action.textContent = t("popup_paywall_openingCheckout");
          sendRequest({ type: "MC_OPEN_PAYMENT_PAGE", plan }).then((res) => {
            if (!res || !res.ok) {
              goBtns.forEach((b) => { b.disabled = false; });
              action.textContent = t("observer_tryAgain");
            }
          });
        } else if (action.dataset.styxAction === "create-new") {
          const targets = ctx && ctx.targets ? ctx.targets : [];
          const hasLocked = targets.some((t) => t.access === "locked");
          if (hasLocked) {
            showPickerUpgradeScreen(root, "limit");
            return;
          }
          showPickerCreateScreen(root, item, qty, ctx);
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

      const cartName = row.dataset.cartName || t("popup_genericCart");
      const listId = row.dataset.listId || null;

      // Every row is an Amazon list. The Add-to-List flow is slow (helper tab),
      // so reflect that in the header before the round-trip.
      const sub = root.querySelector(".styx-pk-sub");
      if (sub) {
        sub.textContent = t("observer_addingToCart", [cartName]);
        sub.style.color = "";
      }

      const res = await sendRequest({
        type: "MC_ADD_ITEM_TO_AMAZON_LIST",
        listId,
        host: ctx.host,
        asin: item.asin,
        quantity: qty,
        name: cartName,
      });

      if (!res || !res.ok) {
        // Restore only the rows that were editable before the click — leave
        // read-only rows disabled.
        pickerRows.forEach((r) => {
          if (!preLocked.has(r.dataset.cartId)) r.removeAttribute("disabled");
        });
        const sub = root.querySelector(".styx-pk-sub");
        if (sub) {
          sub.textContent = (res && res.error) || t("observer_err_addItemFailed");
          sub.style.color = "#ff8d80";
        }
        return;
      }

      const modal = root.querySelector(".styx-pk-modal");
      const confirm = document.createElement("div");
      confirm.className = "styx-pk-confirm";
      confirm.textContent = t(
        res.action === "bumped" ? "observer_qtyBumpedIn" : "observer_addedTo",
        [cartName]
      );
      modal.appendChild(confirm);
      setTimeout(dismissPicker, 1200);
    });
  }

  // ---- Amazon wishlist "Send All to Amazon Cart" -------------------------

  const STYX_WL_BTN_ID = "styx-wishlist-add-all";
  const STYX_WL_LABEL = t("observer_sendAllToAmazonCart");

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
        setWishlistBtnLabel(btn, t("observer_noItemsFound"));
        setTimeout(() => setWishlistBtnLabel(btn, STYX_WL_LABEL), 2000);
        return;
      }

      btn.dataset.busy = "1";
      btn.classList.add("a-button-disabled");
      setWishlistBtnLabel(btn, t("observer_addingN", [items.length]));

      const res = await sendRequest({
        type: "MC_WISHLIST_ADD_ALL",
        items,
        host: location.hostname,
        listId: wlListId,
      });

      if (!res || !res.ok) {
        setWishlistBtnLabel(btn, (res && res.error) || t("observer_tryAgain"));
        btn.dataset.busy = "";
        btn.classList.remove("a-button-disabled");
        setTimeout(() => setWishlistBtnLabel(btn, STYX_WL_LABEL), 2500);
        return;
      }

      // Background drives the confirm flow in a helper tab (often THIS tab,
      // which then navigates away). Reset the button in case it survives.
      setWishlistBtnLabel(btn, t("observer_sendingNToCart", [items.length]));
      setTimeout(() => {
        btn.dataset.busy = "";
        btn.classList.remove("a-button-disabled");
        setWishlistBtnLabel(btn, STYX_WL_LABEL);
      }, 5000);
    });

    // Docked copy in the lower-right that appears once this button scrolls off.
    setupWishlistSticky();

    dlog("[Styx ATC] wishlist Send-All button injected");
    return true;
  }

  // ---- Docked "Send All" copy (rides beside the floating FAB) -------------
  //
  // The in-title "Send All to Amazon Cart" button scrolls away on long lists.
  // We mirror it as a fixed pill docked to the LEFT of the floating Styx FAB
  // (lower-right), shown only while the real button is off-screen AND the FAB
  // is visible — so the pair travels together and the pill vanishes when the
  // modal opens over that corner. Clicks forward to the real button so all the
  // send/lock/busy logic lives in exactly one place.
  const STYX_WL_STICKY_ID = "styx-wishlist-sticky";
  const STYX_WL_STICKY_STYLE_ID = "styx-wishlist-sticky-style";
  let _wlOrigOffscreen = false;
  let _wlStickyIO = null;      // IntersectionObserver on the real button
  let _wlStickyStateMO = null; // mirrors the real button's label + lock/busy

  function injectWishlistStickyStyles() {
    if (document.getElementById(STYX_WL_STICKY_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYX_WL_STICKY_STYLE_ID;
    // Geometry mirrors the FAB (injectFloatingStyles): FAB is 56px square at
    // right/bottom 20px, z-index 2147483640. Pill docks 12px to its left and
    // shares its bottom + z-index. Kept as literals to avoid a TDZ on the
    // FAB_* consts, which are declared later in this file.
    style.textContent = `
      #${STYX_WL_STICKY_ID}.styx-brand-btn {
        position: fixed; right: 88px; bottom: 20px;
        height: 56px; padding: 0 20px; gap: 8px;
        border-radius: 28px; font-size: 14px; line-height: 1;
        z-index: 2147483640;
        box-shadow: 0 6px 20px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.06);
        animation: styx-wl-sticky-in .18s ease-out;
      }
      /* Id+attr specificity beats .styx-brand-btn's display:inline-flex, which
         would otherwise defeat the plain [hidden] attribute. */
      #${STYX_WL_STICKY_ID}.styx-brand-btn[hidden] { display: none; }
      #${STYX_WL_STICKY_ID} .styx-btn-mark { width: 18px; height: 18px; }
      #${STYX_WL_STICKY_ID} .a-button-text {
        font-size: 14px !important; line-height: 1 !important;
      }
      @keyframes styx-wl-sticky-in {
        from { opacity: 0; transform: translateY(6px); }
        to   { opacity: 1; transform: none; }
      }
      @media (prefers-reduced-motion: reduce) {
        #${STYX_WL_STICKY_ID}.styx-brand-btn { animation: none; }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureWishlistStickyButton() {
    const existing = document.getElementById(STYX_WL_STICKY_ID);
    if (existing) return existing;
    if (!document.body) return null;

    injectStyxBrandButtonStyles();
    injectWishlistStickyStyles();

    const btn = document.createElement("span");
    btn.id = STYX_WL_STICKY_ID;
    btn.className = "styx-brand-btn";
    btn.setAttribute("role", "button");
    btn.tabIndex = 0;
    btn.hidden = true; // updateWishlistStickyVisibility reveals it
    btn.innerHTML =
      STYX_MARK_SVG("styx-btn-mark") +
      '<span class="a-button-text">' + STYX_WL_LABEL + "</span>";

    // Forward activation to the real button — one source of truth for the
    // scrape/lock/busy/send flow. Guard against a stray self-reference.
    const forward = () => {
      const real = document.getElementById(STYX_WL_BTN_ID);
      if (real && real !== btn) real.click();
    };
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      forward();
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        forward();
      }
    });

    document.body.appendChild(btn);
    return btn;
  }

  // Copy the real button's visible label and lock/busy classes onto the pill
  // so state (e.g. "Adding 7…", locked gray) stays identical.
  function syncWishlistStickyFromReal() {
    const real = document.getElementById(STYX_WL_BTN_ID);
    const btn = document.getElementById(STYX_WL_STICKY_ID);
    if (!real || !btn) return;
    const realLabel = real.querySelector(".a-button-text");
    const btnLabel = btn.querySelector(".a-button-text");
    if (realLabel && btnLabel) btnLabel.textContent = realLabel.textContent;
    btn.classList.toggle("styx-locked", real.classList.contains("styx-locked"));
    btn.classList.toggle("a-button-disabled", real.classList.contains("a-button-disabled"));
  }

  // Visible only when the real button is scrolled off AND the FAB is showing
  // (i.e. the modal isn't open over the corner). FAB id must match FAB_ID.
  function updateWishlistStickyVisibility() {
    const btn = document.getElementById(STYX_WL_STICKY_ID);
    if (!btn) return;
    const real = document.getElementById(STYX_WL_BTN_ID);
    if (!real) { btn.hidden = true; return; }
    const fab = document.getElementById("__styx-fab");
    const fabVisible = !!fab && !fab.hidden;
    btn.hidden = !(_wlOrigOffscreen && fabVisible);
  }

  function setupWishlistSticky() {
    const btn = ensureWishlistStickyButton();
    if (!btn) return;
    const real = document.getElementById(STYX_WL_BTN_ID);
    if (!real) return;

    if (_wlStickyStateMO) _wlStickyStateMO.disconnect();
    _wlStickyStateMO = new MutationObserver(syncWishlistStickyFromReal);
    _wlStickyStateMO.observe(real, {
      attributes: true,
      attributeFilter: ["class"],
      childList: true,
      subtree: true,
      characterData: true,
    });
    syncWishlistStickyFromReal();

    if (_wlStickyIO) _wlStickyIO.disconnect();
    _wlStickyIO = new IntersectionObserver(
      (entries) => {
        for (const en of entries) _wlOrigOffscreen = !en.isIntersecting;
        updateWishlistStickyVisibility();
      },
      { threshold: 0 }
    );
    _wlStickyIO.observe(real);

    // The FAB is injected later (initFloatingUi) and toggles its own hidden
    // state when the modal opens/closes; it fires "styx:fabvis" so we can ride
    // along without reaching into that scope.
    window.removeEventListener("styx:fabvis", updateWishlistStickyVisibility);
    window.addEventListener("styx:fabvis", updateWishlistStickyVisibility);
    updateWishlistStickyVisibility();
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

  // Amazon renders its OWN native UI text in whatever language IT decided to
  // serve that page in — a signal independent of chrome.i18n's message catalog
  // (which follows Chrome's UI language). The relabel functions below search
  // for exact matches of Amazon's own copy, so the search targets must track
  // Amazon's real per-locale strings, not our translation of them.
  //
  // KNOWN LIMITATION / TODO before relying on this for real users: these
  // phrases are our best good-faith knowledge of Amazon's UI text per
  // marketplace, NOT verified against a live page load in this session. A
  // wrong guess here soft-fails (the relabel silently doesn't apply — no
  // crash, no visible bug) rather than breaking anything, but it does mean
  // the "Lists → Carts" rebrand may not fire on non-English Amazon sites
  // until someone visits amazon.de / .fr / .it / .es / .co.jp / .com.mx /
  // .com.br once each and confirms (or corrects) the strings below.
  const AMAZON_NATIVE_PHRASES = {
    en: {
      addToCart: "add to cart",
      addToList: "Add to List",
      viewYourList: "View Your List",
      yourLists: "Your Lists",
      createListOrRegistry: "Create a new list or registry",
    },
    de: {
      addToCart: "in den einkaufswagen",
      addToList: "Zur Liste hinzufügen",
      viewYourList: "Liste anzeigen",
      yourLists: "Meine Listen",
      createListOrRegistry: "Neue Liste oder Geschenkeliste erstellen",
    },
    fr: {
      addToCart: "ajouter au panier",
      addToList: "Ajouter à une liste",
      viewYourList: "Afficher votre liste",
      yourLists: "Vos listes",
      createListOrRegistry: "Créer une nouvelle liste ou liste de cadeaux",
    },
    it: {
      addToCart: "aggiungi al carrello",
      addToList: "Aggiungi alla lista",
      viewYourList: "Visualizza la tua lista",
      yourLists: "Le tue liste",
      createListOrRegistry: "Crea una nuova lista o wish list",
    },
    es: {
      addToCart: "añadir a la cesta",
      addToList: "Añadir a una lista",
      viewYourList: "Ver tu lista",
      yourLists: "Tus listas",
      createListOrRegistry: "Crear una lista o lista de regalos nueva",
    },
    ja: {
      addToCart: "カートに入れる",
      addToList: "リストに追加",
      viewYourList: "リストを表示",
      yourLists: "あなたのリスト",
      createListOrRegistry: "新しいリストまたは登録リストを作成",
    },
    "es-419": {
      addToCart: "agregar al carrito",
      addToList: "Añadir a una lista",
      viewYourList: "Ver tu lista",
      yourLists: "Tus listas",
      createListOrRegistry: "Crear una lista o lista de regalos nueva",
    },
    "pt-br": {
      addToCart: "adicionar ao carrinho",
      addToList: "Adicionar à lista",
      viewYourList: "Ver sua lista",
      yourLists: "Suas listas",
      createListOrRegistry: "Criar uma nova lista ou lista de presentes",
    },
    pt: {
      addToCart: "adicionar ao carrinho",
      addToList: "Adicionar à lista",
      viewYourList: "Ver sua lista",
      yourLists: "Suas listas",
      createListOrRegistry: "Criar uma nova lista ou lista de presentes",
    },
  };

  // document.documentElement.lang reflects the PAGE's own rendered language
  // (set by Amazon), which is what we need here — independent of Chrome's UI
  // language (chrome.i18n.getMessage's driving signal). Falls back to "en".
  // Amazon.com.mx/most Latin American storefronts typically render "es-MX" or
  // similar; the short-code "es" fallback below lands on Spain Spanish, which
  // is close enough for these near-identical phrases — the es-419 table entry
  // above is used only if Amazon happens to set lang="es-419" exactly.
  function amazonNativePhrases() {
    const raw = (document.documentElement.lang || "en").toLowerCase();
    const short = raw.split("-")[0];
    return (
      AMAZON_NATIVE_PHRASES[raw] ||
      AMAZON_NATIVE_PHRASES[short] ||
      AMAZON_NATIVE_PHRASES.en
    );
  }

  // Append " Cart" to every list name that doesn't already contain "cart".
  // Non-destructive: the original name stays readable, so even Amazon's
  // defaults keep their identity ("Wish List" → "Wish List Cart", "Mila Wish
  // List" → "Mila Wish List Cart"). Names already carrying "cart" ("Cart Jul
  // 11") are left untouched, which also makes this idempotent.
  function rebrandListName(name) {
    const trimmed = (name || "").trim();
    if (!trimmed) return null;
    const cartWord = t("observer_cartWord");
    // Idempotency check must match the translated suffix we append below, not
    // the English word "cart" — otherwise re-running this in a non-English
    // locale would keep re-appending the suffix every pass.
    const already = new RegExp(cartWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (already.test(trimmed)) return null; // already rebranded
    return trimmed + " " + cartWord;
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
    const native = amazonNativePhrases();
    // 1. Page heading: the active "Your Lists" tab.
    document
      .querySelectorAll(".a-tab-heading a, .a-tab-heading span")
      .forEach((el) => {
        if ((el.textContent || "").trim() === native.yourLists) {
          relabelNode(el, () => t("observer_yourStyxCarts"));
        }
      });

    // 2. Sidebar list names (index + detail pages).
    document
      .querySelectorAll('[id^="wl-list-entry-title-"]')
      .forEach((el) => relabelNode(el, rebrandListName));

    // 3. The open list's detail heading.
    const detail = document.getElementById("profile-list-name");
    if (detail) relabelNode(detail, rebrandListName);

    // 4. Each list item's NATIVE "Add to Cart" button → "Add to Amazon Cart".
    // Amazon fires this via data-action="cta-add-to-cart" (not the label text),
    // so renaming the visible <a> is display-only. Reverts with the rest when
    // the rebrand toggle is turned off. The control swaps to a quantity stepper
    // once added, so the debounced observer re-runs this when it swaps back.
    document
      .querySelectorAll(
        "#g-items li[data-itemid] [data-action='cta-add-to-cart'] a.a-button-text, " +
          "#g-items li[data-itemid] [id^='pab-declarative-'] a.a-button-text"
      )
      .forEach((el) =>
        relabelNode(el, (orig) =>
          orig.toLowerCase() === native.addToCart ? t("observer_addToAmazonCartCaps") : orig
        )
      );
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
    const native = amazonNativePhrases();
    document.querySelectorAll(".a-popover-modal, .a-popover").forEach((pop) => {
      if (!pop.offsetWidth && !pop.offsetHeight) return; // hidden template
      const isAtl =
        pop.querySelector('[id^="atwl-"], [class*="atwl"]') ||
        new RegExp(
          "\\b(" + native.addToList + "|" + t("observer_addToStyxCart") + ")\\b"
        ).test(pop.textContent || "");
      if (!isAtl) return;

      // Fixed phrases first so the list-name pass below skips these nodes.
      relabelLeafPhrase(pop, native.addToList, t("observer_addToStyxCart"));
      relabelLeafPhrase(pop, native.viewYourList, t("observer_viewYourStyxCart"));

      // Confirmation header: Amazon renders "N item(s) added to" and the list
      // name as SIBLING spans (class huc-atwl-header-main), not nested. Rebrand
      // the name span — every header span that isn't the count/"added to"
      // prefix. Also covers the name being a link, in case the markup shifts.
      // NOTE: this prefix regex is English-only — on a non-English Amazon page
      // it simply won't match, so the list-name rebrand below is skipped there
      // (safe no-op) until this is extended with a verified per-locale pattern.
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
    const native = amazonNativePhrases();
    document
      .querySelectorAll(".a-popover-modal, .a-popover, [role='dialog'], .a-modal")
      .forEach((pop) => {
        if (!pop.offsetWidth && !pop.offsetHeight) return; // hidden template
        const createRe = new RegExp(
          native.createListOrRegistry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "i"
        );
        if (!createRe.test(pop.textContent || "")) return;
        relabelLeafPhrase(
          pop,
          native.createListOrRegistry,
          t("observer_createStyxCartTitle")
        );
        // "List name" / "List name (required)" → "Styx Cart name …". English-
        // only prefix match for now — see AMAZON_NATIVE_PHRASES note above.
        relabelLeafPrefix(pop, /^List name/i, t("observer_styxCartNamePrefix"));
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

  // ---- Cart page: "Save cart to a new Styx Cart" → new Amazon wish list --------
  //
  // On the Amazon Shopping Cart page, drop a button in the buybox that saves
  // everything currently in the cart into a brand-new Amazon wish list. The
  // background (MC_SAVE_LIVE_CART_TO_LIST) scrapes the cart (reusing THIS tab),
  // creates the list, and adds the items via the same driver the popup uses
  // for saved carts. Nothing is stored as a Styx saved cart — it goes straight
  // to Amazon. The button names the list and shows status.

  const STYX_SAVE_CART_BTN_ID = "styx-save-cart";
  const STYX_SAVE_CART_LABEL = t("popup_saveForLater_button");
  const STYX_SAVE_CART_STYLE_ID = "styx-save-cart-style";
  const STYX_CLEAR_CART_BTN_ID = "styx-clear-cart";
  const STYX_CLEAR_CART_LABEL = t("popup_clear_button");
  const STYX_CLEAR_CART_CONFIRM_ID = "styx-clear-cart-confirm";
  const STYX_SAVE_CART_PROMPT_ID = "styx-save-cart-prompt";

  // ---- Shared Styx button branding ---------------------------------------
  // One visual language for every Styx-owned action button (cart page + PDP):
  // dark navy fill (matches the toolbar-icon tile), white bold label, and the
  // orange Styx cart mark. Kept in sync so the two buttons read as one system.
  const STYX_BTN_BG = "linear-gradient(180deg,#1f2d3d,#131a22)";
  const STYX_BTN_BORDER = "rgba(255,153,0,.55)";
  const STYX_BTN_RADIUS = "8px";
  const STYX_ORANGE = "#ff9900";
  const STYX_CLEAR_RED = "#e2564a";
  const STYX_CLEAR_BORDER = "#c0463a";

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

  function STYX_CLEAR_CART_MARK_SVG() {
    return (
      '<svg class="styx-btn-mark styx-clear-cart-mark" viewBox="0 0 28 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<g stroke-width="2" transform="rotate(34 10 10)">' +
      '<path d="M2.5 3.5h2.2l2.2 10.1a1.3 1.3 0 0 0 1.28 1.05h7.8a1.3 1.3 0 0 0 1.27-1.02L20.2 7.5H6" />' +
      '<circle cx="9" cy="18" r="1.35" /><circle cx="17" cy="18" r="1.35" />' +
      '</g>' +
      '<rect x="21.5" y="6" width="4.5" height="4.5" fill="none" fill-opacity="0" stroke="currentColor" stroke-width="1.6" transform="rotate(-24 23.75 8.25)" />' +
      '<rect x="22.5" y="11.5" width="4.5" height="4.5" fill="none" fill-opacity="0" stroke="currentColor" stroke-width="1.6" transform="rotate(14 24.75 13.75)" />' +
      '<rect x="21.5" y="17" width="4.5" height="4.5" fill="none" fill-opacity="0" stroke="currentColor" stroke-width="1.6" transform="rotate(32 23.75 19.25)" />' +
      '</svg>'
    );
  }

  function STYX_SAVE_CART_MARK_SVG() {
    return (
      '<svg class="styx-btn-mark styx-save-cart-mark" viewBox="0 0 28 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M3.4 4.8h5.2l2.15 10h9.45l3.15-7.3" stroke-width="2" />' +
      '<path d="M10.8 14.8h9.4" stroke-width="2" />' +
      '<path d="M15.9 3.4v7.2" stroke-width="2" />' +
      '<path d="m12.9 8.45 3 3 3-3" stroke-width="2" />' +
      '<circle cx="11.5" cy="17.5" r="2.05" fill="currentColor" stroke="none" />' +
      '<circle cx="20.2" cy="17.5" r="2.05" fill="currentColor" stroke="none" />' +
      '<circle cx="11.5" cy="17.5" r="0.48" fill="#131a22" stroke="none" />' +
      '<circle cx="20.2" cy="17.5" r="0.48" fill="#131a22" stroke="none" />' +
      '<path d="M6.1 19.8v0.9c0 1 0.8 1.8 1.8 1.8h14.6c1 0 1.8-0.8 1.8-1.8v-0.9" stroke-width="2" />' +
      '</svg>'
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
  // and cart-page "Save to a new Styx Cart" buttons.
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

  // The three Styx carts orbiting a triangle, used as the busy indicator.
  // Mirrors the logo drawn by pageShowStatus in the service worker so the
  // on-page toast and the injected one are the same object to the user.
  function STYX_TOAST_LOGO_SVG() {
    return (
      '<svg width="36" height="36" viewBox="0 0 32 32" aria-hidden="true" style="display:block">' +
        '<rect width="32" height="32" rx="7" fill="var(--styx-bg)"/>' +
        '<g class="styx-cart-a">' +
          '<g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none">' +
            '<path d="M12 8.6 L19 8.6 L18.3 11.8 L12.7 11.8 Z"/><path d="M12 8.6 L10.5 7.3"/>' +
          '</g>' +
          '<circle cx="13.7" cy="13.3" r="0.9" fill="#ff9900"/><circle cx="17.3" cy="13.3" r="0.9" fill="#ff9900"/>' +
        '</g>' +
        '<g class="styx-cart-b">' +
          '<g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none">' +
            '<path d="M4 14.4 L11 14.4 L10.3 17.6 L4.7 17.6 Z"/><path d="M4 14.4 L2.5 13.1"/>' +
          '</g>' +
          '<circle cx="5.9" cy="19.1" r="0.9" fill="#ff9900"/><circle cx="9.1" cy="19.1" r="0.9" fill="#ff9900"/>' +
        '</g>' +
        '<g class="styx-cart-c">' +
          '<g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none">' +
            '<path d="M21 14.4 L28 14.4 L27.3 17.6 L21.7 17.6 Z"/><path d="M21 14.4 L19.5 13.1"/>' +
          '</g>' +
          '<circle cx="22.9" cy="19.1" r="0.9" fill="#ff9900"/><circle cx="26.1" cy="19.1" r="0.9" fill="#ff9900"/>' +
        '</g>' +
        '<path d="M0 19.8 Q 4 18.4, 8 19.8 T 16 19.8 T 24 19.8 T 32 19.8 L 32 32 L 0 32 Z" fill="#1a3a5c" opacity="0.55"/>' +
        '<path d="M0 19.8 Q 4 18.4, 8 19.8 T 16 19.8 T 24 19.8 T 32 19.8" stroke="#5db5ff" stroke-width="1" fill="none" stroke-linecap="round"/>' +
        '<path d="M0 23 Q 4 22, 8 23 T 16 23 T 24 23 T 32 23" stroke="#5db5ff" stroke-width="0.8" fill="none" stroke-linecap="round" opacity="0.55"/>' +
        '<path d="M0 25.9 Q 4 25, 8 25.9 T 16 25.9 T 24 25.9 T 32 25.9" stroke="#5db5ff" stroke-width="0.7" fill="none" stroke-linecap="round" opacity="0.38"/>' +
      '</svg>'
    );
  }

  // Shared toast spec: theme-aware card, accent ring that pulses while work is
  // in flight and holds steady once it resolves. Every accent-coloured surface
  // reads --styx-accent, so a state change is one variable swap.
  function ensureStyxToastStyle() {
    if (document.getElementById("styx-toast-style")) return;
    const style = document.createElement("style");
    style.id = "styx-toast-style";
    style.textContent = `
      #${STYX_TOAST_ID} {
        --styx-accent: ${STYX_ORANGE};
        --styx-glow-dim: rgba(255,153,0,.14);
        --styx-glow-bright: rgba(255,153,0,.5);
        --styx-drop: 0 6px 24px rgba(15,17,21,.18);
        --styx-bg: #ffffff;
        --styx-fg: #131a22;
        position: fixed; top: 72px; left: 50%; z-index: 2147483000;
        display: flex; align-items: center; gap: 14px;
        max-width: 420px; padding: 14px 18px;
        border-radius: 14px; border: 1px solid var(--styx-accent);
        background: var(--styx-bg); color: var(--styx-fg);
        font: 500 14px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
        box-shadow: 0 0 0 1px var(--styx-accent), 0 0 18px var(--styx-glow-dim), var(--styx-drop);
        opacity: 0; transform: translate(-50%, -8px);
        transition: opacity 160ms ease, transform 160ms ease,
          box-shadow 250ms ease, border-color 250ms ease;
      }
      @media (prefers-color-scheme: dark) {
        #${STYX_TOAST_ID} {
          --styx-bg: #131a22; --styx-fg: #ffffff;
          --styx-drop: 0 6px 24px rgba(0,0,0,.45);
          --styx-glow-dim: rgba(255,153,0,.2);
          --styx-glow-bright: rgba(255,153,0,.6);
        }
      }
      #${STYX_TOAST_ID}.styx-toast-in { opacity: 1; transform: translate(-50%, 0); }
      #${STYX_TOAST_ID} .styx-toast-icon {
        position: relative; flex: 0 0 auto; width: 36px; height: 36px;
      }
      #${STYX_TOAST_ID} .styx-toast-badge {
        position: absolute; left: 50%; top: 32%; width: 18px; height: 18px;
        transform: translate(-50%, -50%); border-radius: 50%;
        display: none; align-items: center; justify-content: center;
        color: #0b1a14; font-size: 13px; font-weight: 800; line-height: 1;
        background: var(--styx-accent); box-shadow: 0 0 8px var(--styx-glow-bright);
      }
      #${STYX_TOAST_ID}.styx-toast-done .styx-toast-badge,
      #${STYX_TOAST_ID}.styx-toast-error .styx-toast-badge { display: flex; }
      #${STYX_TOAST_ID} .styx-toast-badge .styx-toast-tick { display: none; }
      #${STYX_TOAST_ID}.styx-toast-done .styx-toast-badge .styx-toast-tick { display: block; }
      #${STYX_TOAST_ID} .styx-toast-badge .styx-toast-bang { display: none; }
      #${STYX_TOAST_ID}.styx-toast-error .styx-toast-badge .styx-toast-bang { display: block; color: #fff; }
      #${STYX_TOAST_ID} .styx-toast-body { min-width: 0; }
      #${STYX_TOAST_ID} .styx-toast-title { font-weight: 700; }
      #${STYX_TOAST_ID} .styx-toast-detail { font-size: 13px; opacity: .72; margin-top: 2px; }
      #${STYX_TOAST_ID} .styx-toast-detail:empty { display: none; }
      #${STYX_TOAST_ID}.styx-toast-done {
        --styx-accent: #34d399;
        --styx-glow-dim: rgba(52,211,153,.18);
        --styx-glow-bright: rgba(52,211,153,.5);
      }
      #${STYX_TOAST_ID}.styx-toast-error {
        --styx-accent: #ef4444;
        --styx-glow-dim: rgba(239,68,68,.18);
        --styx-glow-bright: rgba(239,68,68,.5);
      }
      #${STYX_TOAST_ID}.styx-toast-live {
        animation: styx-toast-glow 1.8s ease-in-out infinite;
      }
      .styx-toast-live .styx-cart-a { animation: styx-cart-a 2.4s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
      .styx-toast-live .styx-cart-b { animation: styx-cart-b 2.4s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
      .styx-toast-live .styx-cart-c { animation: styx-cart-c 2.4s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
      @keyframes styx-toast-glow {
        0%, 100% { box-shadow: 0 0 0 1px var(--styx-accent), 0 0 8px var(--styx-glow-dim), var(--styx-drop); }
        50% { box-shadow: 0 0 0 1px var(--styx-accent), 0 0 28px var(--styx-glow-bright), var(--styx-drop); }
      }
      @keyframes styx-cart-a { 0%,100%{transform:translate(0,0)} 33%{transform:translate(9px,5.8px)} 66%{transform:translate(-8px,5.8px)} }
      @keyframes styx-cart-b { 0%,100%{transform:translate(0,0)} 33%{transform:translate(8px,-5.8px)} 66%{transform:translate(17px,0)} }
      @keyframes styx-cart-c { 0%,100%{transform:translate(0,0)} 33%{transform:translate(-17px,0)} 66%{transform:translate(-9px,-5.8px)} }
      @media (prefers-reduced-motion: reduce) {
        #${STYX_TOAST_ID}.styx-toast-live,
        .styx-toast-live .styx-cart-a,
        .styx-toast-live .styx-cart-b,
        .styx-toast-live .styx-cart-c { animation: none; }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function showStyxToast(detail, title) {
    ensureStyxToastStyle();
    if (_styxToastHideTimer) { clearTimeout(_styxToastHideTimer); _styxToastHideTimer = 0; }
    let el = document.getElementById(STYX_TOAST_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = STYX_TOAST_ID;
      el.setAttribute("role", "status");
      el.innerHTML =
        '<div class="styx-toast-icon">' +
        STYX_TOAST_LOGO_SVG() +
        '<div class="styx-toast-badge">' +
        '<svg class="styx-toast-tick" width="12" height="12" viewBox="0 0 21 21" fill="none" aria-hidden="true">' +
        '<path d="M3 10.5L8.5 16L18 5" stroke="#0b1a14" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '<span class="styx-toast-bang">!</span>' +
        '</div></div>' +
        '<div class="styx-toast-body">' +
        '<div class="styx-toast-title">' + escapeHtml(t("observer_buildingAmazonList")) + '</div>' +
        '<div class="styx-toast-detail"></div></div>';
      document.body.appendChild(el);
      requestAnimationFrame(() => el.classList.add("styx-toast-in"));
    }
    el.classList.remove("styx-toast-done", "styx-toast-error");
    el.classList.add("styx-toast-live");
    setStyxToastTitle(title);
    setStyxToastDetail(detail);
    return el;
  }

  function setStyxToastDetail(detail) {
    const el = document.getElementById(STYX_TOAST_ID);
    if (!el) return;
    const d = el.querySelector(".styx-toast-detail");
    if (d) d.textContent = detail || "";
  }

  function setStyxToastTitle(title) {
    const el = document.getElementById(STYX_TOAST_ID);
    if (!el || !title) return;
    const t = el.querySelector(".styx-toast-title");
    if (t) t.textContent = title;
  }

  function finishStyxToast(kind, title, detail, hideAfter) {
    const el = showStyxToast(detail);
    // Terminal state — stop the pulse and hold a steady ring in the state colour.
    el.classList.remove("styx-toast-live");
    el.classList.add(kind === "error" ? "styx-toast-error" : "styx-toast-done");
    setStyxToastTitle(title);
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
  //
  // PROGRESS keeps the spinner up; DONE is the terminal state. A save driven
  // from the panel (rather than from this page's own button) has no local code
  // awaiting a response, so without a DONE message the toast would spin
  // forever even after the save succeeded.
  try {
    chrome.runtime.onMessage.addListener((m) => {
      if (!m) return;
      if (m.type === "MC_LIST_SAVE_PROGRESS") {
        showStyxToast(m.detail || t("observer_working"), m.title);
      } else if (m.type === "MC_LIST_SAVE_DONE") {
        finishStyxToast(
          m.ok ? "done" : "error",
          m.title || (m.ok ? t("observer_cartSaved") : t("popup_err_saveToAmazonFailed")),
          m.detail || "",
          m.hideAfter
        );
      }
    });
  } catch (_e) { /* no runtime — ignore */ }

  function isCartPage() {
    const p = location.pathname;
    // Desktop cart (/gp/cart/view.html) and the short /cart route. Exclude the
    // /gp/cart/aws upsell interstitial (handled as an upsell surface).
    if (/\/gp\/cart\/view\.html/i.test(p)) return true;
    // The short route redirects through ref-tagged variants that put the ref
    // IN the path, not the query string — e.g. /cart/ref=ord_cart_shr (the
    // "?" only starts after that segment) — so match any /cart or /cart/...
    // path, not just an exact /cart or /cart/.
    if (/^\/cart(\/|$)/i.test(p)) return true;
    return false;
  }

  function setSaveCartLabel(btn, text) {
    const label = btn.querySelector(".styx-save-cart-label");
    if (label) label.textContent = text;
  }

  function setClearCartLabel(btn, text) {
    const label = btn.querySelector(".styx-clear-cart-label");
    if (label) label.textContent = text;
  }

  function dismissCartClearConfirm() {
    const dialog = document.getElementById(STYX_CLEAR_CART_CONFIRM_ID);
    if (dialog) dialog.remove();
  }

  function dismissSaveCartPrompt() {
    const dialog = document.getElementById(STYX_SAVE_CART_PROMPT_ID);
    if (dialog) dialog.remove();
  }

  function promptSaveCartName(defaultName) {
    dismissSaveCartPrompt();
    return new Promise((resolve) => {
      const dialog = document.createElement("div");
      dialog.id = STYX_SAVE_CART_PROMPT_ID;
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", "styx-save-cart-prompt-title");
      dialog.innerHTML = `
        <div class="styx-save-cart-prompt-card">
          <p class="styx-save-cart-prompt-kicker">Styx Multi-Cart</p>
          <form class="styx-save-cart-prompt-form" autocomplete="off">
            <label id="styx-save-cart-prompt-title" class="styx-save-cart-prompt-title" for="styx-save-cart-prompt-input">${t("observer_nameYourNewList")}</label>
            <input id="styx-save-cart-prompt-input" class="styx-save-cart-prompt-input" type="text" maxlength="60" autocomplete="off" />
            <p class="styx-save-cart-prompt-help">${t("observer_saveCartHelp")}</p>
            <div class="styx-save-cart-prompt-actions">
              <button type="button" data-styx-save-prompt-choice="cancel">${t("popup_action_cancel")}</button>
              <button type="submit" data-styx-save-prompt-choice="ok">${t("popup_action_ok")}</button>
            </div>
          </form>
        </div>
      `;
      const input = dialog.querySelector("#styx-save-cart-prompt-input");
      const form = dialog.querySelector(".styx-save-cart-prompt-form");
      const close = (value) => {
        document.removeEventListener("keydown", onKeydown, true);
        dialog.remove();
        resolve(value);
      };
      const onKeydown = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close(null);
        }
      };

      input.value = defaultName;
      document.body.appendChild(dialog);
      input.focus();
      input.select();
      document.addEventListener("keydown", onKeydown, true);

      dialog.addEventListener("click", (e) => {
        if (e.target === dialog) { close(null); return; }
        const choice = e.target.closest("[data-styx-save-prompt-choice]")?.dataset.styxSavePromptChoice;
        if (choice === "cancel") close(null);
      });
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        close(input.value);
      });
    });
  }

  function showCartClearConfirm(btn) {
    if (document.getElementById(STYX_CLEAR_CART_CONFIRM_ID)) return;
    const dialog = document.createElement("div");
    dialog.id = STYX_CLEAR_CART_CONFIRM_ID;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "styx-clear-cart-confirm-title");
    dialog.innerHTML = `
      <div class="styx-clear-cart-confirm-card">
        <p class="styx-clear-cart-confirm-kicker">Styx Multi-Cart</p>
        <h2 id="styx-clear-cart-confirm-title">${t("popup_confirm_clear_title")}</h2>
        <p>${t("observer_clearCartConfirmBody")}</p>
        <div class="styx-clear-cart-confirm-actions">
          <button type="button" data-styx-clear-choice="clear">${t("popup_confirm_clear_okLabel")}</button>
          <button type="button" data-styx-clear-choice="save">${t("popup_confirm_clear_altLabel")}</button>
          <button type="button" data-styx-clear-choice="cancel">${t("popup_action_cancel")}</button>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);
    const close = () => dismissCartClearConfirm();
    dialog.addEventListener("click", async (e) => {
      if (e.target === dialog) { close(); return; }
      const choice = e.target.closest("[data-styx-clear-choice]")?.dataset.styxClearChoice;
      if (!choice) return;
      if (choice === "cancel") { close(); return; }

      const actionButton = e.target;
      actionButton.disabled = true;
      dialog.querySelectorAll("button").forEach((el) => { el.disabled = true; });
      btn.disabled = true;
      setClearCartLabel(btn, choice === "save" ? t("observer_savingAndClearing") : t("observer_clearingCart"));
      close();
      showStyxToast(
        choice === "save" ? t("observer_savingThenClearing") : t("observer_clearingAmazonCart"),
        choice === "save" ? t("observer_savingYourCart") : t("observer_clearingYourCart")
      );

      const res = await sendRequest({
        type: choice === "save" ? "MC_SAVE_AND_CLEAR" : "MC_CLEAR_CURRENT",
        ...(choice === "save" ? { name: `${t("observer_cartWord")} ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })}` } : {})
      });
      if (res && res.ok) {
        finishStyxToast(
          "done",
          choice === "save" ? t("observer_cartSavedAndCleared") : t("observer_cartClearingStarted"),
          res.alreadyEmpty ? t("popup_toast_cartAlreadyEmpty") : t("observer_checkAmazonTab"),
          5000
        );
      } else {
        finishStyxToast("error", t("observer_couldntClearCart"), (res && res.error) || t("observer_pleaseTryAgain"), 6000);
        btn.disabled = false;
        setClearCartLabel(btn, STYX_CLEAR_CART_LABEL);
      }
    });
  }

  function injectClearCartButton() {
    if (document.getElementById(STYX_CLEAR_CART_BTN_ID)) return true;
    const saveBtn = document.getElementById(STYX_SAVE_CART_BTN_ID);
    if (!saveBtn || !saveBtn.parentNode) return false;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = STYX_CLEAR_CART_BTN_ID;
    btn.title = t("popup_clear_button_title");
    btn.innerHTML =
      STYX_CLEAR_CART_MARK_SVG() +
      '<span class="styx-clear-cart-label">' + STYX_CLEAR_CART_LABEL + "</span>";
    saveBtn.parentNode.insertBefore(btn, saveBtn);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!btn.disabled) showCartClearConfirm(btn);
    });
    return true;
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
        #${STYX_SAVE_CART_BTN_ID} .styx-btn-mark,
        #${STYX_CLEAR_CART_BTN_ID} .styx-btn-mark {
          width: 22px; height: 22px; flex: 0 0 auto; display: block;
          color: ${STYX_ORANGE};
        }
        #${STYX_CLEAR_CART_BTN_ID} .styx-btn-mark { color: ${STYX_CLEAR_RED}; }
        #${STYX_CLEAR_CART_BTN_ID} {
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
        #${STYX_CLEAR_CART_BTN_ID}:hover { filter: brightness(1.12); }
        #${STYX_CLEAR_CART_BTN_ID}:disabled { opacity: 0.6; cursor: default; }
        #${STYX_CLEAR_CART_BTN_ID} { border-color: ${STYX_CLEAR_BORDER}; }
        #${STYX_CLEAR_CART_CONFIRM_ID} {
          position: fixed; inset: 0; z-index: 2147483646;
          display: flex; align-items: center; justify-content: center;
          padding: 20px; background: rgba(15, 23, 42, .46);
          font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
        }
        #${STYX_CLEAR_CART_CONFIRM_ID} .styx-clear-cart-confirm-card {
          width: min(380px, 100%); box-sizing: border-box; padding: 20px;
          border: 1px solid rgba(255,153,0,.55); border-radius: 12px;
          background: #ffffff; color: #131a22;
          box-shadow: 0 18px 50px rgba(0,0,0,.35);
        }
        #${STYX_CLEAR_CART_CONFIRM_ID} .styx-clear-cart-confirm-kicker {
          margin: 0 0 6px; color: #b06700; font-size: 11px;
          font-weight: 800; letter-spacing: .08em; text-transform: uppercase;
        }
        #${STYX_CLEAR_CART_CONFIRM_ID} h2 { margin: 0 0 8px; font-size: 20px; line-height: 1.2; }
        #${STYX_CLEAR_CART_CONFIRM_ID} p:not(.styx-clear-cart-confirm-kicker) {
          margin: 0 0 16px; color: #384250; font-size: 13px; line-height: 1.45;
        }
        #${STYX_CLEAR_CART_CONFIRM_ID} .styx-clear-cart-confirm-actions {
          display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end;
        }
        #${STYX_CLEAR_CART_CONFIRM_ID} button {
          border: 1px solid rgba(19,26,34,.16); border-radius: 8px;
          padding: 8px 12px; font: inherit; font-size: 12px; font-weight: 700;
          color: #27313d; background: #fff; cursor: pointer;
        }
        #${STYX_CLEAR_CART_CONFIRM_ID} button[data-styx-clear-choice="save"] {
          border-color: #e88a00; background: linear-gradient(135deg,#ffc34d,#ff9900); color: #1a1209;
        }
        #${STYX_CLEAR_CART_CONFIRM_ID} button[data-styx-clear-choice="clear"] {
          border-color: #b1271b; color: #fff; background: #b1271b;
        }
        #${STYX_CLEAR_CART_CONFIRM_ID} button[data-styx-clear-choice="clear"]:hover {
          border-color: #9a1f15; background: #9a1f15;
        }
        #${STYX_CLEAR_CART_CONFIRM_ID} button:disabled { opacity: .6; cursor: default; }
        #${STYX_SAVE_CART_PROMPT_ID} {
          position: fixed; inset: 0; z-index: 2147483646;
          display: flex; align-items: center; justify-content: center;
          padding: 20px; background: rgba(15, 23, 42, .46);
          font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
        }
        #${STYX_SAVE_CART_PROMPT_ID} .styx-save-cart-prompt-card {
          width: min(540px, 100%); box-sizing: border-box; padding: 20px;
          border: 1px solid rgba(255,153,0,.55); border-radius: 12px;
          background: #fffaf0; color: #131a22;
          box-shadow: 0 18px 50px rgba(0,0,0,.35);
        }
        #${STYX_SAVE_CART_PROMPT_ID} .styx-save-cart-prompt-kicker {
          margin: 0 0 8px; color: #b06700; font-size: 11px;
          font-weight: 800; letter-spacing: .08em; text-transform: uppercase;
        }
        #${STYX_SAVE_CART_PROMPT_ID} .styx-save-cart-prompt-form { margin: 0; }
        #${STYX_SAVE_CART_PROMPT_ID} .styx-save-cart-prompt-title {
          display: block; margin: 0 0 10px;
          font-size: 17px; line-height: 1.25; font-weight: 800;
          white-space: nowrap;
        }
        #${STYX_SAVE_CART_PROMPT_ID} .styx-save-cart-prompt-input {
          width: 100%; box-sizing: border-box; min-height: 40px; padding: 8px 10px;
          border: 1px solid rgba(19,26,34,.28); border-radius: 8px;
          background: #fff; color: #131a22; font: inherit; font-size: 14px;
          outline: none;
        }
        #${STYX_SAVE_CART_PROMPT_ID} .styx-save-cart-prompt-input:focus {
          border-color: #e88a00; box-shadow: 0 0 0 3px rgba(255,153,0,.22);
        }
        #${STYX_SAVE_CART_PROMPT_ID} .styx-save-cart-prompt-help {
          margin: 8px 0 16px; color: #384250; font-size: 12px; line-height: 1.4;
        }
        #${STYX_SAVE_CART_PROMPT_ID} .styx-save-cart-prompt-actions {
          display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end;
        }
        #${STYX_SAVE_CART_PROMPT_ID} button {
          border: 1px solid rgba(19,26,34,.16); border-radius: 8px;
          padding: 8px 12px; font: inherit; font-size: 12px; font-weight: 700;
          color: #27313d; background: #fff; cursor: pointer;
        }
        #${STYX_SAVE_CART_PROMPT_ID} button[data-styx-save-prompt-choice="ok"] {
          border-color: #e88a00; background: linear-gradient(135deg,#ffc34d,#ff9900); color: #1a1209;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = STYX_SAVE_CART_BTN_ID;
    btn.title = t("observer_saveEverythingTitle");
    btn.innerHTML =
      STYX_SAVE_CART_MARK_SVG() +
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

      const defaultName = `${t("observer_cartWord")} ${new Date().toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })}`;
      const raw = await promptSaveCartName(defaultName);
      if (raw === null) return; // user cancelled
      const name = raw.trim() || defaultName;

      btn.disabled = true;
      setSaveCartLabel(btn, t("observer_savingToAmazon"));
      showStyxToast(
        t("observer_openingAmazonTabs"),
        t("observer_buildingAmazonList")
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
          t("observer_listSaved"),
          res.failed
            ? t("observer_savedPartialOpeningList", [added, res.total, res.failed, name])
            : t("observer_savedOpeningList", [itemCountTextObserver(added), name]),
          8000
        );
      } else {
        finishStyxToast("error", t("popup_err_saveToAmazonFailed"), (res && res.error) || t("observer_pleaseTryAgain"), 6000);
        btn.disabled = false;
        setSaveCartLabel(btn, STYX_SAVE_CART_LABEL);
      }
    });

    dlog("[Styx ATC] Save-this-cart button injected");
    injectClearCartButton();
    return true;
  }

  function initSaveCart() {
    injectSaveCartButton();
    injectClearCartButton();
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
        injectClearCartButton();
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
      // Branded to match the cart-page "Save to a new Styx Cart" button: navy
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
      label.textContent = relabelEnabled()
        ? t("observer_addToAStyxCart")
        : amazonNativePhrases().addToList;
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
    if (label) relabelNode(label, () => t("observer_addDirectlyToAmazonCart"));
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
  // scripts have permission, so no service-worker round-trip is needed to
  // have settings + the Amazon-lists snapshot ready for the first ATC click.
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
  const FAB_GUIDE_ID = "__styx-guide-tip";
  const FAB_LIGHTBOX_ID = "__styx-guide-lightbox";
  const FAB_HINT_ID = "__styx-start-hint";
  const FAB_HINT_KEY = "styx.starthint.v1"; // profile-wide "point at the button" flag
  const FAB_POS_KEY = "styx.fab.pos.v1"; // per-tab dragged position
  const FAB_OPEN_KEY = "styx.fab.open.v1"; // per-tab open/closed memory
  const FAB_GUIDE_KEY = "styx.onboarding.v1"; // profile-wide first-run guide state
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

      /* "Start here..." speech bubble shown after the guide's Finish, tail
         pointing down at the floating button until it is clicked. */
      #${FAB_HINT_ID} {
        position: fixed;
        right: ${FAB_MARGIN + 6}px;
        bottom: ${FAB_MARGIN + 56 + 14}px;
        z-index: 2147483639;
        padding: 9px 16px;
        border-radius: 12px;
        border: 2px solid #ff9900;
        background: #fff;
        color: #131a22;
        font: 700 14px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          "Helvetica Neue", Arial, sans-serif;
        white-space: nowrap;
        box-shadow: 0 6px 18px rgba(0,0,0,0.25);
        pointer-events: none;
      }
      #${FAB_HINT_ID}[hidden] { display: none; }
      #${FAB_HINT_ID}::after {
        content: "";
        position: absolute;
        right: 16px;
        bottom: -9px;
        width: 14px;
        height: 14px;
        transform: rotate(45deg);
        background: #fff;
        border-right: 2px solid #ff9900;
        border-bottom: 2px solid #ff9900;
      }
      @keyframes styx-hint-bob {
        0%, 100% { transform: translateY(0); }
        50%      { transform: translateY(-4px); }
      }
      #${FAB_HINT_ID} { animation: styx-hint-bob 1.6s ease-in-out infinite; }
      @media (prefers-reduced-motion: reduce) {
        #${FAB_HINT_ID} { animation: none; }
      }

      #${FAB_GUIDE_ID} {
        position: fixed;
        right: ${FAB_MARGIN}px;
        bottom: ${FAB_MARGIN + 72}px;
        z-index: 2147483639;
        width: min(430px, calc(100vw - ${FAB_MARGIN * 2}px));
        /* Fixed height on every step: the panel used to grow and shrink as the
           content changed, which reads as the whole dialog jumping between
           steps. The body scrolls internally instead (see .styx-guide-body). */
        height: min(620px, calc(100vh - 112px));
        display: flex;
        flex-direction: column;
        overflow: hidden;
        padding: 16px;
        border-radius: 12px;
        color: #131a22;
        background: #fffaf0;
        border: 1px solid rgba(255,153,0,0.55);
        box-shadow: 0 16px 42px rgba(0,0,0,0.28), 0 0 0 1px rgba(255,255,255,0.9);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          "Helvetica Neue", Arial, sans-serif;
      }
      #${FAB_GUIDE_ID}[hidden] { display: none; }
      #${FAB_GUIDE_ID}::after {
        content: "";
        position: absolute;
        right: 22px;
        bottom: -10px;
        width: 18px;
        height: 18px;
        transform: rotate(45deg);
        background: #fffaf0;
        border-right: 1px solid rgba(255,153,0,0.55);
        border-bottom: 1px solid rgba(255,153,0,0.55);
      }
      #${FAB_GUIDE_ID} .styx-guide-kicker {
        margin: 0 0 6px;
        color: #b06700;
        font-size: 11px;
        font-weight: 800;
        letter-spacing: .08em;
        text-transform: uppercase;
      }
      #${FAB_GUIDE_ID} .styx-guide-title {
        margin: 0 0 8px;
        color: #131a22;
        font-size: 18px;
        line-height: 1.2;
        font-weight: 800;
      }
      #${FAB_GUIDE_ID} .styx-guide-copy {
        margin: 0 0 12px;
        color: #384250;
        font-size: 13px;
        line-height: 1.45;
      }
      #${FAB_GUIDE_ID} .styx-guide-shot {
        display: block;
        width: 100%;
        height: auto;
        margin: 0 0 12px;
        border: 1px solid rgba(19,26,34,0.14);
        border-radius: 8px;
        background: #f5f5f5;
      }
      #${FAB_GUIDE_ID} .styx-guide-progress {
        margin: 0 0 8px;
        color: #69727d;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: .04em;
        text-transform: uppercase;
      }
      #${FAB_GUIDE_ID} .styx-guide-list {
        margin: 0 0 14px;
        padding: 0;
        list-style: none;
        display: grid;
        gap: 6px;
        color: #27313d;
        font-size: 12px;
        line-height: 1.35;
      }
      /* list-style MUST be re-declared on the li, not just the ul: a value
         inherited from the ul loses to any rule that matches the li directly,
         and the host page (amazon.com) styles bare list items. Without this
         the native marker renders next to our ::before dot — double bullets. */
      #${FAB_GUIDE_ID} .styx-guide-list li {
        position: relative;
        padding-left: 18px;
        list-style: none;
      }
      #${FAB_GUIDE_ID} .styx-guide-list li::before {
        content: "";
        position: absolute;
        left: 0;
        top: .45em;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #ff9900;
      }
      /* Nested sub-bullets (e.g. a clarifying aside under a step). Same orange
         as the parent list's dot — just smaller — so the hierarchy reads from
         size/indent alone, with one consistent marker colour throughout. */
      #${FAB_GUIDE_ID} .styx-guide-sublist {
        margin: 4px 0 2px;
        padding: 0;
        list-style: none;
        display: grid;
        gap: 4px;
        color: #5b6572;
      }
      #${FAB_GUIDE_ID} .styx-guide-sublist li {
        position: relative;
        padding-left: 16px;
        list-style: none;
      }
      #${FAB_GUIDE_ID} .styx-guide-sublist li::before {
        content: "";
        position: absolute;
        left: 2px;
        top: .5em;
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: #ff9900;
      }
      /* A button screenshot presented under its bullet's text, rather than
         squeezed inline with it — the crops are wide pills, not icon-sized. */
      #${FAB_GUIDE_ID} .styx-guide-inline-shot {
        display: block;
        width: 200px;
        max-width: 100%;
        height: auto;
        margin: 6px 0 2px;
        border: 1px solid rgba(19,26,34,0.14);
        border-radius: 6px;
      }
      /* Wide crops (e.g. the full panel header) are unreadable at 200px. */
      #${FAB_GUIDE_ID} .styx-guide-inline-shot-wide {
        width: 100%;
      }
      /* Every screenshot in the guide is clickable (see openGuideLightbox). */
      #${FAB_GUIDE_ID} .styx-guide-shot,
      #${FAB_GUIDE_ID} .styx-guide-inline-shot,
      #${FAB_GUIDE_ID} .styx-guide-shot-row img {
        cursor: zoom-in;
      }
      #${FAB_LIGHTBOX_ID} {
        position: fixed;
        inset: 0;
        /* Above the FAB, modal and guide, which all sit at 214748363x. */
        z-index: 2147483646;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 32px;
        background: rgba(15,23,42,0.72);
        cursor: zoom-out;
      }
      #${FAB_LIGHTBOX_ID} img {
        max-width: 100%;
        max-height: 100%;
        width: auto;
        height: auto;
        border-radius: 10px;
        background: #fff;
        box-shadow: 0 24px 60px rgba(0,0,0,0.5);
        cursor: default;
      }
      #${FAB_LIGHTBOX_ID} .styx-guide-lightbox-close {
        position: absolute;
        top: 16px;
        right: 20px;
        width: 34px;
        height: 34px;
        padding: 0;
        border: 1px solid rgba(255,255,255,0.35);
        border-radius: 50%;
        background: rgba(19,26,34,0.75);
        color: #fff;
        font: 600 15px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          Arial, sans-serif;
        cursor: pointer;
      }
      #${FAB_LIGHTBOX_ID} .styx-guide-lightbox-close:hover {
        background: rgba(19,26,34,0.95);
      }
      /* Two related shots side by side. Bounded by height rather than width so
         a tall portrait crop and a wide one line up without either dominating. */
      #${FAB_GUIDE_ID} .styx-guide-shot-row {
        display: flex;
        align-items: flex-start;
        justify-content: center;
        gap: 10px;
        margin: 0 0 12px;
      }
      #${FAB_GUIDE_ID} .styx-guide-shot-row img {
        max-height: 230px;
        max-width: 48%;
        width: auto;
        height: auto;
        border: 1px solid rgba(19,26,34,0.14);
        border-radius: 8px;
        background: #f5f5f5;
      }
      /* Tall portrait crops (the cart-page column) blow the step's vertical
         budget at full width and push the buttons they are meant to show below
         the fold — keep them narrow so the whole shot fits in view. */
      #${FAB_GUIDE_ID} .styx-guide-inline-shot-tall {
        width: 190px;
      }
      /* Everything above the buttons scrolls; the actions stay pinned so Next
         and Back sit in the same spot on every step. */
      #${FAB_GUIDE_ID} .styx-guide-body {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        margin-bottom: 12px;
      }
      /* Standing preamble above the step content: how to reach Styx at all.
         It is a prerequisite for every step, not a step of its own, so it sits
         above the step counter and persists as the user pages through. */
      #${FAB_GUIDE_ID} .styx-guide-intro {
        display: flex;
        align-items: center;
        gap: 9px;
        margin: 0 0 12px;
        padding: 8px 10px;
        border-radius: 8px;
        background: rgba(255,153,0,0.10);
        color: #384250;
        font-size: 12px;
        line-height: 1.35;
      }
      #${FAB_GUIDE_ID} .styx-guide-intro img {
        width: 34px;
        height: 34px;
        flex: 0 0 auto;
        display: block;
      }
      /* Labels the parallel choices in a step ("in the panel" vs "on the cart
         page") so they read as alternatives rather than sequential actions. */
      #${FAB_GUIDE_ID} .styx-guide-option {
        display: block;
        margin-bottom: 3px;
        color: #b06700;
        font-size: 11px;
        font-weight: 800;
        letter-spacing: .04em;
        text-transform: uppercase;
      }
      #${FAB_GUIDE_ID} .styx-guide-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        flex: 0 0 auto;
      }
      #${FAB_GUIDE_ID} .styx-guide-spacer { flex: 1 1 auto; }
      #${FAB_GUIDE_ID} .styx-guide-btn {
        position: relative;
        z-index: 1;
        appearance: none;
        border: 1px solid rgba(19,26,34,0.15);
        border-radius: 8px;
        padding: 8px 12px;
        font: inherit;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
        background: #fff;
        color: #27313d;
      }
      #${FAB_GUIDE_ID} .styx-guide-btn-primary {
        background: linear-gradient(135deg, #ffc34d, #ff9900);
        color: #1a1209;
        border-color: #e88a00;
      }
      #${FAB_GUIDE_ID} .styx-guide-btn:hover {
        filter: brightness(0.98);
      }
      @media (max-width: 420px) {
        #${FAB_GUIDE_ID} {
          right: 12px;
          bottom: 84px;
          width: calc(100vw - 24px);
        }
        #${FAB_GUIDE_ID} .styx-guide-actions { gap: 6px; }
      }

      /* Orange pulse ring around the button as a reminder to use it. Toggled
         by the "Pulse the floating button" setting (on by default). */
      @keyframes styx-fab-pulse {
        0%   { box-shadow: 0 6px 20px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.06), 0 0 0 0 rgba(255,153,0,0.95); }
        70%  { box-shadow: 0 6px 20px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.06), 0 0 0 14px rgba(255,153,0,0); }
        100% { box-shadow: 0 6px 20px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.06), 0 0 0 0 rgba(255,153,0,0); }
      }
      #${FAB_ID}.styx-fab-pulse { animation: styx-fab-pulse 2s ease-out infinite; }
      #${FAB_ID}.styx-fab-pulse:hover { animation-play-state: paused; }
      /* Motion-averse users still get a cue: a steady orange ring, no pulse. */
      @media (prefers-reduced-motion: reduce) {
        #${FAB_ID}.styx-fab-pulse {
          animation: none;
          box-shadow: 0 6px 20px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.06), 0 0 0 4px rgba(255,153,0,0.95);
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

  async function readGuideSeen() {
    try {
      const got = await chrome.storage.local.get(FAB_GUIDE_KEY);
      const state = got && got[FAB_GUIDE_KEY];
      return !!(state && typeof state === "object" && state.seenAt);
    } catch (_e) {
      return true;
    }
  }

  async function markGuideSeen(reason) {
    try {
      await chrome.storage.local.set({
        [FAB_GUIDE_KEY]: {
          seenAt: Date.now(),
          reason: reason || "dismissed"
        }
      });
    } catch (_e) { /* ignore */ }
  }

  // The "Start here..." hint is pending from the guide's Finish until the user
  // first opens Styx (FAB click or toolbar icon). Stored profile-wide so it
  // survives Amazon's full-page navigations.
  async function readStartHintPending() {
    try {
      const got = await chrome.storage.local.get(FAB_HINT_KEY);
      return !!(got && got[FAB_HINT_KEY]);
    } catch (_e) {
      return false;
    }
  }

  async function writeStartHintPending(pending) {
    try {
      if (pending) await chrome.storage.local.set({ [FAB_HINT_KEY]: true });
      else await chrome.storage.local.remove(FAB_HINT_KEY);
    } catch (_e) { /* ignore */ }
  }

  // True while a background-driven multi-navigation operation is running
  // (cart restore sets `restoring`; cart clear / list save set `busy`). Used
  // to hold back the floating window's auto-reopen so it doesn't rebuild and
  // re-hit the lists API on every page load during the operation.
  function uiSuspended() {
    return !!(_settingsCache.restoring || _settingsCache.busy);
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
    fab.setAttribute("aria-label", t("observer_openStyxMultiCart"));
    const icon = document.createElement("img");
    try { icon.src = chrome.runtime.getURL("icons/icon48.png"); } catch (_e) { /* ignore */ }
    icon.alt = "";
    fab.appendChild(icon);

    const modal = document.createElement("div");
    modal.id = FAB_MODAL_ID;
    modal.hidden = true;

    const guide = document.createElement("div");
    guide.id = FAB_GUIDE_ID;
    guide.hidden = true;
    guide.setAttribute("role", "dialog");
    guide.setAttribute("aria-label", t("observer_guide_ariaLabel"));
    const guidePages = [
      {
        title: t("observer_guide1_title"),
        copy: "",
        // No hero image: the first instruction has to be the first thing under
        // the title, so each step carries its own inline screenshot instead.
        image: "",
        alt: "",
        bullets: [
          `<span class="styx-guide-option">${t("observer_guide1_option1")}</span>` +
            t("observer_guide1_bullet1_text", [
              `<strong>${t("popup_clear_button")}</strong>`,
              `<strong>${t("popup_saveForLater_button")}</strong>`,
            ]) +
            `<img class="styx-guide-inline-shot styx-guide-inline-shot-wide" src="guide-assets/guide-clear-save.png" alt="${escapeHtml(t("observer_guide1_shot1_alt"))}">` +
            `<ul class="styx-guide-sublist"><li>${t("observer_guide1_sublist1")}</li></ul>`,
          `<span class="styx-guide-option">${t("observer_guide1_option2")}</span>` +
            t("observer_guide1_bullet2_text", [`<strong>${t("observer_proceedToCheckout")}</strong>`]) +
            `<img class="styx-guide-inline-shot styx-guide-inline-shot-tall" src="guide-assets/CartButtons.png" alt="${escapeHtml(t("observer_guide1_shot2_alt"))}">`
        ]
      },
      {
        title: t("observer_guide2_title"),
        copy: [
          t("observer_guide2_copy1"),
          t("observer_guide2_copy2", [`<strong>${t("observer_addToAStyxCart")}</strong>`]),
          t("observer_guide2_copy3", [`<strong>${t("observer_createNewCartRow")}</strong>`]),
        ],
        image: "",
        alt: "",
        images: [
          { src: "guide-assets/AddtoStyxCart.png", alt: t("observer_guide2_shot1_alt") },
          { src: "guide-assets/CartList.png", alt: t("observer_guide2_shot2_alt") }
        ],
        bullets: [t("observer_guide2_bullet1"), t("observer_guide2_bullet2")]
      },
      {
        title: t("observer_guide3_title"),
        // No hero image — this step is a tour of the three places the action
        // lives, so each surface gets its own inline screenshot inside a bullet.
        copy: t("observer_guide3_copy"),
        image: "",
        alt: "",
        bullets: [
          `<span class="styx-guide-option">${t("observer_guide3_option1")}</span>` +
            t("observer_guide3_bullet1_text") +
            `<img class="styx-guide-inline-shot" src="guide-assets/SendAllToAmazonCart.png" alt="${escapeHtml(t("observer_guide3_shot1_alt"))}">`,
          `<span class="styx-guide-option">${t("observer_guide3_option2")}</span>` +
            t("observer_guide3_bullet2_text") +
            `<img class="styx-guide-inline-shot" src="guide-assets/SendAllDockedPill.png" alt="${escapeHtml(t("observer_guide3_shot2_alt"))}">`,
          `<span class="styx-guide-option">${t("observer_guide3_option3")}</span>` +
            t("observer_guide3_bullet3_text") +
            `<img class="styx-guide-inline-shot styx-guide-inline-shot-wide" src="guide-assets/SendAllPanelButton.png" alt="${escapeHtml(t("observer_guide3_shot3_alt"))}">`,
          t("observer_guide3_bullet4"),
          t("observer_guide3_bullet5", [`<strong>${t("observer_guideFinish")}</strong>`])
        ]
      }
    ];
    let guidePage = 0;
    function guideImageUrl(path) {
      try { return chrome.runtime.getURL(path); } catch (_e) { return path; }
    }
    function renderGuidePage() {
      const page = guidePages[guidePage];
      const isLast = guidePage === guidePages.length - 1;
      // Bullets can carry their own inline screenshots (e.g. the FAB badge, a
      // button crop) as raw <img src="..."> HTML — resolve those relative
      // extension paths the same way the page's main screenshot is resolved,
      // so they load under both chrome-extension:// and Safari's scheme.
      const bulletsHtml = page.bullets
        .map((item) => `<li>${item}</li>`)
        .join("")
        .replace(/src="([^"]+)"/g, (_m, p) => `src="${guideImageUrl(p)}"`);
      // `copy` takes an array when a step reads better as separate lines than
      // one run-on paragraph.
      const copyHtml = []
        .concat(page.copy || [])
        .filter(Boolean)
        .map((line) => `<p class="styx-guide-copy">${line}</p>`)
        .join("");
      // `images` shows two related shots side by side (e.g. the button and the
      // picker it opens) — capped by height so a tall portrait crop can sit
      // next to a wide one without blowing the step's vertical budget.
      const imagesHtml = (page.images || []).length
        ? `<div class="styx-guide-shot-row">` +
          page.images
            .map((im) => `<img src="${guideImageUrl(im.src)}" alt="${im.alt}">`)
            .join("") +
          `</div>`
        : "";
      guide.innerHTML = `
        <div class="styx-guide-body">
          <p class="styx-guide-kicker">${t("observer_guide_kicker")}</p>
          <p class="styx-guide-intro">
            <img src="${guideImageUrl("guide-assets/StyxFabButton.png")}" alt="${escapeHtml(t("observer_guide_fabButtonAlt"))}">
            <span>${t("observer_guide_introText")}</span>
          </p>
          <p class="styx-guide-progress">${t("observer_guide_stepOf", [guidePage + 1, guidePages.length])}</p>
          <h2 class="styx-guide-title">${page.title}</h2>
          ${copyHtml}
          ${page.image ? `<img class="styx-guide-shot" src="${guideImageUrl(page.image)}" alt="${escapeHtml(page.alt)}">` : ""}
          ${imagesHtml}
          <ul class="styx-guide-list">${bulletsHtml}</ul>
        </div>
        <div class="styx-guide-actions">
          ${guidePage > 0 ? `<button class="styx-guide-btn" type="button" data-action="guide-back">${t("observer_back")}</button>` : ""}
          <button class="styx-guide-btn" type="button" data-action="dismiss-guide">${t("observer_notNow")}</button>
          <span class="styx-guide-spacer"></span>
          <button class="styx-guide-btn styx-guide-btn-primary" type="button" data-action="${isLast ? "finish-guide" : "guide-next"}">${isLast ? t("observer_guideFinish") : t("observer_guideNext")}</button>
        </div>
      `;
    }
    renderGuidePage();

    const bar = document.createElement("div");
    bar.className = "styx-fab-bar";
    const title = document.createElement("span");
    title.className = "styx-fab-bar-title";
    title.textContent = "Styx Multi-Cart";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "styx-fab-bar-close";
    closeBtn.setAttribute("aria-label", t("observer_close"));
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
    const hint = document.createElement("div");
    hint.id = FAB_HINT_ID;
    hint.hidden = true;
    hint.setAttribute("role", "status");
    hint.textContent = t("observer_startHere");
    document.body.appendChild(guide);
    document.body.appendChild(hint);
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
    // Let other in-page UI (e.g. the docked wishlist "Send All" pill) react to
    // the FAB showing/hiding without reaching into this scope.
    function notifyFabVis() {
      try { window.dispatchEvent(new Event("styx:fabvis")); } catch (_e) { /* ignore */ }
    }
    function hideGuide() {
      closeGuideLightbox();
      guide.hidden = true;
    }

    // ---- Guide screenshot lightbox ----------------------------------------
    //
    // Built lazily and torn down on close so the guide leaves nothing behind on
    // the host page. Sits above the FAB/modal/guide (all 214748363x) so it is
    // never covered by the very panel it was opened from.
    let _guideLightbox = null;
    function closeGuideLightbox() {
      if (!_guideLightbox) return;
      document.removeEventListener("keydown", onGuideLightboxKey, true);
      try { _guideLightbox.remove(); } catch (_e) { /* already gone */ }
      _guideLightbox = null;
    }
    function onGuideLightboxKey(e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeGuideLightbox();
      }
    }
    function openGuideLightbox(src, alt) {
      closeGuideLightbox();
      const box = document.createElement("div");
      box.id = FAB_LIGHTBOX_ID;
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      box.setAttribute("aria-label", alt || t("observer_screenshot"));
      const img = document.createElement("img");
      img.src = src;
      img.alt = alt || "";
      const close = document.createElement("button");
      close.type = "button";
      close.className = "styx-guide-lightbox-close";
      close.setAttribute("aria-label", t("observer_closeImage"));
      close.textContent = "✕";
      box.appendChild(img);
      box.appendChild(close);
      // Backdrop click closes; clicks on the image itself do not.
      box.addEventListener("click", (e) => {
        if (e.target === img) return;
        closeGuideLightbox();
      });
      document.addEventListener("keydown", onGuideLightboxKey, true);
      (document.body || document.documentElement).appendChild(box);
      _guideLightbox = box;
      try { close.focus(); } catch (_e) { /* focus is best-effort */ }
    }
    async function maybeShowGuide() {
      if (!modal.hidden || fab.hidden || uiSuspended()) return;
      if (await readGuideSeen()) return;
      guide.hidden = false;
    }
    // Show/hide the "Start here..." bubble. It only shows while the FAB is
    // visible; opening Styx (FAB or toolbar icon) clears it for good.
    function showStartHint() {
      hint.hidden = fab.hidden;
    }
    function clearStartHint() {
      hint.hidden = true;
      writeStartHintPending(false);
    }
    function openModal() {
      hideGuide();
      clearStartHint();
      if (!frame.src && frame.dataset.src) frame.src = frame.dataset.src;
      modal.hidden = false;
      fab.hidden = true;
      notifyFabVis();
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
      notifyFabVis();
      writeStoredOpen(false);
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      setTimeout(() => { maybeShowGuide(); }, 250);
    }
    function toggleModal() {
      if (modal.hidden) openModal(); else closeModal();
    }

    guide.addEventListener("click", async (e) => {
      // Any screenshot in the guide opens full size — the inline shots are
      // deliberately small to keep every step the same height, so this is how
      // a user reads the detail in one.
      const shot = e.target && e.target.closest && e.target.closest("img");
      // The intro's icon is decorative chrome, not a screenshot — skip it.
      if (shot && guide.contains(shot) && !shot.closest(".styx-guide-intro")) {
        openGuideLightbox(shot.currentSrc || shot.src, shot.alt || "");
        return;
      }
      const action = e.target && e.target.closest && e.target.closest("[data-action]")?.dataset.action;
      if (action === "guide-back") {
        guidePage = Math.max(0, guidePage - 1);
        renderGuidePage();
      } else if (action === "guide-next") {
        guidePage = Math.min(guidePages.length - 1, guidePage + 1);
        renderGuidePage();
      } else if (action === "finish-guide") {
        await markGuideSeen("completed");
        hideGuide();
        await writeStartHintPending(true);
        showStartHint();
      } else if (action === "dismiss-guide") {
        await markGuideSeen("dismissed");
        hideGuide();
      }
    });

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

    // Restore open state across Amazon's full-page navigations — UNLESS a
    // multi-navigation Styx operation is running (cart clear / list save /
    // restore). Those reload the page repeatedly; auto-reopening here would
    // rebuild the popup and re-hit the lists API on every single load. The
    // FAB still shows, so the user can open it manually if they want to.
    if (readStoredOpen() && !uiSuspended()) openModal();

    setTimeout(() => { maybeShowGuide(); }, 500);

    // Guide finished but Styx not opened yet: keep pointing at the button, on
    // this page load and in other tabs (until any of them opens Styx).
    readStartHintPending().then((pending) => {
      if (pending && modal.hidden) showStartHint();
    });
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        const c = area === "local" && changes[FAB_HINT_KEY];
        if (!c) return;
        if (c.newValue) { if (modal.hidden) showStartHint(); }
        else hint.hidden = true;
      });
    } catch (_e) { /* no storage — ignore */ }

    // The FAB now exists; nudge any in-page UI that rides on its visibility
    // (the wishlist "Send All" pill was set up before this ran).
    notifyFabVis();
  }

  // Run after the const/function declarations above are initialized (avoids a
  // temporal-dead-zone ReferenceError if called earlier in the init sequence).
  initFloatingUi();
})();
