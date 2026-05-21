/**
 * lib/scrape.js — Amazon cart DOM scrapers extracted from background.js for
 * unit testing.
 *
 * Both functions here are byte-identical copies of pageScrapeCart and
 * pageGetCartCount in background.js, where they're injected into the cart
 * tab via chrome.scripting.executeScript. They reference only document /
 * window / location and dispatch DOM events — perfect fit for jsdom.
 *
 * Keep these in sync with background.js by hand until the SW is migrated
 * to ES modules. The header in background.js cross-references this file.
 */

export function pageGetCartCount() {
  const parseCount = (value) => {
    const n = parseInt(String(value || "").replace(/[^\d]/g, ""), 10);
    return Number.isNaN(n) ? null : n;
  };

  const activeRows = document.querySelectorAll(
    "div[data-asin][data-itemtype='active'], " +
      ".ewc-item[data-asin], " +
      "div[data-asin].sc-list-item, " +
      "div[data-asin][data-itemid]"
  );
  const liveRows = Array.from(activeRows).filter((row) => {
    const asin = row.getAttribute("data-asin");
    const itemType = (row.getAttribute("data-itemtype") || "").toLowerCase();
    if (!asin || itemType.includes("saved")) return false;
    if (row.hidden || row.getAttribute("aria-hidden") === "true") return false;
    if (
      row.classList.contains("ewc-item-deleted") ||
      row.classList.contains("sc-list-item-removed")
    ) {
      return false;
    }
    return true;
  });
  if (liveRows.length) return liveRows.length;

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

export async function pageScrapeCart() {
  // Trigger Amazon's IntersectionObserver so it loads real image URLs.
  window.dispatchEvent(new Event("scroll"));
  window.dispatchEvent(new Event("resize"));
  await new Promise((r) => setTimeout(r, 700));

  try {
    function pickBestImg(row) {
      function isUsable(img) {
        if (!img) return false;
        if (img.closest(".sc-list-item-spinner")) return false;
        const s = img.currentSrc || img.src || "";
        return (
          s &&
          !s.startsWith("data:") &&
          !s.includes("loadIndicators") &&
          !s.includes("transparent-pixel")
        );
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
            let best = urls[0],
              bestArea = 0;
            for (const u of urls) {
              const d = map[u] || [0, 0];
              const a = (d[0] || 0) * (d[1] || 0);
              if (a > bestArea) {
                bestArea = a;
                best = u;
              }
            }
            return best;
          }
        } catch (_e) {
          /* fall through */
        }
      }
      if (img.currentSrc && !img.currentSrc.includes("loadIndicators"))
        return img.currentSrc;
      const src = img.src || "";
      return isUsable(img) ? src : "";
    }

    function readNavCartCount() {
      const candidates = [
        document.getElementById("nav-cart-count"),
        document.getElementById("ewc-total-quantity"),
        document.querySelector("#nav-cart .nav-cart-count"),
      ];
      for (const el of candidates) {
        if (!el) continue;
        const t = (el.textContent || el.value || "").trim();
        const n = parseInt(t.replace(/[^\d]/g, ""), 10);
        if (Number.isFinite(n)) return n;
      }
      return null;
    }
    const navCartCount = readNavCartCount();

    const activeScope =
      document.querySelector("[data-name='Active Items']") ||
      document.querySelector("#sc-active-cart") ||
      document.querySelector("#ewc-content") ||
      document.querySelector("#nav-flyout-ewc") ||
      document.body;

    let rows = activeScope.querySelectorAll(
      "div[data-asin][data-itemtype='active'], li[data-asin][data-itemtype='active']"
    );
    if (!rows.length) {
      rows = activeScope.querySelectorAll(
        "div[data-asin].sc-list-item, li[data-asin].sc-list-item, li[data-asin].ewc-item"
      );
    }
    if (!rows.length) {
      rows = activeScope.querySelectorAll("[data-asin]");
    }

    const items = [];
    const seen = new Set();

    rows.forEach((row) => {
      const asin = row.getAttribute("data-asin");
      if (!asin || seen.has(asin)) return;
      const itemtype = (row.getAttribute("data-itemtype") || "").toLowerCase();
      if (itemtype === "saved") return;
      seen.add(asin);

      const titleEl =
        row.querySelector(".sc-product-title .a-truncate-full") ||
        row.querySelector(".sc-product-title") ||
        row.querySelector("span.a-truncate-full") ||
        row.querySelector("a.sc-product-link span");
      const title = titleEl ? titleEl.textContent.trim() : "(unknown title)";

      let quantity = 1;
      const qSel = row.querySelector("select[name='quantity']");
      const qInp = row.querySelector("input[name='quantityBox']");
      const qSpan = row.querySelector(".a-dropdown-prompt");
      if (qSel && qSel.value) quantity = parseInt(qSel.value, 10) || 1;
      else if (qInp && qInp.value) quantity = parseInt(qInp.value, 10) || 1;
      else if (qSpan && qSpan.textContent) {
        const n = parseInt(qSpan.textContent.trim(), 10);
        if (!Number.isNaN(n)) quantity = n;
      }

      const priceEl =
        row.querySelector(".sc-product-price") ||
        row.querySelector(".a-price .a-offscreen") ||
        row.querySelector("span.a-price-whole");
      const price = priceEl ? priceEl.textContent.trim() : "";

      const image = pickBestImg(row);

      const linkEl = row.querySelector("a.sc-product-link, a[href*='/dp/']");
      const url = linkEl ? new URL(linkEl.href, location.origin).href : "";

      items.push({ asin, title, quantity, price, image, url });
    });

    return {
      host: location.hostname,
      capturedAt: new Date().toISOString(),
      items,
      navCartCount,
    };
  } catch (err) {
    return {
      error: String(err && err.message) || String(err),
      host: location.hostname,
      capturedAt: new Date().toISOString(),
      items: [],
      navCartCount: null,
    };
  }
}
