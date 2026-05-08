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
    const img = row.querySelector("img.sc-product-image, img");
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

    const srcset = img.getAttribute("srcset");
    if (srcset) {
      const parts = srcset
        .split(",")
        .map((p) => p.trim().split(/\s+/)[0])
        .filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }

    const src = img.getAttribute("src") || "";
    if (src && !src.startsWith("data:") && !/transparent-pixel/.test(src)) {
      return src;
    }
    return "";
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

    while (safety-- > 0) {
      const deleteLink = findActiveDeleteControl();
      if (!deleteLink) break;

      deleteLink.click();
      removed++;

      // Wait for Amazon's XHR + DOM update before scanning for the next row.
      await waitForCartMutation(2500);
    }

    return removed;
  }

  /** Locate the next clickable "Delete" control inside the Active Items section. */
  function findActiveDeleteControl() {
    const scopes = [
      document.querySelector("[data-name='Active Items']"),
      document.querySelector("#sc-active-cart"),
    ].filter(Boolean);

    if (!scopes.length) {
      // Fallback: anything explicitly tagged active.
      return document.querySelector(
        "div[data-asin][data-itemtype='active'] input[value='Delete']"
      );
    }

    for (const scope of scopes) {
      const el =
        scope.querySelector("input[value='Delete']") ||
        scope.querySelector("input[name='submit.delete']") ||
        scope.querySelector("[data-action*='delete'] input") ||
        scope.querySelector("input[data-feature-id='delete']") ||
        // Newer Amazon variants use a button rather than an input
        scope.querySelector("button[name='submit.delete']") ||
        scope.querySelector("button[data-action*='delete']");
      if (el) return el;
    }
    return null;
  }

  /**
   * Resolve when the cart's active-items container mutates,
   * or after `timeoutMs`, whichever comes first.
   */
  function waitForCartMutation(timeoutMs) {
    return new Promise((resolve) => {
      const target =
        document.querySelector("[data-name='Active Items']") ||
        document.querySelector("#sc-active-cart") ||
        document.body;

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        observer.disconnect();
        resolve();
      };

      const observer = new MutationObserver(() => {
        // Debounce: wait 250ms of quiet after a change before resolving.
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, 250);
      });

      let quietTimer = setTimeout(finish, timeoutMs);
      observer.observe(target, { childList: true, subtree: true });
    });
  }

  // ---- Message bus ---------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return false;

    if (msg.type === "MC_SCRAPE_CART") {
      try {
        sendResponse({ ok: true, cart: scrapeCart() });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
      return true; // sync
    }

    if (msg.type === "MC_CLEAR_CART") {
      clearCart()
        .then((removed) => sendResponse({ ok: true, removed }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true; // async — keep the channel open
    }

    return false;
  });
})();
