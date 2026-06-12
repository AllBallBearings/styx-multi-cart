/**
 * content.js — runs on Amazon cart pages.
 *
 * Two responsibilities:
 *   1. Scrape the current cart (ASIN, title, qty, price, image).
 *   2. Clear the current cart by clicking each item's "Delete" link.
 *
 * The popup talks to this script through chrome.runtime.sendMessage,
 * relayed by the background service worker.
 */

(function () {
  "use strict";

  // Re-injection guard. Besides the manifest declaration, background.js
  // injects this file on demand when a tab has no listener (Safari's "Ask"
  // site-access level blocks manifest content scripts while the activeTab
  // grant still allows scripting). A second evaluation must not register a
  // second onMessage listener or every request would get double responses.
  if (window.__styxMcContentLoaded) return;
  window.__styxMcContentLoaded = true;

  // Diagnostic logging — mirrors the popup's Developer mode switch (the
  // mc.dev.v1 flag in chrome.storage.local). When it's on, dlog/dwarn print to
  // this page's console AND forward to the service worker's in-memory ring
  // buffer, so the popup's "Copy diagnostic logs" button can gather logs from
  // every context in one paste. When off, they're no-ops. Flip it via
  // Settings → Developer mode in the popup.
  const MC_DEV_FLAG_KEY = "mc.dev.v1";
  const MC_LOG_CTX = "content";
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

  dlog("[Styx MC] content.js loaded on", location.href);

  /** Pull the Amazon host (e.g. "www.amazon.com") so restore URLs match the storefront the user is on. */
  function getAmazonHost() {
    return location.hostname;
  }

  /**
   * Scrape line items from the current cart page.
   * Amazon's cart markup uses `data-asin` on each item row plus
   * a quantity dropdown/input and a price node. Selectors are kept
   * defensive — Amazon A/B tests this page often.
   */
  function scrapeCart() {
    const items = [];
    // Scope strictly to Active Items so we never capture Save For Later.
    const activeScope =
      document.querySelector("[data-name='Active Items']") ||
      document.querySelector("#sc-active-cart") ||
      document.body;

    const rows = activeScope.querySelectorAll(
      "div[data-asin][data-itemtype='active'], " +
        "div[data-asin].sc-list-item, " +
        "div[data-asin]"
    );

    const seen = new Set();

    rows.forEach((row) => {
      const asin = row.getAttribute("data-asin");
      if (!asin || seen.has(asin)) return;
      seen.add(asin);

      // Title
      const titleEl =
        row.querySelector(".sc-product-title .a-truncate-full") ||
        row.querySelector(".sc-product-title") ||
        row.querySelector("span.a-truncate-full") ||
        row.querySelector("a.sc-product-link span");
      const title = titleEl ? titleEl.textContent.trim() : "(unknown title)";

      // Quantity — can be a <select>, an <input>, or a span with the value
      let quantity = 1;
      const qtySelect = row.querySelector("select[name='quantity']");
      const qtyInput = row.querySelector("input[name='quantityBox']");
      const qtySpan = row.querySelector(".a-dropdown-prompt");
      if (qtySelect && qtySelect.value) {
        quantity = parseInt(qtySelect.value, 10) || 1;
      } else if (qtyInput && qtyInput.value) {
        quantity = parseInt(qtyInput.value, 10) || 1;
      } else if (qtySpan && qtySpan.textContent) {
        const n = parseInt(qtySpan.textContent.trim(), 10);
        if (!Number.isNaN(n)) quantity = n;
      }

      // Price (display only — not used for restore)
      const priceEl =
        row.querySelector(".sc-product-price") ||
        row.querySelector(".a-price .a-offscreen") ||
        row.querySelector("span.a-price-whole");
      const price = priceEl ? priceEl.textContent.trim() : "";

      // Image — Amazon lazy-loads cart thumbnails, so img.src may be a
      // placeholder (data: URI or blank) until the row has scrolled into
      // view. Prefer the attributes that always carry real CDN URLs.
      const image = pickBestImage(row);

      // Product URL
      const linkEl = row.querySelector("a.sc-product-link, a[href*='/dp/']");
      const url = linkEl ? new URL(linkEl.href, location.origin).href : "";

      items.push({
        asin,
        title,
        quantity,
        price,
        image,
        url,
      });
    });

    dlog("[Styx MC] scrapeCart found", items.length, "active item(s)");
    return {
      host: getAmazonHost(),
      capturedAt: new Date().toISOString(),
      items,
    };
  }

  /**
   * Pick the best CDN image URL for an item row. Cart thumbnails are
   * lazy-loaded; until they've scrolled into view, the <img> src is a
   * spinner / placeholder. The real URL lives in the data attributes.
   *
   * Try in order:
   *   1. data-a-dynamic-image   — JSON map { url: [w, h] } (largest wins)
   *   2. data-a-hires           — single hi-res URL
   *   3. srcset                 — pick the last entry (highest density)
   *   4. src                    — only if it isn't a data: placeholder
   */
  function pickBestImage(row) {
    // Amazon's cart has two <img> per row: a spinner overlay inside
    // .sc-list-item-spinner (first in DOM order) and the real product image
    // img.sc-product-image (inside a.sc-product-link). Always prefer the
    // product image; never accidentally return the spinner URL.
    function isUsable(img) {
      if (!img) return false;
      if (img.closest(".sc-list-item-spinner")) return false;
      const s = img.currentSrc || img.src || "";
      return s && !s.startsWith("data:") && !s.includes("loadIndicators") && !s.includes("transparent-pixel");
    }

    let img = row.querySelector("img.sc-product-image");
    if (!img || !isUsable(img)) {
      img = Array.from(row.querySelectorAll("img")).find(isUsable) || null;
    }
    if (!img) return "";

    const dyn = img.getAttribute("data-a-dynamic-image");
    if (dyn) {
      try {
        const map = JSON.parse(dyn);
        const urls = Object.keys(map);
        if (urls.length) {
          let best = urls[0];
          let bestArea = 0;
          for (const u of urls) {
            const dims = map[u] || [0, 0];
            const area = (dims[0] || 0) * (dims[1] || 0);
            if (area > bestArea) {
              bestArea = area;
              best = u;
            }
          }
          return best;
        }
      } catch (_e) {
        /* fall through */
      }
    }

    const hires = img.getAttribute("data-a-hires");
    if (hires) return hires;

    // currentSrc is higher-res (browser-negotiated via srcset) when present.
    if (img.currentSrc && !img.currentSrc.includes("loadIndicators")) return img.currentSrc;

    const src = img.src || "";
    return isUsable(img) ? src : "";
  }

  /**
   * Click each "Delete" link in the *active* cart. We have to do this
   * sequentially because Amazon re-renders the cart after each click;
   * trying to click them all at once leaves orphaned references.
   *
   * The selectors are deliberately scoped to the Active Items container so
   * we never accidentally remove anything from Save For Later.
   *
   * Returns the number of items removed.
   */
  async function clearCart() {
    let removed = 0;
    let safety = 200; // hard cap so we never spin forever
    let stalledClicks = 0;
    const initialCount = getActiveCartRows().length;
    dlog("[Styx MC] clearCart start —", initialCount, "active row(s)");

    while (safety-- > 0) {
      const rows = getActiveCartRows();
      if (!rows.length) break;

      const row = rows[0];
      const beforeCount = rows.length;
      const deleteLink = findDeleteControl(row) || findActiveDeleteControl();
      if (!deleteLink) {
        break;
      }

      clickControl(deleteLink);

      // Wait for Amazon's XHR + DOM update before scanning for the next row.
      await waitForCartChange(row, beforeCount, 4500);

      const afterCount = getActiveCartRows().length;
      if (afterCount < beforeCount) {
        removed += beforeCount - afterCount;
        stalledClicks = 0;
      } else if (!document.contains(row) || isDeletedRow(row)) {
        removed++;
        stalledClicks = 0;
      } else {
        stalledClicks++;
        if (stalledClicks >= 2) break;
      }
    }

    const result = {
      removed,
      remaining: getRemainingCartCount(),
      found: initialCount,
      sawCartSurface: hasCartSurface(),
    };
    dlog("[Styx MC] clearCart done", result);
    return result;
  }

  function getActiveCartScopes() {
    const scopes = [
      document.querySelector("#nav-flyout-ewc .ewc-active-cart--selected"),
      document.querySelector("#ewc-content .ewc-active-cart--selected"),
      document.querySelector("#nav-flyout-ewc"),
      document.querySelector("[data-name='Active Items']"),
      document.querySelector("#sc-active-cart"),
      document.querySelector("#sc-list-body"),
    ].filter(Boolean);
    return scopes.length ? scopes : [document.body];
  }

  function getActiveCartRows() {
    const rows = [];
    const seen = new Set();

    for (const scope of getActiveCartScopes()) {
      scope
        .querySelectorAll(
          "div[data-asin][data-itemtype='active'], " +
            ".ewc-item[data-asin], " +
            "div[data-asin].sc-list-item, " +
            "div[data-asin][data-itemid]"
        )
        .forEach((row) => {
          const asin = row.getAttribute("data-asin");
          if (!asin || seen.has(row) || isDeletedRow(row)) return;
          if (isSaveForLaterRow(row)) {
            return;
          }
          // Amazon's "Coupon Clipped" confirmation box carries data-asin +
          // data-itemid but is not a cart item — never try to delete it.
          if (row.closest(".sc-clipcoupon, .sc-clipcoupon-container")) {
            return;
          }
          seen.add(row);
          rows.push(row);
        });
    }

    return rows;
  }

  function hasCartSurface() {
    return Boolean(
      document.querySelector("#nav-flyout-ewc") ||
        document.querySelector("#ewc-content") ||
        document.querySelector("[data-name='Active Items']") ||
        document.querySelector("#sc-active-cart") ||
        document.querySelector("#sc-list-body")
    );
  }

  function getRemainingCartCount() {
    const rows = getActiveCartRows();
    if (rows.length) return rows.length;

    const quantityEl =
      document.querySelector("#nav-flyout-ewc #ewc-total-quantity") ||
      document.querySelector("#ewc-content #ewc-total-quantity") ||
      document.querySelector("input[name='totalCartQuantity']");
    if (quantityEl && quantityEl.value) {
      const n = parseInt(quantityEl.value, 10);
      if (!Number.isNaN(n) && n > 0) return n;
    }

    const quantityText = document.querySelector(
      "#nav-flyout-ewc .ewc-quantity, #ewc-content .ewc-quantity"
    );
    if (quantityText) {
      const match = (quantityText.textContent || "").match(/\b(\d+)\s+items?\b/i);
      if (match) return parseInt(match[1], 10) || 0;
    }

    return 0;
  }

  // Quantity-badge reading only (nav badge / EWC totals) — never rows. This
  // mirrors the quantity branch of pageGetCartCountDetailed in
  // src/background/index.js so the pre-delete baseline and the background's
  // settle polling measure the same thing. Returns null when no badge exists.
  function getCartQuantityCount() {
    const parseCount = (value) => {
      const n = parseInt(String(value || "").replace(/[^\d]/g, ""), 10);
      return Number.isNaN(n) ? null : n;
    };

    const quantityEl =
      document.querySelector("#nav-cart-count") ||
      document.querySelector("#ewc-total-quantity") ||
      document.querySelector("input[name='totalCartQuantity']");
    if (quantityEl) {
      const count = parseCount(quantityEl.value || quantityEl.textContent);
      if (count != null) return count;
    }

    const quantityText = document.querySelector(
      "#nav-flyout-ewc .ewc-quantity, #ewc-content .ewc-quantity"
    );
    if (quantityText) {
      const match = (quantityText.textContent || "").match(/\b(\d+)\s+items?\b/i);
      if (match) return parseCount(match[1]);
    }

    return null;
  }

  function isSaveForLaterRow(row) {
    const itemType = (row.getAttribute("data-itemtype") || "").toLowerCase();
    if (itemType.includes("saved")) return true;

    const section = row.closest("[data-name], #sc-saved-cart, #sc-saved-cart-list");
    const sectionName = section
      ? (section.getAttribute("data-name") || section.id || "").toLowerCase()
      : "";
    return sectionName.includes("saved");
  }

  function isDeletedRow(row) {
    if (!row || !row.isConnected) return true;
    if (row.hidden || row.getAttribute("aria-hidden") === "true") return true;
    if (
      row.classList.contains("ewc-item-deleted") ||
      row.classList.contains("sc-list-item-removed")
    ) {
      return true;
    }

    const visibleRemovedMessage =
      findVisibleIn(row, ".ewc-item-remove-msg") ||
      findVisibleIn(row, ".ewc-item-already-removed-msg") ||
      findVisibleIn(row, ".ewc-item-moved-to-sfl-msg") ||
      findVisibleIn(row, ".sc-list-item-removed-msg") ||
      findVisibleIn(row, ".sc-list-item-removed-message") ||
      findVisibleIn(row, "[data-action='undo-delete']");
    return Boolean(visibleRemovedMessage);
  }

  function findVisibleIn(root, selector) {
    const nodes = root.querySelectorAll(selector);
    for (const node of nodes) {
      if (isVisible(node)) return node;
    }
    return null;
  }

  function isVisible(el) {
    if (!el || el.hidden || el.getAttribute("aria-hidden") === "true") {
      return false;
    }
    if (el.classList.contains("aok-hidden") || el.classList.contains("sc-hidden")) {
      return false;
    }
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  /** Locate the next clickable "Delete" control inside the Active Items section. */
  function findActiveDeleteControl() {
    for (const row of getActiveCartRows()) {
      const el = findDeleteControl(row);
      if (el) return el;
    }
    return null;
  }

  function findDeleteControl(root) {
    const selectors = [
      "input[value='Delete']",
      "input[aria-label='Delete']",
      "input[aria-label*='Delete']",
      "input[name='submit.delete']",
      "input[name^='submit.delete']",
      "input[name*='delete']",
      "input[data-feature-id='delete']",
      "input[data-action*='delete']",
      "button[name='submit.delete']",
      "button[name^='submit.delete']",
      "button[name*='delete']",
      "button[data-action*='delete']",
      "button[data-feature-id='delete']",
      "button[aria-label='Delete']",
      "button[aria-label*='Delete']",
      "button[aria-label^='Delete ']",
      "button[data-action='a-stepper-decrement'][data-a-selector='decrement']",
      "fieldset[data-a-decrement-status='trash'] button[data-a-selector='decrement']",
      ".sc-action-quantity button[data-a-selector='decrement']",
      ".ewc-qty-and-action-items button[data-a-selector='decrement']",
      ".ewc-delete-icon-container button",
      ".ewc-delete-icon",
      "a[data-action*='delete']",
      "a[aria-label='Delete']",
      "a[aria-label*='Delete']",
      "[data-action='delete'] input",
      "[data-action*='delete'] input",
      "[data-action*='delete'] button",
      "[data-feature-id='delete'] input",
      "[data-feature-id='delete'] button",
      ".sc-action-delete input",
      ".sc-action-delete button",
      ".sc-list-item-content input[value='Delete']",
    ];

    for (const selector of selectors) {
      const el = root.querySelector(selector);
      if (isClickableControl(el)) return el;
    }

    const candidates = root.querySelectorAll("input, button, a, span[role='button']");
    for (const el of candidates) {
      const text = (el.textContent || el.value || el.getAttribute("aria-label") || "")
        .trim()
        .toLowerCase();
      if (
        text === "delete" ||
        text === "remove" ||
        text.startsWith("delete ")
      ) {
        return el;
      }
    }

    return null;
  }

  function isClickableControl(el) {
    if (!el || el.disabled || el.getAttribute("aria-disabled") === "true") {
      return false;
    }
    return true;
  }

  function clickControl(el) {
    try {
      el.scrollIntoView({ block: "center", inline: "center" });
    } catch (_e) {
      /* ignore */
    }
    try {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      el.click();
    } catch (_e) {
      try {
        el.click();
      } catch (_err) {
        /* ignore */
      }
    }
  }

  function submitOrClickDeleteControl(el) {
    const form = el && el.closest ? el.closest("form") : null;
    const tag = el && el.tagName ? el.tagName.toLowerCase() : "";
    const type = (el && el.getAttribute ? el.getAttribute("type") : "") || "";
    const isSubmitControl =
      (tag === "button" || tag === "input") &&
      (type === "" || /^(submit|image)$/i.test(type));

    if (form && isSubmitControl && typeof form.requestSubmit === "function") {
      try {
        // requestSubmit(btn) includes the button's name/value in the POST body
        // so Amazon knows which item to delete.
        form.requestSubmit(el);
        return;
      } catch (_e) {
        // Safari is stricter about submitters. Fall back to the page's own
        // click handlers instead of reporting success without doing anything.
      }
    }

    clickControl(el);
  }

  function waitForCartChange(row, beforeCount, timeoutMs) {
    return new Promise((resolve) => {
      const target =
        document.querySelector("#nav-flyout-ewc .ewc-active-cart--selected") ||
        document.querySelector("#ewc-content .ewc-active-cart--selected") ||
        document.querySelector("#nav-flyout-ewc") ||
        document.querySelector("[data-name='Active Items']") ||
        document.querySelector("#sc-active-cart") ||
        document.querySelector("#sc-list-body") ||
        document.body;

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        observer.disconnect();
        resolve();
      };

      const changed = () =>
        !document.contains(row) ||
        isDeletedRow(row) ||
        getActiveCartRows().length < beforeCount;

      const observer = new MutationObserver(() => {
        if (changed()) finish();
      });

      const timer = setTimeout(finish, timeoutMs);
      observer.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style", "hidden", "aria-hidden"],
      });

      setTimeout(() => {
        if (changed()) finish();
      }, 300);
    });
  }

  /**
   * Diagnostic snapshot — called by the debug panel in the popup.
   * Returns a plain-object report of everything the clear logic would see.
   */
  function diagnoseCart() {
    const scopes = getActiveCartScopes();
    const rows = getActiveCartRows();
    const quantityInput =
      document.querySelector("#ewc-total-quantity") ||
      document.querySelector("input[name='totalCartQuantity']");

    const scopeInfo = scopes.map((s) => ({
      tag: s.tagName,
      id: s.id || null,
      cls: (s.className || "").split(/\s+/).slice(0, 4).join(" "),
      children: s.children.length,
    }));

    const rowInfo = rows.map((row) => {
      const del = findDeleteControl(row);
      const control = describeControl(del);
      return {
        asin: row.getAttribute("data-asin"),
        itemtype: row.getAttribute("data-itemtype") || null,
        cls: (row.className || "").split(/\s+/).slice(0, 5).join(" "),
        isSFL: isSaveForLaterRow(row),
        isDeleted: isDeletedRow(row),
        deleteFound: !!del,
        delete: control,
      };
    });

    // Also scan ALL rows without SFL/deleted filtering to help spot missed items
    const allAsinRows = Array.from(document.querySelectorAll("div[data-asin]")).map((r) => ({
      asin: r.getAttribute("data-asin"),
      itemtype: r.getAttribute("data-itemtype") || null,
      inScopes: scopes.some((s) => s.contains(r)),
      isSFL: isSaveForLaterRow(r),
      isDeleted: isDeletedRow(r),
    }));

    return {
      url: location.href,
      sawCartSurface: hasCartSurface(),
      ewcPresent: Boolean(document.querySelector("#nav-flyout-ewc, #ewc-content")),
      ewcTotalQuantity: quantityInput ? quantityInput.value || null : null,
      scopesFound: scopeInfo,
      activeRowsFound: rowInfo.length,
      rows: rowInfo,
      allAsinRows,
      remainingCount: getRemainingCartCount(),
    };
  }

  function describeControl(el) {
    if (!el) return null;
    return {
      tag: el.tagName,
      name: el.getAttribute("name") || null,
      value: el.value || null,
      label: el.getAttribute("aria-label") || null,
      action: el.getAttribute("data-action") || null,
      selector: el.getAttribute("data-a-selector") || null,
      disabled: el.disabled || el.getAttribute("aria-disabled") === "true",
      html: el.outerHTML ? el.outerHTML.slice(0, 500) : null,
    };
  }

  // ---- Message bus ---------------------------------------------------------

  function handleExtensionMessage(msg, sendResponse) {
    if (!msg || typeof msg !== "object") return false;
    if (typeof msg.type === "string" && msg.type.startsWith("MC_")) {
      dlog("[Styx MC] content received", msg.type);
    }

    if (msg.type === "MC_SCRAPE_CART") {
      try {
        sendResponse({ ok: true, cart: scrapeCart() });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
      return true; // sync
    }

    if (msg.type === "MC_DIAGNOSE_CART") {
      try {
        sendResponse({ ok: true, report: diagnoseCart() });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
      return true;
    }

    if (msg.type === "MC_CLEAR_CART") {
      clearCart()
        .then((result) => {
          sendResponse({
            ok: result.sawCartSurface && result.remaining === 0,
            removed: result.removed,
            remaining: result.remaining,
            found: result.found,
            sawCartSurface: result.sawCartSurface,
            error:
              result.sawCartSurface && result.remaining === 0
                ? undefined
                : result.sawCartSurface
                  ? `Could not remove ${result.remaining} cart item${result.remaining === 1 ? "" : "s"}.`
                  : "Could not find an Amazon cart surface on this page.",
          });
        })
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true; // async — keep the channel open
    }

    if (msg.type === "MC_CLEAR_ONE") {
      // Delete exactly one active cart item, responding BEFORE activating the
      // control. Amazon may reload the page or update the cart in-place, so
      // background.js verifies the count change before sending the next delete.
      try {
        const rows = getActiveCartRows();
        if (!rows.length) {
          sendResponse({
            ok: true,
            empty: true,
            remaining: getRemainingCartCount(),
            sawCartSurface: hasCartSurface(),
          });
          return true;
        }

        const row = rows[0];
        const deleteBtn = findDeleteControl(row);
        if (!deleteBtn) {
          sendResponse({
            ok: false,
            error: "No delete control found for ASIN " + row.getAttribute("data-asin"),
          });
          return true;
        }

        // Respond BEFORE submitting — the page reload will kill this script
        // before a post-submit sendResponse could ever be delivered.
        // rowCount and quantityCount are pre-delete baselines in their two
        // distinct units (line items vs nav-badge quantity); background.js
        // compares each only against readings from the same unit.
        sendResponse({
          ok: true,
          asin: row.getAttribute("data-asin"),
          rowCount: rows.length,
          quantityCount: getCartQuantityCount(),
        });

        submitOrClickDeleteControl(deleteBtn);
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
      return true;
    }

    return false;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) =>
    handleExtensionMessage(msg, sendResponse)
  );

  // Safari never delivers tabs.sendMessage to content scripts injected via
  // chrome.scripting.executeScript({files}) — the listener registers, but the
  // message router ignores that world. executeScript({func}) DOES execute in
  // it, so the background falls back to calling this bridge directly. The
  // promise resolves with the handler's response (or undefined when the
  // message type isn't handled), covering both sync and async handlers.
  window.__styxMcHandleMessage = (msg) =>
    new Promise((resolve) => {
      let willRespond;
      try {
        willRespond = handleExtensionMessage(msg, resolve);
      } catch (e) {
        resolve({ ok: false, error: String(e) });
        return;
      }
      if (!willRespond) resolve(undefined);
    });

})();
