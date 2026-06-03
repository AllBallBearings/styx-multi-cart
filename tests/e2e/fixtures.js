/**
 * Playwright test fixtures for the extension popup.
 *
 * Provides:
 *   - `context`: a persistent Chromium context with the unpacked extension
 *                loaded from the repo root.
 *   - `extensionId`: discovered by waiting for the MV3 service worker to
 *                    register, then parsing its URL.
 *   - `popup`: a Page already navigated to `popup.html` with a fake
 *              chrome.runtime.sendMessage backend installed via initScript
 *              before popup.js runs. Tests interact with the popup as a
 *              user would; the fake backend replays canned responses so we
 *              don't need a live Amazon tab to exercise the UI.
 */

import { test as base, chromium, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");

/**
 * Build the init-script source that runs inside the popup before popup.js.
 * We stub:
 *   - chrome.runtime.sendMessage — backed by an in-page state map keyed by
 *     message.type. Mirrors enough of the real background router to drive
 *     popup behavior end-to-end.
 *   - chrome.storage.local         — in-memory store so theme persistence
 *     and the popup's direct reads (mc.settings.v1) work.
 *
 * `initial` is a serializable object passed in to seed both stores. Shape:
 *   { carts: [...], settings: { interceptAtc, restoring, theme } }
 */
function buildInitScript(initial) {
  const seed = JSON.stringify(initial || {});

  // The script runs in the popup page context with chrome.runtime/storage
  // already present (because it's an extension page). We replace specific
  // methods rather than the whole chrome object so unaffected APIs keep
  // working.
  return `
    (function () {
      const seed = ${seed};
      const STORAGE_KEY = "mc.carts.v1";
      const SETTINGS_KEY = "mc.settings.v1";

      // In-memory backend state.
      const store = {
        [STORAGE_KEY]: Array.isArray(seed.carts) ? seed.carts : [],
        [SETTINGS_KEY]: Object.assign(
          {
            interceptAtc: true,
            restoring: false,
          },
          seed.settings || {}
        ),
      };

      // Expose for test-side assertions / mutations via Page.evaluate.
      window.__mcTestState = store;
      window.__mcMessageLog = [];
      const storageListeners = [];

      function makeId() {
        return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      }

      // ---- chrome.runtime.sendMessage fake -----------------------------
      chrome.runtime.sendMessage = function (message, callback) {
        window.__mcMessageLog.push(message);
        const respond = (response) => {
          if (typeof callback === "function") {
            // Mimic real MV3 timing — never synchronous.
            setTimeout(() => callback(response), 0);
          }
        };
        if (!message || typeof message !== "object") {
          respond({ ok: false, error: "bad message" });
          return;
        }
        switch (message.type) {
          case "MC_LIST_CARTS":
            respond({ ok: true, carts: store[STORAGE_KEY].slice() });
            return;

          case "MC_GET_INTERCEPT":
            respond({ ok: true, enabled: !!store[SETTINGS_KEY].interceptAtc });
            return;

          case "MC_SET_INTERCEPT":
            store[SETTINGS_KEY].interceptAtc = !!message.enabled;
            respond({ ok: true });
            return;

          case "MC_SAVE_CURRENT": {
            const cart = {
              id: makeId(),
              name: String(message.name || "Untitled"),
              savedAt: new Date().toISOString(),
              host: "www.amazon.com",
              items: [
                { asin: "B000FAKE01", title: "Fake Item 1", quantity: 2, price: "$9.99", image: "", url: "" },
                { asin: "B000FAKE02", title: "Fake Item 2", quantity: 1, price: "$3.00", image: "", url: "" },
              ],
            };
            store[STORAGE_KEY].push(cart);
            respond({ ok: true, cart });
            return;
          }

          case "MC_CREATE_EMPTY_CART": {
            const cart = {
              id: makeId(),
              name: String(message.name || "Untitled"),
              savedAt: new Date().toISOString(),
              host: String(message.host || "www.amazon.com"),
              items: [],
            };
            store[STORAGE_KEY].push(cart);
            respond({ ok: true, cart });
            return;
          }

          case "MC_RENAME_CART": {
            const c = store[STORAGE_KEY].find((c) => c.id === message.id);
            if (!c) { respond({ ok: false, error: "not found" }); return; }
            c.name = String(message.name || c.name);
            respond({ ok: true, cart: c });
            return;
          }

          case "MC_DELETE_CART": {
            const idx = store[STORAGE_KEY].findIndex((c) => c.id === message.id);
            if (idx === -1) { respond({ ok: false, error: "not found" }); return; }
            store[STORAGE_KEY].splice(idx, 1);
            respond({ ok: true });
            return;
          }

          case "MC_REMOVE_ITEM_FROM_CART": {
            const c = store[STORAGE_KEY].find((c) => c.id === message.id);
            if (!c) { respond({ ok: false, error: "not found" }); return; }
            const before = Array.isArray(c.items) ? c.items.length : 0;
            c.items = (c.items || []).filter((it) => it.asin !== message.asin);
            if (c.items.length === before) { respond({ ok: false, error: "item not found" }); return; }
            if (c.items.length === 0) {
              const idx = store[STORAGE_KEY].findIndex((cart) => cart.id === message.id);
              if (idx >= 0) store[STORAGE_KEY].splice(idx, 1);
              respond({ ok: true, cartDeleted: true });
              return;
            }
            respond({ ok: true, remaining: c.items.length });
            return;
          }

          case "MC_MOVE_ITEM_BETWEEN_CARTS": {
            const source = store[STORAGE_KEY].find((c) => c.id === message.sourceId);
            const target = store[STORAGE_KEY].find((c) => c.id === message.targetId);
            if (!source || !target) { respond({ ok: false, error: "not found" }); return; }
            const moving = (source.items || []).find((it) => it.asin === message.asin);
            if (!moving) { respond({ ok: false, error: "item not found" }); return; }
            source.items = (source.items || []).filter((it) => it.asin !== message.asin);
            target.items = Array.isArray(target.items) ? target.items : [];
            const existing = target.items.find((it) => it.asin === moving.asin);
            let action;
            if (existing) {
              existing.quantity = Math.max(Number(existing.quantity) || 1, Number(moving.quantity) || 1);
              action = "merged";
            } else {
              target.items.unshift(Object.assign({}, moving));
              action = "added";
            }
            let sourceDeleted = false;
            if (source.items.length === 0) {
              const idx = store[STORAGE_KEY].findIndex((c) => c.id === source.id);
              if (idx >= 0) store[STORAGE_KEY].splice(idx, 1);
              sourceDeleted = true;
            }
            respond({
              ok: true,
              action,
              sourceDeleted,
              sourceName: source.name,
              targetName: target.name,
              itemTitle: moving.title || moving.asin,
              targetCount: target.items.length,
            });
            return;
          }

          case "MC_UPDATE_ITEM_QUANTITY": {
            const c = store[STORAGE_KEY].find((c) => c.id === message.id);
            if (!c) { respond({ ok: false, error: "not found" }); return; }
            const item = (c.items || []).find((it) => it.asin === message.asin);
            if (!item) { respond({ ok: false, error: "item not found" }); return; }
            const qty = Math.max(1, Math.min(99, Number(message.quantity) || 1));
            item.quantity = qty;
            respond({ ok: true, quantity: qty });
            return;
          }

          case "MC_RESTORE_CART": {
            const c = store[STORAGE_KEY].find((c) => c.id === message.id);
            if (!c) { respond({ ok: false, error: "not found" }); return; }
            respond({ ok: true, total: (c.items || []).length });
            return;
          }

          case "MC_CLEAR_CURRENT":
            respond({ ok: true, cleared: 0 });
            return;

          case "MC_SAVE_AND_CLEAR": {
            const cart = {
              id: makeId(),
              name: String(message.name || "Untitled"),
              savedAt: new Date().toISOString(),
              host: "www.amazon.com",
              items: [{ asin: "B000FAKE03", title: "X", quantity: 1, price: "", image: "", url: "" }],
            };
            store[STORAGE_KEY].push(cart);
            respond({ ok: true, cart, cleared: 1 });
            return;
          }

          default:
            respond({ ok: false, error: "unhandled message type: " + message.type });
        }
      };

      // ---- chrome.storage.local fake -----------------------------------
      // The popup only reaches for chrome.storage.local directly for the
      // theme setting; everything else routes through sendMessage. We keep
      // this minimal so the surface is obvious.
      chrome.storage.local.get = function (keyOrKeys) {
        if (keyOrKeys == null) return Promise.resolve(Object.assign({}, store));
        if (typeof keyOrKeys === "string") {
          return Promise.resolve(
            Object.prototype.hasOwnProperty.call(store, keyOrKeys)
              ? { [keyOrKeys]: store[keyOrKeys] }
              : {}
          );
        }
        if (Array.isArray(keyOrKeys)) {
          const out = {};
          for (const k of keyOrKeys) if (k in store) out[k] = store[k];
          return Promise.resolve(out);
        }
        const out = {};
        for (const [k, def] of Object.entries(keyOrKeys)) {
          out[k] = k in store ? store[k] : def;
        }
        return Promise.resolve(out);
      };
      chrome.storage.local.set = function (obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: store[k], newValue: v };
          store[k] = v;
        }
        if (Object.keys(changes).length) {
          setTimeout(() => {
            for (const listener of storageListeners) {
              try { listener(changes, "local"); } catch (_e) {}
            }
          }, 0);
        }
        return Promise.resolve();
      };
      chrome.storage.onChanged.addListener = function (listener) {
        storageListeners.push(listener);
      };
      chrome.storage.onChanged.removeListener = function (listener) {
        const idx = storageListeners.indexOf(listener);
        if (idx >= 0) storageListeners.splice(idx, 1);
      };
    })();
  `;
}

export const test = base.extend({
  // Persistent context with the unpacked extension loaded.
  context: async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "styx-pw-"));
    // MV3 service workers don't register under chromium-headless-shell, so we
    // must use the full chromium channel. Playwright 1.49 supports running
    // extensions under the new headless mode when `channel: 'chromium'` is set.
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${REPO_ROOT}`,
        `--load-extension=${REPO_ROOT}`,
        "--no-sandbox",
      ],
    });
    await use(context);
    await context.close();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch (_e) {
      /* best-effort cleanup */
    }
  },

  // The MV3 service worker registers shortly after launch; its URL gives us
  // the extension ID. Headless Chromium with --load-extension can take a
  // beat to come up, so we wait up to a few seconds.
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker");
    const url = worker.url();
    const match = url.match(/^chrome-extension:\/\/([a-z0-9]+)\//i);
    if (!match) throw new Error("Could not parse extension ID from " + url);
    await use(match[1]);
  },

  // Provided to tests as a factory: call `await popup({ carts, settings })`
  // to open popup.html with seeded state and the backend stub installed.
  popup: async ({ context, extensionId }, use) => {
    async function openPopup(initial) {
      const page = await context.newPage();
      // Run the stub BEFORE popup.js evaluates. addInitScript fires on every
      // load for this page, including the first navigation.
      await page.addInitScript(buildInitScript(initial));
      await page.goto(`chrome-extension://${extensionId}/popup.html`);
      // Wait until the popup's first refresh() finished — the list count
      // element is the cheapest signal that initial render happened.
      await page.waitForSelector("#mc-list-count");
      return page;
    }
    await use(openPopup);
  },
});

export { expect };
