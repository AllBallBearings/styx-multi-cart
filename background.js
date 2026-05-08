/**
 * background.js — service worker.
 *
 * Owns:
 *   - Storage layer (chrome.storage.local) for saved carts.
 *   - Restore logic: builds an Amazon batch add-to-cart URL and opens it.
 *   - Tab discovery: finds (or opens) an Amazon cart tab to send messages to.
 */

const STORAGE_KEY = "mc.carts.v1";

// ---- Storage helpers ------------------------------------------------------

async function readCarts() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
}

async function writeCarts(carts) {
  await chrome.storage.local.set({ [STORAGE_KEY]: carts });
}

function makeId() {
  return (
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8)
  );
}

// ---- Tab helpers ----------------------------------------------------------

// Chrome's match-pattern syntax accepts a leading `*.` host wildcard but not
// `amazon.*` — we have to list every TLD we care about explicitly.
const AMAZON_TLDS = [
  "amazon.com",
  "amazon.co.uk",
  "amazon.ca",
  "amazon.com.au",
  "amazon.de",
  "amazon.fr",
  "amazon.it",
  "amazon.es",
  "amazon.co.jp",
  "amazon.in",
  "amazon.com.mx",
  "amazon.com.br",
];

const AMAZON_CART_PATTERNS = AMAZON_TLDS.flatMap((tld) => [
  `*://*.${tld}/gp/cart/*`,
  `*://*.${tld}/cart/*`,
]);

