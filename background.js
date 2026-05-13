/**
 * background.js — service worker.
 *
 * Owns:
 *   - Storage layer (chrome.storage.local) for saved carts.
 *   - Restore logic: clears the active cart and drives product-page Add to Cart.
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

// ---- Upsell choice memory (24 h TTL) --------------------------------------
//
// When the user adds an item to their cart normally and Amazon shows a
// protection-plan / warranty / coverage upsell, observer.js records what they
// chose. We replay that same choice during cart restore for 24 hours, after
// which the entry expires and the user is prompted manually again.

const UPSELL_CHOICES_KEY = "mc.upsell.choices.v1";
const UPSELL_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_ATC_TTL_MS = 5 * 60 * 1000;

// In-memory: pending ATC clicks waiting to be linked to an upsell choice
// when the same tab arrives at an attach page. Map<tabId, {asin,title,host,at}>.
const _pendingAtc = new Map();

function prunePendingAtc() {
  const now = Date.now();
  for (const [tabId, p] of _pendingAtc) {
    if (now - p.at > PENDING_ATC_TTL_MS) _pendingAtc.delete(tabId);
  }
}

function pruneUpsellChoices(map) {
  const now = Date.now();
  const out = {};
  for (const [asin, entry] of Object.entries(map || {})) {
    if (entry && entry.recordedAt && now - entry.recordedAt < UPSELL_TTL_MS) {
      out[asin] = entry;
    }
  }
  return out;
}

async function getUpsellChoices() {
  const obj = await chrome.storage.local.get(UPSELL_CHOICES_KEY);
  const map = obj[UPSELL_CHOICES_KEY] || {};
  // Prune-on-read so expired entries never get returned even if cleanup lagged.
  const pruned = pruneUpsellChoices(map);
  // Write back if anything was pruned so storage doesn't accumulate forever.
  if (Object.keys(pruned).length !== Object.keys(map).length) {
    await chrome.storage.local.set({ [UPSELL_CHOICES_KEY]: pruned });
  }
  return pruned;
}

async function recordUpsellChoice(asin, entry) {
  if (!asin) return;
  const map = await getUpsellChoices(); // already pruned
  map[asin] = { ...entry, recordedAt: Date.now() };
  await chrome.storage.local.set({ [UPSELL_CHOICES_KEY]: map });
}

async function getRecordedUpsellChoice(asin) {
  if (!asin) return null;
  const map = await getUpsellChoices();
  return map[asin] || null;
}

/**
 * Inject a script into a tab that finds the upsell control matching a
 * previously recorded choice and clicks it. Returns true only if a
 * confident match was clicked. False means the caller should fall back
 * to the manual prompt.
 */
async function applyUpsellChoice(tabId, recorded) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageApplyUpsellChoice,
      args: [recorded],
    });
    const r = result && result[0] && result[0].result;
    return Boolean(r && r.ok);
  } catch (_e) {
    return false;
  }
}

/**
 * Runs in the upsell page's context. Finds and clicks the option matching
 * the recorded choice (decline -> "no thanks" button; accept -> the radio
 * matching label+duration+price, then the continue button). Returns
 * { ok: bool, error?, choice? }. Self-contained: no closures, no imports.
 */
function pageApplyUpsellChoice(recorded) {
  return new Promise((resolve) => {
    function isVisible(el) {
      if (!el || !el.isConnected) return false;
      if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function findDeclineControl() {
      const sels = [
        "input[name='submit.attach-warranty-handler-no-warranty']",
        "input[name='submit.attach-sidesheet-no-coverage']",
        "input[name='submit.add-to-cart-no-warranty']",
        "input[name='submit.no-thanks']",
        "input[type='radio']#attachSiNoCoverage",
        "input[type='radio']#siNoCoverage",
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && isVisible(el)) return el;
      }
      // Fallback: any visible button labeled "No thanks" / "No coverage".
      const candidates = document.querySelectorAll(
        "input[type='submit'], input[type='button'], button, a"
      );
      for (const b of candidates) {
        const t = (b.value || b.textContent || b.getAttribute("aria-label") || "")
          .toLowerCase()
          .trim();
        if (
          (t === "no thanks" ||
            t === "no, thanks" ||
            t === "no coverage" ||
            t === "skip" ||
            t === "skip protection") &&
          isVisible(b)
        ) {
          return b;
        }
      }
      return null;
    }

    function findAcceptRadio(recorded) {
      const radios = Array.from(
        document.querySelectorAll(
          "input[type='radio'][name='attachSiCoverageName'], " +
            "input[type='radio'][name*='coverage' i], " +
            "input[type='radio'][name*='warranty' i], " +
            "input[type='radio'][name*='protection' i]"
        )
      ).filter(isVisible);
      if (!radios.length) return null;

      function scoreRadio(radio) {
        const container =
          radio.closest(
            "[data-coverage-option], .a-row, .a-section, label, li"
          ) || radio.parentElement;
        if (!container) return -1;
        const text = (container.innerText || container.textContent || "")
          .trim()
          .toLowerCase();
        let score = 0;

        // Label token overlap (worth up to 50 pts).
        if (recorded.optionLabel) {
          const recTokens = recorded.optionLabel
            .toLowerCase()
            .split(/\s+/)
            .filter((t) => t.length > 2);
          if (recTokens.length) {
            const matches = recTokens.filter((t) => text.includes(t)).length;
            score += (matches / recTokens.length) * 50;
          }
        }

        // Price match (up to 30 pts, with tolerance).
        if (recorded.optionPrice) {
          const recPrice = parseFloat(
            String(recorded.optionPrice).replace(/[^\d.]/g, "")
          );
          const txtPriceMatch = text.match(/\$\s?(\d+(?:\.\d{2})?)/);
          if (txtPriceMatch && !Number.isNaN(recPrice)) {
            const txtPrice = parseFloat(txtPriceMatch[1]);
            const diff = Math.abs(recPrice - txtPrice);
            if (diff < 0.01) score += 30;
            else if (diff < 1) score += 22;
            else if (diff < 3) score += 8;
          }
        }

        // Duration match (up to 30 pts).
        if (recorded.optionDuration) {
          const durMatch = text.match(/(\d+)\s*[-\s]?(year|yr|month|mo)\b/i);
          if (durMatch) {
            const n = parseInt(durMatch[1], 10);
            const dur = /year|yr/i.test(durMatch[0]) ? n * 12 : n;
            if (dur === recorded.optionDuration) score += 30;
            else if (Math.abs(dur - recorded.optionDuration) <= 2) score += 10;
          }
        }
        return score;
      }

      const scored = radios.map((r) => ({ radio: r, score: scoreRadio(r) }));
      scored.sort((a, b) => b.score - a.score);
      // Require a confident match — 50/100 minimum. Otherwise fall back.
      if (scored[0] && scored[0].score >= 50) return scored[0].radio;
      return null;
    }

    function findContinueControl() {
      const sels = [
        "input[type='submit'][name*='attach' i]",
        "input[type='submit'][name*='continue' i]",
        "input[type='submit'][value*='Continue' i]",
        "input[type='submit'][value*='Add to' i]",
        "button[name*='attach' i]",
        "button[name*='continue' i]",
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && isVisible(el)) return el;
      }
      const candidates = document.querySelectorAll(
        "input[type='submit'], button[type='submit'], button"
      );
      for (const b of candidates) {
        const t = (b.value || b.textContent || "").toLowerCase().trim();
        if (
          (t.includes("continue") ||
            t.includes("add to cart") ||
            t.includes("proceed")) &&
          isVisible(b)
        ) {
          return b;
        }
      }
      return null;
    }

    try {
      if (!recorded || !recorded.choice) {
        resolve({ ok: false, error: "no recorded choice" });
        return;
      }

      if (recorded.choice === "declined") {
        const btn = findDeclineControl();
        if (!btn) {
          resolve({ ok: false, error: "decline control not found" });
          return;
        }
        try { btn.click(); } catch (e) {
          resolve({ ok: false, error: "click threw: " + String(e) });
          return;
        }
        resolve({ ok: true, choice: "declined" });
        return;
      }

      if (recorded.choice === "accepted") {
        const radio = findAcceptRadio(recorded);
        if (!radio) {
          resolve({ ok: false, error: "no confident coverage option match" });
          return;
        }
        try {
          radio.click();
          if (!radio.checked) radio.checked = true;
          radio.dispatchEvent(new Event("change", { bubbles: true }));
        } catch (e) {
          resolve({ ok: false, error: "radio click threw: " + String(e) });
          return;
        }
        // Brief pause so the page can react (some pages enable Continue async).
        setTimeout(() => {
          const cont = findContinueControl();
          if (!cont) {
            resolve({ ok: false, error: "continue control not found" });
            return;
          }
          try { cont.click(); } catch (e) {
            resolve({ ok: false, error: "continue click threw: " + String(e) });
            return;
          }
          resolve({ ok: true, choice: "accepted", matched: recorded.optionLabel || "" });
        }, 700);
        return;
      }

      resolve({ ok: false, error: "unknown choice type: " + recorded.choice });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message) || String(e) });
    }
  });
}

