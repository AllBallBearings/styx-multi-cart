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

  // Exit fast if this page is neither a product nor an upsell surface.
  // We are still loaded on every /gp/* path so the cheap check matters.
  const onProduct = isProductPage();
  const onUpsell = isUpsellSurface();
  if (!onProduct && !onUpsell) return;

  // ---- Helpers ------------------------------------------------------------

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

    return null;
  }

  function getProductTitle() {
    const t = document.getElementById("productTitle");
    if (t && t.textContent) return t.textContent.trim().slice(0, 200);
    return (document.title || "").replace(/^Amazon\.com\s*[:|-]\s*/, "").trim();
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

  function watchAtcClicks() {
    const ATC_SELECTORS = [
      "#add-to-cart-button",
      "input#add-to-cart-button",
      "input[name='submit.add-to-cart']",
      "input[name='submit.addToCart']",
      "button[name='submit.add-to-cart']",
      "#submit\\.add-to-cart input",
      "span#submit\\.add-to-cart input",
    ];

    document.addEventListener(
      "click",
      (e) => {
        let el = e.target;
        if (!el) return;
        // Walk up to handle clicks on nested elements inside the button.
        for (let i = 0; i < 6 && el && el !== document; i++) {
          if (el.matches) {
            for (const sel of ATC_SELECTORS) {
              if (el.matches(sel)) {
                const asin = getAsinFromPage();
                if (!asin) return;
                send({
                  type: "MC_OBSERVE_ATC",
                  asin,
                  title: getProductTitle(),
                  host: location.hostname,
                });
                return;
              }
            }
          }
          el = el.parentElement;
        }
      },
      true // capture phase — get the click before Amazon's own listeners
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

  // ---- Boot ---------------------------------------------------------------

  if (onProduct) watchAtcClicks();
  if (onUpsell) watchUpsellClicks();
})();