async function findAmazonCartTab(preferredHost) {
  const [active] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (
    active &&
    active.url &&
    /amazon\.[a-z.]+\/(gp\/)?cart\//i.test(active.url)
  ) {
    return active;
  }

  const cartTabs = await chrome.tabs.query({ url: AMAZON_CART_PATTERNS });
  if (cartTabs.length) return cartTabs[0];

  // Open one.
  const host = preferredHost || "www.amazon.com";
  return new Promise((resolve) => {
    chrome.tabs.create(
      { url: `https://${host}/gp/cart/view.html`, active: true },
      (tab) => {
        // Wait for it to finish loading, then re-fetch so tab.url reflects
        // the loaded URL (the create callback's tab object has stale fields).
        const listener = async (tabId, info) => {
          if (tabId === tab.id && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            try {
              resolve(await chrome.tabs.get(tab.id));
            } catch {
              resolve(tab);
            }
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      }
    );
  });
}

/**
 * Inject content.js into a tab if it isn't already there, then send a message.
 * Cart tabs always have content.js via manifest, but this is defensive — for
 * example if the user is on a cart subroute we didn't list, we can still work.
 */
async function sendToContent(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_e) {
    // Content script not loaded yet — inject and retry.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

// ---- Restore: navigate-and-click ------------------------------------------

/**
 * Amazon's old batch endpoint (/gp/aws/cart/add.html) is unreliable —
 * frequent silent drops that land you on an empty cart. The bulletproof
 * approach is to actually drive the site:
 *
 *   1. Open one helper tab.
 *   2. For each saved item, navigate it to that product's page.
 *   3. Run an in-page script that selects the right quantity and clicks
 *      the page's real "Add to Cart" button.
 *   4. End on /gp/cart/view.html so the user can review.
 *
 * It's slower (~3–5s per item) but it actually works, and it goes through
 * the same UI flow as a human, so authentication, sessions, region locks,
 * and seller-specific buy-box selection all just work.
 */
async function restoreCart(savedCart, onProgress) {
  const items = (savedCart.items || []).filter((it) => it && it.asin);
  if (!items.length) {
    return { ok: false, error: "This saved cart has no items." };
  }

  const host = savedCart.host || "www.amazon.com";
  const productUrl = (item) =>
    item.url && /^https?:\/\//.test(item.url)
      ? item.url
      : `https://${host}/dp/${item.asin}`;

  // Open the helper tab on the first product.
  const helperTab = await chrome.tabs.create({
    url: productUrl(items[0]),
    active: true,
  });
  await waitForTabComplete(helperTab.id);

  let added = 0;
  let failed = 0;
  const failures = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      // For all items after the first, navigate the same tab.
      if (i > 0) {
        await chrome.tabs.update(helperTab.id, { url: productUrl(item) });
        await waitForTabComplete(helperTab.id);
      }

      // Inject and run the click-add-to-cart routine.
      const result = await chrome.scripting.executeScript({
        target: { tabId: helperTab.id },
        func: pageAddToCart,
        args: [Math.max(1, item.quantity || 1)],
      });

      const r = result && result[0] && result[0].result;
      if (r && r.ok) {
        added++;
      } else {
        failed++;
        failures.push({
          asin: item.asin,
          title: item.title || "",
          reason: (r && r.error) || "unknown",
        });
      }

      if (onProgress) onProgress({ done: i + 1, total: items.length });
    } catch (err) {
      failed++;
      failures.push({
        asin: item.asin,
        title: item.title || "",
        reason: String(err && err.message) || String(err),
      });
    }
  }

  // Land on the cart view so the user can confirm what came through.
  try {
    await chrome.tabs.update(helperTab.id, {
      url: `https://${host}/gp/cart/view.html`,
      active: true,
    });
  } catch (_e) {
    // Tab may have been closed by the user mid-restore — fine.
  }

  return {
    ok: true,
    total: items.length,
    added,
    failed,
    failures,
  };
}

/**
 * Runs in the product page's context (via chrome.scripting.executeScript).
 * Sets the quantity if there's a quantity dropdown, clicks the page's
 * real Add-to-Cart button, and auto-declines any protection-plan upsell
 * that pops up (modal *or* full-page interstitial).
 *
 * Returns { ok: bool, error?, dismissedUpsell? }.
 */
function pageAddToCart(qty) {
  return new Promise((resolve) => {
    const ATC_SELECTORS = [
      "#add-to-cart-button",
      "input#add-to-cart-button",
      "input[name='submit.add-to-cart']",
      "input[name='submit.addToCart']",
      "button[name='submit.add-to-cart']",
      "#submit\\.add-to-cart input",
      "span#submit\\.add-to-cart input",
    ];

    const QTY_SELECTORS = [
      "select#quantity",
      "select[name='quantity']",
      "input#quantity",
      "input[name='quantity']",
    ];

    const findFirst = (sels) => {
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el) return el;
      }
      return null;
    };

    const setQuantity = () => {
      if (qty <= 1) return;
      const qEl = findFirst(QTY_SELECTORS);
      if (!qEl) return;
      const target = String(qty);
      if (qEl.tagName === "SELECT") {
        const opts = Array.from(qEl.options || []);
        const match = opts.find((o) => o.value === target);
        if (match) {
          qEl.value = target;
          qEl.dispatchEvent(new Event("change", { bubbles: true }));
        }
        // If qty exceeds the dropdown's max (e.g., 30), Amazon usually
        // exposes a free-text input via the "10+" / "Quantity" option.
        // We accept whatever the dropdown caps at — better than failing.
      } else {
        qEl.value = target;
        qEl.dispatchEvent(new Event("input", { bubbles: true }));
        qEl.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };

    /**
     * After clicking Add to Cart, Amazon sometimes interrupts with a
     * protection-plan upsell — either an overlay/sidesheet on the same
     * page, or a redirect to /gp/.../attach-warranty/... where the
     * primary item ISN'T actually in the cart yet until you click
     * "Continue" or "No thanks".
     *
     * Strategy: select any "no coverage" radio if one is offered, then
     * click the proceed/decline button. Retry a few times because the
     * modal renders slightly after the click.
     */
    const dismissProtectionPlan = () =>
      new Promise((done) => {
        let tries = 0;

        const tick = () => {
          tries++;

          // Phase 1: select the "No coverage" / "No thanks" radio if
          // there is one, so the proceed button submits the right state.
          const radios = document.querySelectorAll(
            "input[type='radio']#attachSiNoCoverage, " +
              "input[type='radio']#siNoCoverage, " +
              "input[type='radio'][name='attachSiCoverageName'][value='noCoverage'], " +
              "input[type='radio'][value='noCoverage'], " +
              "input[type='radio'][value='no-coverage'], " +
              "input[type='radio'][name*='warranty'][value*='no-coverage']"
          );
          radios.forEach((r) => {
            if (!r.checked) {
              try { r.click(); } catch (_e) { /* ignore */ }
            }
          });

          // Phase 2: find a proceed/decline button.
          let btn =
            document.querySelector("input#attachSiAddedToCart") ||
            document.querySelector(
              "input[name='submit.attach-warranty-handler-no-warranty']"
            ) ||
            document.querySelector(
              "input[name='submit.attach-sidesheet-no-coverage']"
            ) ||
            document.querySelector(
              "input[name='submit.add-to-cart-no-warranty']"
            );

          // Fallback: scan visible buttons/links for a clear "decline"
          // label. Skip any element that's clearly the OPPOSITE action.
          if (!btn) {
            const candidates = document.querySelectorAll(
              "input[type='submit'], button, a"
            );
            for (const el of candidates) {
              const text = (el.textContent || el.value || "")
                .trim()
                .toLowerCase();
              if (!text) continue;
              if (
                text === "no thanks" ||
                text === "no, thanks" ||
                text === "decline" ||
                text === "skip" ||
                text.startsWith("continue without") ||
                text.startsWith("no thanks,")
              ) {
                btn = el;
                break;
              }
            }
          }

          if (btn) {
            try { btn.click(); } catch (_e) { /* ignore */ }
            done(true);
            return;
          }

          if (tries < 5) {
            setTimeout(tick, 500);
          } else {
            done(false); // no upsell appeared, or we couldn't find a way out
          }
        };

        tick();
      });

    const tryClick = (attempt) => {
      const btn = findFirst(ATC_SELECTORS);
      if (!btn) {
        if (attempt < 8) {
          setTimeout(() => tryClick(attempt + 1), 500);
        } else {
          resolve({ ok: false, error: "Add to Cart button not found" });
        }
        return;
      }

      // Some buttons are disabled until the page finishes hydrating.
      if (btn.disabled || btn.getAttribute("aria-disabled") === "true") {
        if (attempt < 8) {
          setTimeout(() => tryClick(attempt + 1), 500);
          return;
        }
      }

      setQuantity();
      try {
        btn.click();
      } catch (e) {
        resolve({ ok: false, error: "click threw: " + String(e) });
        return;
      }

      // Wait for any protection-plan upsell to render, then auto-dismiss
      // it. Either way, give Amazon a moment to settle before we move on.
      setTimeout(() => {
        dismissProtectionPlan().then((dismissed) => {
          setTimeout(
            () => resolve({ ok: true, dismissedUpsell: dismissed }),
            dismissed ? 1500 : 1100
          );
        });
      }, 1000);
    };

    // Wait for the doc to be in a ready-ish state.
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => tryClick(0), {
        once: true,
      });
    } else {
      tryClick(0);
    }
  });
}