// ---- Live operation status ------------------------------------------------
//
// A small popup window (status.html) polls MC_GET_STATUS every 350 ms to
// display what the extension is doing during long background operations.
// The window opens automatically at the start of each operation and closes
// itself once the operation finishes.

let _opStatus = null;        // { active, title, detail } | null
let _statusWindowId = null;  // chrome.windows id of the status popup

/** Set the current in-progress status shown in the status window. */
function setOpStatus(title, detail = "") {
  _opStatus = { active: true, title, detail };
}

/**
 * Mark the operation done. The status window will show a green check +
 * doneTitle for 3.5 s, then close itself. _opStatus is nulled after that.
 */
function clearOpStatus(doneTitle = "Done") {
  _opStatus = { active: false, title: doneTitle, detail: "" };
  setTimeout(() => {
    // Only null it out if it hasn't been replaced by a new operation.
    if (_opStatus && !_opStatus.active) _opStatus = null;
  }, 5000);
}

/** Open (or focus) the floating status window. Non-blocking — call without await. */
async function openStatusWindow() {
  // If the window is still open, just bring it to front.
  if (_statusWindowId !== null) {
    try {
      await chrome.windows.update(_statusWindowId, { focused: true });
      return;
    } catch (_e) {
      _statusWindowId = null; // window was closed by the user
    }
  }
  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL("status.html"),
      type: "popup",
      width: 400,
      height: 190,
      focused: false, // don't steal focus from the Amazon tab
    });
    _statusWindowId = win.id;
    // Null out the id when the user manually closes the window.
    const onRemoved = (wid) => {
      if (wid === _statusWindowId) {
        _statusWindowId = null;
        chrome.windows.onRemoved.removeListener(onRemoved);
      }
    };
    chrome.windows.onRemoved.addListener(onRemoved);
  } catch (_e) {
    _statusWindowId = null;
  }
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
  `*://*.${tld}/gp/cart*`,
  `*://*.${tld}/cart/*`,
  `*://*.${tld}/cart*`,
  `*://${tld}/gp/cart/*`,
  `*://${tld}/gp/cart*`,
  `*://${tld}/cart/*`,
  `*://${tld}/cart*`,
]);

function getUrlHost(url) {
  try {
    return new URL(url).hostname;
  } catch (_e) {
    return "";
  }
}

function normalizeAmazonHost(host) {
  return String(host || "")
    .toLowerCase()
    .replace(/^www\./, "");
}

function sameAmazonHost(a, b) {
  return normalizeAmazonHost(a) === normalizeAmazonHost(b);
}

function isAmazonCartUrl(url) {
  return /amazon\.[a-z.]+\/(gp\/)?cart(?:[/?#]|$)/i.test(url || "");
}

function isAmazonUrl(url) {
  return /(^|\.)amazon\.[a-z.]+\//i.test(url || "");
}

async function inferAmazonHost() {
  const [active] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (active && active.url && isAmazonUrl(active.url)) {
    return getUrlHost(active.url);
  }

  const cartTabs = await chrome.tabs.query({ url: AMAZON_CART_PATTERNS });
  if (cartTabs.length) {
    return getUrlHost(cartTabs[0].url);
  }

  return "www.amazon.com";
}

async function getActiveAmazonTab(preferredHost) {
  const [active] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!active || !active.url || !isAmazonUrl(active.url)) return null;
  if (preferredHost && !sameAmazonHost(getUrlHost(active.url), preferredHost)) {
    return null;
  }
  return active;
}

async function findAmazonCartTab(preferredHost) {
  const matchesPreferredHost = (tab) =>
    !preferredHost || sameAmazonHost(getUrlHost(tab.url), preferredHost);

  const [active] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (active && isAmazonCartUrl(active.url) && matchesPreferredHost(active)) {
    return active;
  }

  const cartTabs = await chrome.tabs.query({ url: AMAZON_CART_PATTERNS });
  if (preferredHost) {
    const matchingTab = cartTabs.find(matchesPreferredHost);
    if (matchingTab) return matchingTab;
  } else if (cartTabs.length) {
    return cartTabs[0];
  }

  // Open one.
  const host = preferredHost || "www.amazon.com";
  const tab = await chrome.tabs.create({
    url: `https://${host}/gp/cart/view.html`,
    active: true,
  });
  await waitForTabComplete(tab.id);
  try {
    return await chrome.tabs.get(tab.id);
  } catch (_e) {
    return tab;
  }
}

/**
 * Scrape the Amazon cart without navigating the user's active tab.
 *
 * Opens /gp/cart/view.html in a background tab (active: false so the user
 * stays on whatever page they're on), waits for a full load cycle with
 * waitForTabReload (never resolves prematurely on about:blank), gives
 * content.js 600 ms to register its message listener, scrapes, then
 * immediately closes the temporary tab.
 *
 * Returns the scraped cart object, or throws on failure.
 */
/**
 * Scrape the Amazon cart without navigating the user's active tab.
 *
 * Uses chrome.scripting.executeScript with the self-contained pageScrapeCart
 * function — no dependency on content.js being loaded or its message listener
 * being registered. This eliminates the race condition that caused:
 * "Cannot access contents of the page. Extension manifest must request
 * permission to access the respective host."
 *
 * Strategy:
 *   1. If the active tab or an already-open tab IS the cart → scrape directly.
 *   2. Otherwise open /gp/cart/view.html as active:false (background tab),
 *      wait for a full load cycle, scrape, then close the temp tab.
 */
async function scrapeCartInBackground(preferredHost) {
  const host = preferredHost || (await inferAmazonHost());
  const cartUrl = `https://${host}/gp/cart/view.html`;

  async function runScrape(tabId) {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageScrapeCart,
    });
    const cart = result && result[0] && result[0].result;
    if (!cart) {
      throw new Error("pageScrapeCart returned nothing.");
    }
    if (cart.error) {
      throw new Error(cart.error);
    }
    return cart;
  }

  /**
   * A scrape result is "trustworthy" only if either we found items OR the
   * page itself agrees the cart is empty (nav cart count == 0). If items
   * is empty but nav count says there ARE items, the page is either still
   * hydrating or isn't the real cart — caller should try a different tab.
   */
  function isTrustworthy(cart) {
    if (cart.items && cart.items.length > 0) return true;
    if (cart.navCartCount === 0) return true;
    return false;
  }

  // Fast path: already on the cart page.
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && isAmazonCartUrl(active.url) && sameAmazonHost(getUrlHost(active.url), host)) {
    const cart = await runScrape(active.id);
    if (isTrustworthy(cart)) return cart;
    // Active cart tab returned 0 but nav says items exist — fall through to fresh tab.
  }

  // Reuse an existing cart tab if one is open. Filter through isAmazonCartUrl
  // (regex-based, stricter than match patterns) so we don't grab tabs at URLs
  // like /cart-purchase-conditions/ that match the broad chrome.tabs.query glob.
  const existingCartTabs = await chrome.tabs.query({ url: AMAZON_CART_PATTERNS });
  const realCartTabs = existingCartTabs.filter((t) => isAmazonCartUrl(t.url));
  const existingMatch = realCartTabs.find((t) => sameAmazonHost(getUrlHost(t.url), host));
  if (existingMatch) {
    try {
      const cart = await runScrape(existingMatch.id);
      if (isTrustworthy(cart)) return cart;
      // Existing cart tab returned 0 but nav says items exist — it may be stale
      // or showing a non-cart state. Fall through to opening a fresh tab.
    } catch (_e) {
      // Existing tab failed (e.g. navigated away) — open a fresh one below.
    }
  }

  // Open a silent background tab, wait for it to fully load, scrape, close.
  // If the first scrape comes back empty but nav-cart-count indicates items,
  // wait a bit more (cart contents may be hydrating via XHR) and retry once.
  const tempTab = await chrome.tabs.create({ url: cartUrl, active: false });
  try {
    await waitForTabReload(tempTab.id, 20000);
    let cart = await runScrape(tempTab.id);
    if (!isTrustworthy(cart)) {
      // Give Amazon another 2.5 s to finish hydrating the cart panel, then retry.
      await sleep(2500);
      cart = await runScrape(tempTab.id);
    }
    return cart;
  } finally {
    try { await chrome.tabs.remove(tempTab.id); } catch (_e) { /* already closed */ }
  }
}

/**
 * Clear all active items from the Amazon cart.
 *
 * @param {string}  [preferredHost]        - Amazon host (e.g. "www.amazon.com").
 * @param {object}  [options]
 * @param {boolean} [options.returnToOrigin=false]
 *   When true, navigate the tab back to wherever the user was before the
 *   clear started (e.g. the product page they were on when they clicked
 *   "Clear cart"). Has no effect when the user was already on the cart page.
 * @param {string}  [options.originUrl]
 *   Pre-captured return URL. If omitted and returnToOrigin is true, the
 *   function queries the active tab itself.
 */
async function clearAmazonCart(preferredHost, options = {}) {
  const { returnToOrigin = false, originUrl: providedOriginUrl = null } = options;
  const host = preferredHost || (await inferAmazonHost());
  const cartUrl = `https://${host}/gp/cart/view.html`;

  const currentCount = await getActiveAmazonCartCount(host);
  if (currentCount === 0) {
    return { ok: true, removed: 0, remaining: 0, alreadyEmpty: true };
  }
  // Used in progress messages; may be null if we couldn't count remotely.
  const totalToRemove = (typeof currentCount === 'number' && currentCount > 0) ? currentCount : null;

  // Always drive the full cart page. Prefer the active Amazon tab so the user
  // sees the navigation; otherwise find or open a dedicated cart tab.
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  let tabId;

  // Capture the page to return to BEFORE navigating away from it.
  // Only meaningful when the user is on a non-cart Amazon page.
  let originUrl = providedOriginUrl;
  if (!originUrl && returnToOrigin && active && active.url &&
      isAmazonUrl(active.url) && !isAmazonCartUrl(active.url)) {
    originUrl = active.url;
  }

  if (active && active.url && isAmazonUrl(active.url)) {
    tabId = active.id;
    if (!isAmazonCartUrl(active.url) || !sameAmazonHost(getUrlHost(active.url), host)) {
      await navigateTabAndWait(tabId, cartUrl);
    }
  } else {
    const cartTabs = await chrome.tabs.query({ url: AMAZON_CART_PATTERNS });
    const match = cartTabs.find((t) => sameAmazonHost(getUrlHost(t.url), host));
    if (match) {
      tabId = match.id;
      await chrome.tabs.update(tabId, { active: true });
      await waitForTabComplete(tabId);
    } else {
      const newTab = await chrome.tabs.create({ url: cartUrl, active: true });
      await waitForTabComplete(newTab.id);
      tabId = newTab.id;
    }
  }

  // Delete items one at a time using MC_CLEAR_ONE. Amazon's cart delete is a
  // real form POST (not XHR) that reloads the page, which destroys the content
  // script mid-execution. MC_CLEAR_ONE responds BEFORE submitting the form so
  // the response is delivered before the reload. We then wait for the reload
  // and call again until the cart is empty.
  let removed = 0;

  // Show initial status on the cart tab and in the status window.
  setOpStatus("Clearing cart");
  await showStatus(tabId, 'Clearing cart…', 'loading');

  for (let attempt = 0; attempt < 50; attempt++) {
    let result;
    try {
      result = await sendToContent(tabId, { type: "MC_CLEAR_ONE" });
    } catch (_err) {
      // Message port closed before response — page navigated unexpectedly.
      // Wait for the tab to settle and try again.
      await waitForTabReload(tabId, 15000);
      // Re-show status after page reload (the old toast was destroyed).
      const retryMsg = totalToRemove
        ? `Removed ${removed} of ${totalToRemove}…`
        : `${removed} removed so far…`;
      setOpStatus("Clearing cart", retryMsg);
      await showStatus(tabId, totalToRemove
        ? `Clearing cart — removed ${removed} of ${totalToRemove}…`
        : `Clearing cart — ${removed} removed so far…`, 'loading');
      continue;
    }

    if (!result) break;
    if (result.empty) break;   // cart is now empty
    if (!result.ok) break;     // unrecoverable error

    removed++;
    // Wait for the full-page reload triggered by the form POST, then pause
    // briefly before sending the next delete.
    await waitForTabReload(tabId, 15000);
    await sleep(300);
    // Re-show status on the freshly-loaded page (previous toast was destroyed).
    const progressMsg = totalToRemove
      ? `Removed ${removed} of ${totalToRemove}…`
      : `${removed} removed so far…`;
    setOpStatus("Clearing cart", progressMsg);
    await showStatus(tabId, totalToRemove
      ? `Clearing cart — removed ${removed} of ${totalToRemove}…`
      : `Clearing cart — ${removed} removed so far…`, 'loading');
  }

  // Show completion state.
  const doneMsg = `Cart cleared — ${removed} item${removed === 1 ? '' : 's'} removed`;
  clearOpStatus(doneMsg);
  await showStatus(tabId, doneMsg, 'done');

  // Return the user to where they were before the clear started.
  if (returnToOrigin && originUrl && tabId) {
    // Pause briefly so they see the "done" flash, then navigate back.
    await sleep(1200);
    try {
      await chrome.tabs.update(tabId, { url: originUrl, active: true });
      await waitForTabReload(tabId, 15000);
      // Show the same done message on the page they're returned to.
      await showStatus(tabId, doneMsg, 'done');
    } catch (_e) { /* tab may have been closed */ }
  }

  return { ok: true, removed, remaining: 0, sawCartSurface: true };
}