// ---- Message router -------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  (async () => {
    try {
      switch (msg.type) {
        case "MC_LIST_CARTS": {
          const carts = await readCarts();
          sendResponse({ ok: true, carts });
          break;
        }

        case "MC_SAVE_CURRENT": {
          // Ask the active Amazon cart tab to scrape, then store under `name`.
          const tab = await findAmazonCartTab();
          const scraped = await sendToContent(tab.id, {
            type: "MC_SCRAPE_CART",
          });
          if (!scraped || !scraped.ok) {
            sendResponse({
              ok: false,
              error:
                (scraped && scraped.error) ||
                "Could not read the Amazon cart page. Make sure you're on amazon.com/cart.",
            });
            break;
          }
          const cart = scraped.cart;
          if (!cart.items.length) {
            sendResponse({
              ok: false,
              error:
                "Your Amazon cart looks empty — nothing to save.",
            });
            break;
          }
          const carts = await readCarts();
          carts.unshift({
            id: makeId(),
            name: msg.name || "Untitled cart",
            host: cart.host,
            savedAt: cart.capturedAt,
            items: cart.items,
          });
          await writeCarts(carts);
          sendResponse({ ok: true, count: cart.items.length });
          break;
        }

        case "MC_RENAME_CART": {
          const carts = await readCarts();
          const target = carts.find((c) => c.id === msg.id);
          if (!target) {
            sendResponse({ ok: false, error: "Cart not found." });
            break;
          }
          target.name = msg.name || target.name;
          await writeCarts(carts);
          sendResponse({ ok: true });
          break;
        }

        case "MC_DELETE_CART": {
          const carts = await readCarts();
          const next = carts.filter((c) => c.id !== msg.id);
          await writeCarts(next);
          sendResponse({ ok: true });
          break;
        }

        case "MC_RESTORE_CART": {
          const carts = await readCarts();
          const target = carts.find((c) => c.id === msg.id);
          if (!target) {
            sendResponse({ ok: false, error: "Cart not found." });
            break;
          }
          // Acknowledge immediately so the popup doesn't time out — this
          // can take a long time for large carts. The popup will likely
          // close before we finish; that's fine.
          sendResponse({ ok: true, started: true, total: target.items.length });
          // Continue working.
          await restoreCart(target);
          break;
        }

        case "MC_CLEAR_CURRENT": {
          const tab = await findAmazonCartTab();
          // Make sure it's actually a cart page; if not, navigate.
          if (!/amazon\.[a-z.]+\/(gp\/)?cart\//i.test(tab.url || "")) {
            await chrome.tabs.update(tab.id, {
              url: "https://www.amazon.com/gp/cart/view.html",
            });
            await waitForTabComplete(tab.id);
          }
          const result = await sendToContent(tab.id, {
            type: "MC_CLEAR_CART",
          });
          sendResponse(result || { ok: false, error: "No response" });
          break;
        }

        case "MC_SAVE_AND_CLEAR": {
          // Convenience: scrape, save, then clear in one shot.
          const tab = await findAmazonCartTab();
          const scraped = await sendToContent(tab.id, {
            type: "MC_SCRAPE_CART",
          });
          if (!scraped || !scraped.ok || !scraped.cart.items.length) {
            sendResponse({
              ok: false,
              error:
                (scraped && scraped.error) ||
                "Cart appears empty — nothing to save.",
            });
            break;
          }
          const carts = await readCarts();
          carts.unshift({
            id: makeId(),
            name: msg.name || "Untitled cart",
            host: scraped.cart.host,
            savedAt: scraped.cart.capturedAt,
            items: scraped.cart.items,
          });
          await writeCarts(carts);
          const cleared = await sendToContent(tab.id, {
            type: "MC_CLEAR_CART",
          });
          sendResponse({
            ok: true,
            saved: scraped.cart.items.length,
            removed: (cleared && cleared.removed) || 0,
          });
          break;
        }

        default:
          sendResponse({ ok: false, error: "Unknown message: " + msg.type });
      }
    } catch (err) {
      console.error("[Styx Multi-Cart] background error", err);
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    }
  })();

  return true; // keep the channel open for async sendResponse
});

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}