async function getActiveAmazonCartCount(preferredHost) {
  const active = await getActiveAmazonTab(preferredHost);
  if (!active) return null;

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: active.id },
      func: pageGetCartCount,
    });
    const count = result && result[0] && result[0].result;
    return Number.isFinite(count) ? count : null;
  } catch (_e) {
    return null;
  }
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
 * Two restore paths are available:
 *
 *   "reliable" (restoreCart): drive each product page, click ATC, handle
 *     upsells. ~3–5s per item but works through the same UI a human uses.
 *   "quick"    (restoreCartHybrid): open Amazon's batch add page, the user
 *     clicks "Add all" once, then we verify the live cart against the
 *     saved snapshot and per-item-drive anything the batch dropped.
 *
 * The "quick" path is the default; the toggle lives in the popup and
 * persists in chrome.storage.local under `restoreMode`.
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

  // Open the helper tab on the first product. Use waitForTabReload rather than
  // navigateTabAndWait / createTabAndWait: those use exact URL matching which
  // breaks when Amazon redirects /dp/ASIN → /Product-Title/dp/ASIN. We only
  // care that the page finished loading, not its exact final URL.
  const cartLabel = savedCart.name ? `"${savedCart.name}"` : "cart";
  setOpStatus(`Restoring ${cartLabel}`, `Loading first product…`);

  const helperTab = await chrome.tabs.create({ url: productUrl(items[0]), active: true });
  await waitForTabReload(helperTab.id, 20000);

  let added = 0;
  let failed = 0;
  const failures = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      // For all items after the first, navigate the same tab and wait for
      // the next load cycle (URL-agnostic).
      if (i > 0) {
        await chrome.tabs.update(helperTab.id, { url: productUrl(item), active: true });
        await waitForTabReload(helperTab.id, 20000);
      }

      // Show per-item progress on the now-loaded product page and in the status window.
      {
        const raw = item.title || item.asin || '';
        const shortTitle = raw.length > 30 ? raw.slice(0, 28) + '…' : raw;
        setOpStatus(
          `Restoring ${cartLabel}`,
          `Item ${i + 1} of ${items.length}: ${shortTitle}`
        );
        await showStatus(
          helperTab.id,
          `Restoring cart — adding ${i + 1} of ${items.length}: ${shortTitle}`,
          'loading'
        );
      }
      await sleep(700);

      // Wire up a navigation detector BEFORE clicking. Some Amazon products
      // navigate to a confirmation or upsell page on ATC; others show an
      // in-page panel. We need to know which happened so we can wait correctly.
      // The listener must be active before the click so we can't miss the event.
      let pageNavigated = false;
      const navPromise = new Promise((resolve) => {
        let done = false;
        const finish = (v) => {
          if (done) return;
          done = true;
          chrome.tabs.onUpdated.removeListener(navListener);
          resolve(v);
        };
        const navListener = (id, info) => {
          if (id === helperTab.id && info.status === "loading") {
            pageNavigated = true;
            finish(true);
          }
        };
        chrome.tabs.onUpdated.addListener(navListener);
        // 2.5 s window — if no navigation by then, assume in-page panel.
        setTimeout(() => finish(false), 2500);
      });

      // Click the ATC button. pageAddToCart resolves immediately after the
      // click (before any page navigation can destroy the script context).
      const result = await chrome.scripting.executeScript({
        target: { tabId: helperTab.id },
        func: pageAddToCart,
        args: [Math.max(1, item.quantity || 1)],
      });
      const r = result && result[0] && result[0].result;

      if (!r || !r.ok) {
        // Genuine failure: ATC button not found or stayed disabled after retries.
        // Cancel navPromise (it will self-clean after its 2.5 s timeout).
        failed++;
        failures.push({
          asin: item.asin,
          title: item.title || "",
          reason: (r && r.error) || "ATC button not found",
        });
      } else {
        // Button was clicked. Wait to see whether Amazon navigates (confirmation
        // or upsell page) or keeps the user on the product page (slide-in panel).
        const navigated = await navPromise;

        if (navigated) {
          // Navigation detected — wait for the new page to finish loading.
          // Use waitForTabComplete (not waitForTabReload) because the page may
          // already be complete by the time navPromise resolved.
          await waitForTabComplete(helperTab.id, 12000);
        }

        // Check for upsell regardless of which path Amazon took.
        if (await isUpsellTab(helperTab.id)) {
          // First try to replay the user's previously recorded choice for
          // this ASIN (24 h TTL). Falls back to the manual prompt if no
          // recorded choice exists or the page doesn't match confidently.
          const recorded = await getRecordedUpsellChoice(item.asin);
          let autoHandled = false;
          if (recorded) {
            const ageMs = Date.now() - (recorded.recordedAt || 0);
            const ageLabel = ageMs < 60 * 60 * 1000
              ? "earlier today"
              : ageMs < 24 * 60 * 60 * 1000
                ? "recently"
                : "from before";
            const choiceDesc =
              recorded.choice === "declined"
                ? '"No coverage"'
                : `"${(recorded.optionLabel || "selected option").slice(0, 60)}"`;
            setOpStatus(
              `Restoring ${cartLabel}`,
              `Applying your choice ${ageLabel}: ${choiceDesc}…`
            );
            await showStatus(
              helperTab.id,
              `Applying your saved choice: ${choiceDesc}`,
              "loading"
            );
            autoHandled = await applyUpsellChoice(helperTab.id, recorded);
            if (autoHandled) {
              // Continue button submits a form → page navigates. Wait for it.
              await sleep(800);
              try {
                const tab = await chrome.tabs.get(helperTab.id);
                if (tab.status === "loading") {
                  await waitForTabComplete(helperTab.id, 12000);
                }
              } catch (_e) { /* tab might have closed */ }
            }
          }
          if (!autoHandled) {
            await waitForUserUpsellChoice(helperTab.id, item, host);
          }
        } else if (!navigated) {
          // In-page panel style — give Amazon a moment to register the add.
          await sleep(1200);
        }

        added++;
      }

      if (onProgress) onProgress({ done: i + 1, total: items.length });
    } catch (err) {
      // Unexpected: tab was closed mid-restore, permission error, etc.
      failed++;
      failures.push({
        asin: item.asin,
        title: item.title || "",
        reason: String(err && err.message) || String(err),
      });
      if (onProgress) onProgress({ done: i + 1, total: items.length });
    }
  }

  // Land on the cart view so the user can confirm what came through.
  try {
    await chrome.tabs.update(helperTab.id, {
      url: `https://${host}/gp/cart/view.html`,
      active: true,
    });
    await waitForTabReload(helperTab.id, 15000);
    // Show a summary on the final cart page and in the status window.
    const restoreDoneMsg = failed > 0
      ? `Cart restored — ${added} of ${items.length} added (${failed} failed)`
      : `Cart restored — ${added} item${added === 1 ? '' : 's'} added`;
    clearOpStatus(restoreDoneMsg);
    await showStatus(helperTab.id, restoreDoneMsg, added > 0 ? 'done' : 'error');
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

// ---- Hybrid restore: batch + reconciliation -------------------------------

const RESTORE_MODE_KEY = 'restoreMode';
const BATCH_CHUNK_SIZE = 50;

async function getRestoreMode() {
  try {
    const obj = await chrome.storage.local.get(RESTORE_MODE_KEY);
    return obj[RESTORE_MODE_KEY] === 'reliable' ? 'reliable' : 'quick';
  } catch (_e) {
    return 'quick';
  }
}

function chunkItems(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function buildBatchAddUrl(host, chunk) {
  const params = new URLSearchParams();
  chunk.forEach((it, idx) => {
    const n = idx + 1;
    params.set(`ASIN.${n}`, it.asin);
    params.set(`Quantity.${n}`, String(Math.max(1, it.quantity || 1)));
  });
  return `https://${host}/gp/aws/cart/add.html?${params.toString()}`;
}

/**
 * Wait for the helper tab to land on /gp/cart/view.html (i.e. the user
 * clicked "Add all" on the batch staging page and Amazon committed the
 * additions). Resolves true on land, false on timeout.
 */
function waitForCartViewLand(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(listener); } catch (_e) {}
      clearTimeout(timer);
      resolve(v);
    };
    const listener = (id, info, tab) => {
      if (id !== tabId) return;
      if (info && info.status === 'complete') {
        const url = (tab && tab.url) || '';
        if (isAmazonCartUrl(url)) finish(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * Diff a saved cart snapshot against the live cart scrape.
 *
 * @returns {{
 *   missing: object[],
 *   quantityDrift: {asin:string,title:string,expected:number,actual:number}[],
 *   possibleVariantMismatch: {asin:string,savedTitle:string,liveTitle:string}[]
 * }}
 */
function reconcileCart(savedItems, liveItems) {
  const liveByAsin = new Map();
  for (const it of liveItems || []) {
    if (it && it.asin) liveByAsin.set(it.asin, it);
  }
  const missing = [];
  const quantityDrift = [];
  const possibleVariantMismatch = [];
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  for (const saved of savedItems) {
    if (!saved || !saved.asin) continue;
    const live = liveByAsin.get(saved.asin);
    if (!live) {
      missing.push(saved);
      continue;
    }
    const expected = Math.max(1, saved.quantity || 1);
    const actual = Math.max(0, live.quantity || 0);
    if (actual !== expected) {
      quantityDrift.push({
        asin: saved.asin,
        title: saved.title || '',
        expected,
        actual,
      });
    }
    // Heuristic variant check — same ASIN can map to different listings if
    // a seller swapped contents. Compare the first ~40 chars of normalized
    // titles; surface only obvious divergence.
    const sNorm = norm(saved.title);
    const lNorm = norm(live.title);
    if (sNorm && lNorm && sNorm.slice(0, 40) !== lNorm.slice(0, 40) &&
        !sNorm.includes(lNorm.slice(0, 24)) && !lNorm.includes(sNorm.slice(0, 24))) {
      possibleVariantMismatch.push({
        asin: saved.asin,
        savedTitle: saved.title || '',
        liveTitle: live.title || '',
      });
    }
  }
  return { missing, quantityDrift, possibleVariantMismatch };
}

async function restoreCartHybrid(savedCart, onProgress) {
  const items = (savedCart.items || []).filter((it) => it && it.asin);
  if (!items.length) {
    return { ok: false, error: 'This saved cart has no items.' };
  }

  const host = savedCart.host || 'www.amazon.com';
  const cartLabel = savedCart.name ? `"${savedCart.name}"` : 'cart';
  const chunks = chunkItems(items, BATCH_CHUNK_SIZE);

  setOpStatus(
    `Restoring ${cartLabel}`,
    chunks.length === 1
      ? 'Opening Amazon batch add page…'
      : `Opening batch 1 of ${chunks.length}…`
  );

  const helperTab = await chrome.tabs.create({
    url: buildBatchAddUrl(host, chunks[0]),
    active: true,
  });

  // Walk through each batch chunk; wait for the user to click "Add all"
  // and land on /gp/cart/view.html before advancing to the next chunk.
  let batchTimedOut = false;
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) {
      setOpStatus(
        `Restoring ${cartLabel}`,
        `Opening batch ${i + 1} of ${chunks.length}…`
      );
      try {
        await chrome.tabs.update(helperTab.id, {
          url: buildBatchAddUrl(host, chunks[i]),
          active: true,
        });
      } catch (_e) {
        batchTimedOut = true;
        break;
      }
    }
    const prompt = chunks.length === 1
      ? `Click "Add all" on the Amazon page to add ${chunks[i].length} items…`
      : `Click "Add all" — batch ${i + 1} of ${chunks.length} (${chunks[i].length} items)…`;
    try { await showStatus(helperTab.id, prompt, 'loading'); } catch (_e) { /* tab may still be loading */ }

    const landed = await waitForCartViewLand(helperTab.id, 240000);
    if (!landed) {
      batchTimedOut = true;
      break;
    }
  }

  // Verification scrape on the helper tab (now on /gp/cart/view.html).
  setOpStatus(`Restoring ${cartLabel}`, 'Verifying cart contents…');
  try { await showStatus(helperTab.id, 'Verifying cart contents…', 'loading'); } catch (_e) {}

  let liveItems = [];
  if (!batchTimedOut) {
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: helperTab.id },
        func: pageScrapeCart,
      });
      const live = result && result[0] && result[0].result;
      if (live && Array.isArray(live.items)) liveItems = live.items;
    } catch (_e) {
      // Tab closed or scrape failed — treat as fully missing.
    }
  }

  const report = batchTimedOut
    ? { missing: items.slice(), quantityDrift: [], possibleVariantMismatch: [] }
    : reconcileCart(items, liveItems);

  // Per-item-drive the missing items, if any. Close the batch tab first so
  // restoreCart's own helper-tab/cart-view flow has the foreground.
  let driveAdded = 0;
  let driveFailures = [];
  if (report.missing.length) {
    setOpStatus(
      `Restoring ${cartLabel}`,
      `Per-item restore for ${report.missing.length} missing item${report.missing.length === 1 ? '' : 's'}…`
    );
    try { await chrome.tabs.remove(helperTab.id); } catch (_e) {}
    const driveCart = { ...savedCart, items: report.missing };
    const driveResult = await restoreCart(driveCart, onProgress);
    if (driveResult && driveResult.ok) {
      driveAdded = driveResult.added || 0;
      driveFailures = driveResult.failures || [];
    } else if (driveResult) {
      driveFailures = driveResult.failures || [];
    }
  }

  // Summary.
  const batchedAdded = items.length - report.missing.length;
  const totalAdded = batchedAdded + driveAdded;
  const issues = [];
  if (report.quantityDrift.length) {
    issues.push(`${report.quantityDrift.length} qty mismatch${report.quantityDrift.length === 1 ? '' : 'es'}`);
  }
  if (report.possibleVariantMismatch.length) {
    issues.push(`${report.possibleVariantMismatch.length} possible variant change${report.possibleVariantMismatch.length === 1 ? '' : 's'}`);
  }
  if (driveFailures.length) {
    issues.push(`${driveFailures.length} failed`);
  }
  const summaryHead = totalAdded >= items.length
    ? `Cart restored — ${totalAdded} of ${items.length} items`
    : `Cart restored — ${totalAdded} of ${items.length} items (some missing)`;
  const summary = issues.length ? `${summaryHead} · ${issues.join(' · ')}` : summaryHead;

  clearOpStatus(summary);
  // Show on whichever Amazon tab is foreground now.
  try {
    const [activeNow] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeNow && isAmazonUrl(activeNow.url)) {
      const kind = (issues.length || totalAdded < items.length) ? 'error' : 'done';
      await showStatus(activeNow.id, summary, kind);
    }
  } catch (_e) { /* best-effort */ }

  if (report.quantityDrift.length || report.possibleVariantMismatch.length) {
    console.info('[Styx Multi-Cart] hybrid restore reconciliation', report);
  }

  return {
    ok: true,
    total: items.length,
    added: totalAdded,
    failed: items.length - totalAdded,
    failures: driveFailures,
    quantityDrift: report.quantityDrift,
    possibleVariantMismatch: report.possibleVariantMismatch,
  };
}

async function clearThenRestoreCart(target) {
  try {
    const currentCount = await getActiveAmazonCartCount(target.host);
    if (currentCount !== 0) {
      const cleared = await clearAmazonCart(target.host);
      if (!cleared || !cleared.ok) {
        console.warn(
          "[Styx Multi-Cart] restore could not clear existing cart",
          cleared
        );
        return;
      }
      // Let Amazon's servers settle before we start adding new items,
      // so restored items don't pile on top of a cart Amazon hasn't
      // finished emptying yet. Show a transitional status during this pause.
      setOpStatus(`Restoring "${target.name || 'cart'}"`, "Preparing…");
      try {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (active && isAmazonUrl(active.url)) {
          await showStatus(active.id, 'Preparing to restore…', 'loading');
        }
      } catch (_e) { /* best-effort */ }
      await sleep(2000);
    }

    const mode = await getRestoreMode();
    if (mode === 'quick') {
      await restoreCartHybrid(target);
    } else {
      await restoreCart(target);
    }
  } catch (err) {
    console.error("[Styx Multi-Cart] restore failed", err);
  }
}

async function clearCurrentCartInBackground() {
  try {
    await clearAmazonCart(undefined, { returnToOrigin: true });
  } catch (err) {
    console.error("[Styx Multi-Cart] clear failed", err);
  }
}

async function isUpsellTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isUpsellUrl(tab.url)) return true;
  } catch (_e) {
    return false;
  }

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageHasRestoreUpsell,
    });
    return Boolean(result && result[0] && result[0].result);
  } catch (_e) {
    return false;
  }
}

async function waitForUserUpsellChoice(tabId, item, host) {
  await chrome.tabs.update(tabId, { active: true });
  let noticeShown = await showRestoreUpsellNotice(tabId, item);

  const timeoutAt = Date.now() + 10 * 60 * 1000;
  while (Date.now() < timeoutAt) {
    await sleep(1500);
    if (!noticeShown) {
      noticeShown = await showRestoreUpsellNotice(tabId, item);
    }
    if (!(await isUpsellTab(tabId))) {
      await waitForTabComplete(tabId, 15000);
      await sleep(800);
      return true;
    }
  }

  await chrome.tabs.update(tabId, {
    url: `https://${host}/gp/cart/view.html`,
    active: true,
  });
  return false;
}

async function showRestoreUpsellNotice(tabId, item) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: pageShowRestoreUpsellNotice,
      args: [item && item.title ? item.title : "this item"],
    });
    return true;
  } catch (_e) {
    // The user can still resolve the Amazon prompt directly.
    return false;
  }
}

/**
 * Inject a floating status toast into the given tab's page.
 * Best-effort — errors are swallowed so they never block the main flow.
 *
 * @param {number} tabId
 * @param {string} message
 * @param {'loading'|'done'|'error'} [type='loading']
 */
async function showStatus(tabId, message, type = 'loading') {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: pageShowStatus,
      args: [message, type],
    });
  } catch (_e) {
    // Status overlay is decorative — never block operations on failure.
  }
}

function isUpsellUrl(url) {
  return /\/gp\/.*attach|attach-warranty|warranty|protection|service-plan/i.test(
    url || ""
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs in the product page's context (via chrome.scripting.executeScript).
 * Sets the quantity if there's a quantity dropdown, clicks the page's
 * real Add-to-Cart button, and reports any protection-plan upsell so the
 * background worker can pause for the user's choice.
 *
 * Returns { ok: bool, error?, needsUserChoice? }.
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
        if (el && isVisible(el)) return el;
      }
      return null;
    };

    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const hasRestoreUpsell = () => {
      if (
        /\/gp\/.*attach|attach-warranty|warranty|protection|service-plan/i.test(
          location.href
        )
      ) {
        return true;
      }

      if (
        document.querySelector(
          "input[type='radio']#attachSiNoCoverage, " +
            "input[type='radio']#siNoCoverage, " +
            "input[type='radio'][name='attachSiCoverageName'], " +
            "input[name='submit.attach-warranty-handler-no-warranty'], " +
            "input[name='submit.attach-sidesheet-no-coverage'], " +
            "input[name='submit.add-to-cart-no-warranty']"
        )
      ) {
        return true;
      }

      const text = (document.body && document.body.innerText
        ? document.body.innerText
        : ""
      ).toLowerCase();
      return (
        (text.includes("protection plan") ||
          text.includes("protect your purchase") ||
          text.includes("warranty")) &&
        (text.includes("no thanks") ||
          text.includes("add protection") ||
          text.includes("coverage"))
      );
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

    const tryClick = (attempt) => {
      const btn = findFirst(ATC_SELECTORS);
      if (!btn) {
        if (attempt < 30) {
          setTimeout(() => tryClick(attempt + 1), 500);
        } else {
          resolve({
            ok: false,
            error: "Add to Cart button not found or not visible",
            url: location.href,
            title: document.title || "",
          });
        }
        return;
      }

      // Some buttons are disabled until the page finishes hydrating.
      if (btn.disabled || btn.getAttribute("aria-disabled") === "true") {
        if (attempt < 30) {
          setTimeout(() => tryClick(attempt + 1), 500);
          return;
        }
        resolve({
          ok: false,
          error: "Add to Cart button stayed disabled",
          url: location.href,
          title: document.title || "",
        });
        return;
      }

      setQuantity();
      try {
        btn.click();
      } catch (e) {
        resolve({ ok: false, error: "click threw: " + String(e) });
        return;
      }

      // Resolve IMMEDIATELY after the click — before yielding to the event
      // loop — so that any page navigation triggered by the click cannot
      // destroy this script's context before executeScript collects the result.
      // Post-click waiting and upsell detection are handled externally in
      // restoreCart using a pre-wired navigation monitor.
      resolve({ ok: true });
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

function pageHasRestoreUpsell() {
  if (
    /\/gp\/.*attach|attach-warranty|warranty|protection|service-plan/i.test(
      location.href
    )
  ) {
    return true;
  }

  if (
    document.querySelector(
      "input[type='radio']#attachSiNoCoverage, " +
        "input[type='radio']#siNoCoverage, " +
        "input[type='radio'][name='attachSiCoverageName'], " +
        "input[name='submit.attach-warranty-handler-no-warranty'], " +
        "input[name='submit.attach-sidesheet-no-coverage'], " +
        "input[name='submit.add-to-cart-no-warranty']"
    )
  ) {
    return true;
  }

  const text = (document.body && document.body.innerText
    ? document.body.innerText
    : ""
  ).toLowerCase();
  return (
    (text.includes("protection plan") ||
      text.includes("protect your purchase") ||
      text.includes("warranty")) &&
    (text.includes("no thanks") ||
      text.includes("add protection") ||
      text.includes("coverage"))
  );
}

function pageShowRestoreUpsellNotice(title) {
  if (window.__styxRestoreUpsellNoticeShown) return;
  window.__styxRestoreUpsellNoticeShown = true;
  setTimeout(() => {
    alert(
      `Styx paused restore for "${title}" because Amazon needs your upsell choice.\n\nChoose the option you want on this Amazon page. Styx will continue restoring the remaining items after the prompt is complete.`
    );
  }, 50);
}

/**
 * Runs in the page context via chrome.scripting.executeScript.
 * Creates or updates a floating status toast in the bottom-right corner.
 * Self-contained — no closures, no imports, no content.js dependency.
 *
 * @param {string} message
 * @param {'loading'|'done'|'error'} type
 *   loading: amber with spinner  (persists until next update)
 *   done:    green with checkmark (auto-dismisses after 4 s)
 *   error:   red with warning     (auto-dismisses after 5 s)
 */
function pageShowStatus(message, type) {
  var ID = '__styx-status-toast';
  var toast = document.getElementById(ID);
  if (!toast) {
    toast = document.createElement('div');
    toast.id = ID;
    (document.body || document.documentElement).appendChild(toast);
  }

  // Inject keyframes + animation classes once per page.
  if (!document.getElementById('__styx-kf')) {
    var s = document.createElement('style');
    s.id = '__styx-kf';
    // Three carts cycle through triangle vertices:
    //   TOP  ≈ (15.5, 10.2)   BL ≈ (7.5, 16)   BR ≈ (24.5, 16)
    // Each cart visits all 3 vertices; offset by 1/3 of the 2.4s cycle.
    s.textContent =
      '@keyframes _styxCartA{' +
        '0%,100%{transform:translate(0,0)}' +
        '33%{transform:translate(9px,5.8px)}' +
        '66%{transform:translate(-8px,5.8px)}' +
      '}' +
      '@keyframes _styxCartB{' +
        '0%,100%{transform:translate(0,0)}' +
        '33%{transform:translate(8px,-5.8px)}' +
        '66%{transform:translate(17px,0)}' +
      '}' +
      '@keyframes _styxCartC{' +
        '0%,100%{transform:translate(0,0)}' +
        '33%{transform:translate(-17px,0)}' +
        '66%{transform:translate(-9px,-5.8px)}' +
      '}' +
      '.__styx-toast-loading .__styx-cart-a{animation:_styxCartA 2.4s ease-in-out infinite;transform-box:fill-box;transform-origin:center}' +
      '.__styx-toast-loading .__styx-cart-b{animation:_styxCartB 2.4s ease-in-out infinite;transform-box:fill-box;transform-origin:center}' +
      '.__styx-toast-loading .__styx-cart-c{animation:_styxCartC 2.4s ease-in-out infinite;transform-box:fill-box;transform-origin:center}' +
      '@keyframes _styxFadeIn{from{opacity:0;transform:translate(-50%,-50%) scale(.6)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}';
    (document.head || document.body || document.documentElement).appendChild(s);
  }

  var accent = type === 'done' ? '#34d399' : type === 'error' ? '#ef4444' : '#ff9900';
  var glowRgb = type === 'done' ? '52,211,153' : type === 'error' ? '239,68,68' : '255,153,0';

  var ts = toast.style;
  ts.position = 'fixed'; ts.top = '24px'; ts.left = '50%';
  ts.transform = 'translateX(-50%)'; ts.bottom = ''; ts.right = '';
  ts.zIndex = '2147483647';
  ts.display = 'flex'; ts.alignItems = 'center'; ts.gap = '14px';
  ts.padding = '16px 22px'; ts.borderRadius = '14px';
  ts.border = '1px solid ' + accent;
  ts.background = '#131a22'; ts.color = '#ffffff';
  ts.fontFamily = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
  ts.fontSize = '18px'; ts.fontWeight = '600'; ts.lineHeight = '1.35';
  ts.boxShadow = '0 0 0 1px ' + accent + ', 0 0 24px rgba(' + glowRgb + ',.35), 0 6px 24px rgba(0,0,0,.45)';
  ts.maxWidth = '520px'; ts.width = ''; ts.pointerEvents = 'none';
  ts.opacity = '1'; ts.transition = 'opacity .2s, box-shadow .25s, border-color .25s';

  toast.className = type === 'loading' ? '__styx-toast-loading' : '';

  if (toast._styxTimer) { clearTimeout(toast._styxTimer); toast._styxTimer = null; }

  // Styx logo (carts + river) — copied from popup.html, with class hooks
  // on each cart's <g> and its wheels for the cycling animation.
  var logoSvg =
    '<svg width="36" height="36" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block">' +
      '<rect width="32" height="32" rx="7" fill="#131a22"/>' +
      // Top cart (apex)
      '<g class="__styx-cart-a">' +
        '<g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none">' +
          '<path d="M12 8.6 L19 8.6 L18.3 11.8 L12.7 11.8 Z"/>' +
          '<path d="M12 8.6 L10.5 7.3"/>' +
        '</g>' +
        '<circle cx="13.7" cy="13.3" r="0.9" fill="#ff9900"/>' +
        '<circle cx="17.3" cy="13.3" r="0.9" fill="#ff9900"/>' +
      '</g>' +
      // Bottom-left cart
      '<g class="__styx-cart-b">' +
        '<g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none">' +
          '<path d="M4 14.4 L11 14.4 L10.3 17.6 L4.7 17.6 Z"/>' +
          '<path d="M4 14.4 L2.5 13.1"/>' +
        '</g>' +
        '<circle cx="5.9" cy="19.1" r="0.9" fill="#ff9900"/>' +
        '<circle cx="9.1" cy="19.1" r="0.9" fill="#ff9900"/>' +
      '</g>' +
      // Bottom-right cart
      '<g class="__styx-cart-c">' +
        '<g stroke="#ff9900" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none">' +
          '<path d="M21 14.4 L28 14.4 L27.3 17.6 L21.7 17.6 Z"/>' +
          '<path d="M21 14.4 L19.5 13.1"/>' +
        '</g>' +
        '<circle cx="22.9" cy="19.1" r="0.9" fill="#ff9900"/>' +
        '<circle cx="26.1" cy="19.1" r="0.9" fill="#ff9900"/>' +
      '</g>' +
      // River Styx
      '<path d="M0 19.8 Q 4 18.4, 8 19.8 T 16 19.8 T 24 19.8 T 32 19.8 L 32 32 L 0 32 Z" fill="#1a3a5c" opacity="0.55"/>' +
      '<path d="M0 19.8 Q 4 18.4, 8 19.8 T 16 19.8 T 24 19.8 T 32 19.8" stroke="#5db5ff" stroke-width="1" fill="none" stroke-linecap="round"/>' +
      '<path d="M0 23 Q 4 22, 8 23 T 16 23 T 24 23 T 32 23" stroke="#5db5ff" stroke-width="0.8" fill="none" stroke-linecap="round" opacity="0.55"/>' +
      '<path d="M0 25.9 Q 4 25, 8 25.9 T 16 25.9 T 24 25.9 T 32 25.9" stroke="#5db5ff" stroke-width="0.7" fill="none" stroke-linecap="round" opacity="0.38"/>' +
      '<path d="M0 28.5 Q 4 27.8, 8 28.5 T 16 28.5 T 24 28.5 T 32 28.5" stroke="#5db5ff" stroke-width="0.6" fill="none" stroke-linecap="round" opacity="0.25"/>' +
    '</svg>';

  // Apex overlay glyph for done/error states.
  var overlay = '';
  if (type === 'done') {
    overlay =
      '<div style="position:absolute;left:50%;top:32%;width:18px;height:18px;transform:translate(-50%,-50%) scale(1);' +
        'background:#34d399;border-radius:50%;display:flex;align-items:center;justify-content:center;' +
        'box-shadow:0 0 8px rgba(52,211,153,.7);animation:_styxFadeIn .2s ease-out">' +
        '<svg width="12" height="12" viewBox="0 0 21 21" fill="none"><path d="M3 10.5L8.5 16L18 5" stroke="#0b1a14" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '</div>';
  } else if (type === 'error') {
    overlay =
      '<div style="position:absolute;left:50%;top:32%;width:18px;height:18px;transform:translate(-50%,-50%) scale(1);' +
        'background:#ef4444;border-radius:50%;display:flex;align-items:center;justify-content:center;' +
        'color:#fff;font-size:13px;font-weight:800;line-height:1;' +
        'box-shadow:0 0 8px rgba(239,68,68,.7);animation:_styxFadeIn .2s ease-out">!</div>';
  }

  var icon = document.createElement('div');
  icon.style.cssText = 'position:relative;flex-shrink:0;width:36px;height:36px';
  icon.innerHTML = logoSvg + overlay;

  var span = document.createElement('span');
  span.style.cssText =
    'flex:1;min-width:0;word-break:break-word;overflow-wrap:anywhere;' +
    'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden';
  span.textContent = message;

  toast.innerHTML = '';
  toast.appendChild(icon);
  toast.appendChild(span);

  var delay = type === 'done' ? 4000 : type === 'error' ? 5000 : 0;
  if (delay) {
    toast._styxTimer = setTimeout(function() {
      toast.style.opacity = '0';
      setTimeout(function() { try { toast.remove(); } catch(_) {} }, 250);
    }, delay);
  }
}

function pageGetCartCount() {
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

/**
 * Runs inside the cart page context via chrome.scripting.executeScript.
 * Self-contained — no closures, no imports, no content.js dependency.
 * Returns { host, capturedAt, items[] } in the same shape as scrapeCart()
 * in content.js, or { error } on failure.
 */
async function pageScrapeCart() {
  // Trigger Amazon's IntersectionObserver so it loads real image URLs.
  // Dispatching scroll/resize causes Amazon's IO to re-evaluate element
  // visibility and fire its callback, which replaces the spinner src with
  // the real CDN URL. This works even in background (hidden) tabs.
  window.dispatchEvent(new Event("scroll"));
  window.dispatchEvent(new Event("resize"));
  await new Promise((r) => setTimeout(r, 700));

  try {
    function pickBestImg(row) {
      // Amazon's cart has two <img> elements per row:
      //   1. A spinner overlay inside .sc-list-item-spinner (comes first in DOM)
      //   2. The real product image: img.sc-product-image (inside a.sc-product-link)
      // Always prefer img.sc-product-image; never fall back to the spinner img.
      function isUsable(img) {
        if (!img) return false;
        if (img.closest(".sc-list-item-spinner")) return false;
        const s = img.currentSrc || img.src || "";
        return s && !s.startsWith("data:") && !s.includes("loadIndicators") && !s.includes("transparent-pixel");
      }

      // Best candidate: the explicit product image element.
      let img = row.querySelector("img.sc-product-image");
      if (!img || !isUsable(img)) {
        // Fallback: first non-spinner img with a real URL.
        img = Array.from(row.querySelectorAll("img")).find(isUsable) || null;
      }
      if (!img) return "";

      // Prefer data-a-dynamic-image (largest variant) if present.
      const dyn = img.getAttribute("data-a-dynamic-image");
      if (dyn) {
        try {
          const map = JSON.parse(dyn);
          const urls = Object.keys(map);
          if (urls.length) {
            let best = urls[0], bestArea = 0;
            for (const u of urls) {
              const d = map[u] || [0, 0];
              const a = (d[0] || 0) * (d[1] || 0);
              if (a > bestArea) { bestArea = a; best = u; }
            }
            return best;
          }
        } catch (_e) { /* fall through */ }
      }
      // currentSrc is higher-res (from srcset negotiation) when available.
      if (img.currentSrc && !img.currentSrc.includes("loadIndicators")) return img.currentSrc;
      const src = img.src || "";
      return isUsable(img) ? src : "";
    }

    // Read the nav cart count (the badge on the cart icon in the header).
    // This is the source of truth for whether the cart has items — if it
    // says > 0 but we find 0 rows, the page isn't really the cart or hasn't
    // finished hydrating, and the caller knows to retry / try another tab.
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

    // Try selectors from most specific (typed active rows) to most permissive,
    // so legitimate cart layouts that don't have the data-itemtype attribute
    // still match. Stop at the first selector that finds any rows.
    let rows = activeScope.querySelectorAll(
      "div[data-asin][data-itemtype='active'], li[data-asin][data-itemtype='active']"
    );
    if (!rows.length) {
      rows = activeScope.querySelectorAll(
        "div[data-asin].sc-list-item, li[data-asin].sc-list-item, li[data-asin].ewc-item"
      );
    }
    if (!rows.length) {
      // Last-ditch: any element carrying a real ASIN that isn't explicitly
      // marked as Save-For-Later. Filtering happens in the loop below.
      rows = activeScope.querySelectorAll("[data-asin]");
    }

    const items = [];
    const seen = new Set();

    rows.forEach((row) => {
      const asin = row.getAttribute("data-asin");
      if (!asin || seen.has(asin)) return;
      // Skip Save For Later items
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

// ---- Message router -------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  (async () => {
    try {
      switch (msg.type) {
        case "MC_GET_STATUS": {
          sendResponse(_opStatus || { active: false, title: "", detail: "" });
          break;
        }

        case "MC_GET_RESTORE_MODE": {
          const mode = await getRestoreMode();
          sendResponse({ ok: true, mode });
          break;
        }

        case "MC_SET_RESTORE_MODE": {
          const mode = msg.mode === 'reliable' ? 'reliable' : 'quick';
          await chrome.storage.local.set({ [RESTORE_MODE_KEY]: mode });
          sendResponse({ ok: true, mode });
          break;
        }

        case "MC_OBSERVE_ATC": {
          // observer.js detected an Add-to-Cart click on a product page.
          // Stash it keyed by tab id so we can link the upcoming upsell choice.
          prunePendingAtc();
          const tabId = _sender && _sender.tab && _sender.tab.id;
          if (tabId != null && msg.asin) {
            _pendingAtc.set(tabId, {
              asin: String(msg.asin).toUpperCase(),
              title: msg.title || "",
              host: msg.host || "",
              at: Date.now(),
            });
          }
          sendResponse({ ok: true });
          break;
        }

        case "MC_OBSERVE_UPSELL_CHOICE": {
          // observer.js detected a decline or accept on an upsell surface.
          // Link it back to the most recent ATC for this tab and record it.
          prunePendingAtc();
          const tabId = _sender && _sender.tab && _sender.tab.id;
          let pending = tabId != null ? _pendingAtc.get(tabId) : null;
          if (!pending) {
            // Fallback: the upsell may be in a different tab than the ATC
            // (rare but possible with sidesheet flows). Use the newest pending.
            let newest = null;
            for (const p of _pendingAtc.values()) {
              if (!newest || p.at > newest.at) newest = p;
            }
            pending = newest;
          }
          if (pending && pending.asin) {
            await recordUpsellChoice(pending.asin, {
              choice: msg.choice,
              optionLabel: msg.optionLabel || "",
              optionPrice: msg.optionPrice || "",
              optionDuration: msg.optionDuration || null,
              productHost: pending.host,
              productTitle: pending.title,
            });
            if (tabId != null) _pendingAtc.delete(tabId);
          }
          sendResponse({ ok: true });
          break;
        }

        case "MC_DIAGNOSE_CART": {
          // Navigate to the cart page (same path as clearAmazonCart) then
          // ask the content script for a diagnostic snapshot.
          const host = await inferAmazonHost();
          const cartUrl = `https://${host}/gp/cart/view.html`;
          const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
          let diagTabId;
          if (active && active.url && isAmazonUrl(active.url)) {
            diagTabId = active.id;
            if (!isAmazonCartUrl(active.url)) {
              await chrome.tabs.update(diagTabId, { url: cartUrl, active: true });
              await waitForTabComplete(diagTabId);
            }
          } else {
            const cartTabs = await chrome.tabs.query({ url: AMAZON_CART_PATTERNS });
            if (cartTabs.length) {
              diagTabId = cartTabs[0].id;
              await chrome.tabs.update(diagTabId, { active: true });
              await waitForTabComplete(diagTabId);
            } else {
              const t = await chrome.tabs.create({ url: cartUrl, active: true });
              await waitForTabComplete(t.id);
              diagTabId = t.id;
            }
          }
          const result = await sendToContent(diagTabId, { type: "MC_DIAGNOSE_CART" });
          sendResponse(result || { ok: false, error: "No response" });
          break;
        }

        case "MC_LIST_CARTS": {
          const carts = await readCarts();
          sendResponse({ ok: true, carts });
          break;
        }

        case "MC_SAVE_CURRENT": {
          // Scrape the cart from a background tab so the user doesn't have to
          // be on the cart page. scrapeCartInBackground reuses an existing cart
          // tab if one is open, or opens /gp/cart/view.html silently and closes
          // it when done — the user stays on their current page throughout.
          let cart;
          try {
            cart = await scrapeCartInBackground();
          } catch (scrapeErr) {
            sendResponse({
              ok: false,
              error: (scrapeErr && scrapeErr.message) || "Could not read the Amazon cart page.",
            });
            break;
          }
          if (!cart.items.length) {
            sendResponse({
              ok: false,
              error: "Your Amazon cart looks empty — nothing to save.",
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
          setOpStatus(`Restoring "${target.name || 'cart'}"`, "Starting…");
          openStatusWindow(); // non-blocking — don't await
          setTimeout(() => clearThenRestoreCart(target), 0);
          break;
        }

        case "MC_CLEAR_CURRENT": {
          const currentCount = await getActiveAmazonCartCount();
          if (currentCount === 0) {
            sendResponse({ ok: true, alreadyEmpty: true });
            break;
          }

          // Acknowledge immediately — navigation + deletion can take several
          // seconds and opening a tab may close the popup, which would drop
          // the response and leave the button spinner stuck forever.
          sendResponse({ ok: true, started: true });
          setOpStatus("Clearing cart", "Starting…");
          openStatusWindow(); // non-blocking — don't await
          setTimeout(clearCurrentCartInBackground, 0);
          break;
        }

        case "MC_SAVE_AND_CLEAR": {
          // Convenience: scrape + save synchronously (using background tab so
          // the user doesn't need to be on the cart page), then clear in the
          // background (fire-and-forget) so the message channel stays open.

          // Capture the origin page NOW, before scraping, so we can return
          // the user to it after the cart is cleared (scraping may take a few
          // seconds and open/close background tabs).
          const [scOriginTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const scOriginUrl = (scOriginTab && scOriginTab.url &&
            isAmazonUrl(scOriginTab.url) && !isAmazonCartUrl(scOriginTab.url))
            ? scOriginTab.url : null;

          let scCart;
          try {
            scCart = await scrapeCartInBackground();
          } catch (scrapeErr) {
            sendResponse({
              ok: false,
              error: (scrapeErr && scrapeErr.message) || "Cart appears empty — nothing to save.",
            });
            break;
          }
          if (!scCart.items.length) {
            sendResponse({ ok: false, error: "Cart appears empty — nothing to save." });
            break;
          }
          const carts = await readCarts();
          carts.unshift({
            id: makeId(),
            name: msg.name || "Untitled cart",
            host: scCart.host,
            savedAt: scCart.capturedAt,
            items: scCart.items,
          });
          await writeCarts(carts);
          // Respond immediately so the popup spinner clears; the actual cart
          // clearing happens in the background via clearAmazonCart().
          const savedCount = scCart.items.length;
          const savedHost = scCart.host;
          sendResponse({ ok: true, saved: savedCount, removed: "pending" });
          setOpStatus("Clearing cart", `Saved — now clearing ${savedCount} item${savedCount === 1 ? '' : 's'}…`);
          openStatusWindow(); // non-blocking — don't await
          setTimeout(() => clearAmazonCart(savedHost, {
            returnToOrigin: true,
            originUrl: scOriginUrl,
          }), 0);
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

async function waitForTabComplete(tabId, timeoutMs = 45000) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
  } catch (_e) {
    return;
  }

  return new Promise((resolve) => {
    let done = false;
    let timer = null;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removedListener);
      resolve();
    };

    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        finish();
      }
    };

    const removedListener = (id) => {
      if (id === tabId) finish();
    };

    timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removedListener);
  });
}

async function createTabAndWait(url, timeoutMs = 45000) {
  const tab = await chrome.tabs.create({ url, active: true });
  await waitForTabNavigation(tab.id, url, timeoutMs);
  return tab;
}

async function navigateTabAndWait(tabId, url, timeoutMs = 45000) {
  await chrome.tabs.update(tabId, { url, active: true });
  await waitForTabNavigation(tabId, url, timeoutMs);
}

async function waitForTabNavigation(tabId, targetUrl, timeoutMs = 45000) {
  const target = normalizeUrlForWait(targetUrl);

  return new Promise((resolve) => {
    let done = false;
    let timer = null;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removedListener);
      resolve();
    };

    const matchesTarget = (url) => {
      if (!url) return false;
      const current = normalizeUrlForWait(url);
      return current === target || current.startsWith(target + "?");
    };

    const listener = (id, info, tab) => {
      if (id !== tabId) return;
      if ((info.status === "complete" || tab.status === "complete") && matchesTarget(tab.url)) {
        finish();
      }
    };

    const removedListener = (id) => {
      if (id === tabId) finish();
    };

    timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removedListener);

    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete" && matchesTarget(tab.url)) finish();
      })
      .catch(finish);
  });
}

/**
 * Wait for the tab to go through a loading→complete cycle (i.e. a page reload
 * or navigation). Unlike waitForTabComplete, this will NOT resolve immediately
 * if the tab is already complete — it waits for the NEXT load.
 *
 * Also handles the race where the tab started loading before we set up the
 * listener: we check the current status immediately after attaching and mark
 * sawLoading=true if the tab is already in the "loading" state.
 */
async function waitForTabReload(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let sawLoading = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removedListener);
      resolve();
    };

    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === "loading") sawLoading = true;
      if (info.status === "complete" && sawLoading) finish();
    };

    const removedListener = (id) => {
      if (id === tabId) finish();
    };

    timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removedListener);

    // Check immediately in case loading already started before our listener attached.
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "loading") {
        sawLoading = true; // already loading — next "complete" event will finish us
      }
    }).catch(finish);
  });
}

function normalizeUrlForWait(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href.replace(/\/$/, "");
  } catch (_e) {
    return String(url || "").replace(/#.*$/, "").replace(/\/$/, "");
  }
}
