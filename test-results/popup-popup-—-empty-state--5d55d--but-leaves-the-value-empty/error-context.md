# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: popup.spec.js >> popup — empty state >> shows a placeholder on the name field but leaves the value empty
- Location: tests/e2e/popup.spec.js:23:3

# Error details

```
Error: browserType.launchPersistentContext: Target page, context or browser has been closed
Browser logs:

<launching> /Users/jaredgoolsby/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --disable-field-trial-config --disable-background-networking --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-back-forward-cache --disable-breakpad --disable-client-side-phishing-detection --disable-component-extensions-with-background-pages --disable-component-update --no-default-browser-check --disable-default-apps --disable-dev-shm-usage --disable-edgeupdater --disable-extensions --disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion --enable-features=CDPScreenshotNewSurface --allow-pre-commit-input --disable-hang-monitor --disable-ipc-flooding-protection --disable-popup-blocking --disable-prompt-on-repost --disable-renderer-backgrounding --force-color-profile=srgb --metrics-recording-only --no-first-run --password-store=basic --use-mock-keychain --no-service-autorun --export-tagged-pdf --disable-search-engine-choice-screen --unsafely-disable-devtools-self-xss-warnings --edge-skip-compat-layer-relaunch --disable-infobars --disable-search-engine-choice-screen --disable-sync --enable-unsafe-swiftshader --headless --hide-scrollbars --mute-audio --blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4 --no-sandbox --disable-extensions-except=/Users/jaredgoolsby/Documents/Github/styx-multi-cart --load-extension=/Users/jaredgoolsby/Documents/Github/styx-multi-cart --no-sandbox --user-data-dir=/var/folders/3z/n_wtd9b94gx3hq81wrs459dh0000gn/T/styx-pw-cAN0Op --remote-debugging-pipe about:blank
<launched> pid=32067
Call log:
  - <launching> /Users/jaredgoolsby/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --disable-field-trial-config --disable-background-networking --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-back-forward-cache --disable-breakpad --disable-client-side-phishing-detection --disable-component-extensions-with-background-pages --disable-component-update --no-default-browser-check --disable-default-apps --disable-dev-shm-usage --disable-edgeupdater --disable-extensions --disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion --enable-features=CDPScreenshotNewSurface --allow-pre-commit-input --disable-hang-monitor --disable-ipc-flooding-protection --disable-popup-blocking --disable-prompt-on-repost --disable-renderer-backgrounding --force-color-profile=srgb --metrics-recording-only --no-first-run --password-store=basic --use-mock-keychain --no-service-autorun --export-tagged-pdf --disable-search-engine-choice-screen --unsafely-disable-devtools-self-xss-warnings --edge-skip-compat-layer-relaunch --disable-infobars --disable-search-engine-choice-screen --disable-sync --enable-unsafe-swiftshader --headless --hide-scrollbars --mute-audio --blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4 --no-sandbox --disable-extensions-except=/Users/jaredgoolsby/Documents/Github/styx-multi-cart --load-extension=/Users/jaredgoolsby/Documents/Github/styx-multi-cart --no-sandbox --user-data-dir=/var/folders/3z/n_wtd9b94gx3hq81wrs459dh0000gn/T/styx-pw-cAN0Op --remote-debugging-pipe about:blank
  - <launched> pid=32067
  - [pid=32067] <gracefully close start>
  - [pid=32067] <kill>
  - [pid=32067] <will force kill>
  - [pid=32067] exception while trying to kill process: Error: kill EPERM
  - [pid=32067] <process did exit: exitCode=null, signal=SIGABRT>
  - [pid=32067] starting temporary directories cleanup
  - [pid=32067] finished temporary directories cleanup
  - [pid=32067] <gracefully close end>

```

# Test source

```ts
  191 |             return;
  192 |           }
  193 | 
  194 |           case "MC_UPDATE_ITEM_QUANTITY": {
  195 |             const c = store[STORAGE_KEY].find((c) => c.id === message.id);
  196 |             if (!c) { respond({ ok: false, error: "not found" }); return; }
  197 |             const item = (c.items || []).find((it) => it.asin === message.asin);
  198 |             if (!item) { respond({ ok: false, error: "item not found" }); return; }
  199 |             const qty = Math.max(1, Math.min(99, Number(message.quantity) || 1));
  200 |             item.quantity = qty;
  201 |             respond({ ok: true, quantity: qty });
  202 |             return;
  203 |           }
  204 | 
  205 |           case "MC_RESTORE_CART": {
  206 |             const c = store[STORAGE_KEY].find((c) => c.id === message.id);
  207 |             if (!c) { respond({ ok: false, error: "not found" }); return; }
  208 |             respond({ ok: true, total: (c.items || []).length });
  209 |             return;
  210 |           }
  211 | 
  212 |           case "MC_CLEAR_CURRENT":
  213 |             respond({ ok: true, cleared: 0 });
  214 |             return;
  215 | 
  216 |           case "MC_SAVE_AND_CLEAR": {
  217 |             const cart = {
  218 |               id: makeId(),
  219 |               name: String(message.name || "Untitled"),
  220 |               savedAt: new Date().toISOString(),
  221 |               host: "www.amazon.com",
  222 |               items: [{ asin: "B000FAKE03", title: "X", quantity: 1, price: "", image: "", url: "" }],
  223 |             };
  224 |             store[STORAGE_KEY].push(cart);
  225 |             respond({ ok: true, cart, cleared: 1 });
  226 |             return;
  227 |           }
  228 | 
  229 |           default:
  230 |             respond({ ok: false, error: "unhandled message type: " + message.type });
  231 |         }
  232 |       };
  233 | 
  234 |       // ---- chrome.storage.local fake -----------------------------------
  235 |       // The popup only reaches for chrome.storage.local directly for the
  236 |       // theme setting; everything else routes through sendMessage. We keep
  237 |       // this minimal so the surface is obvious.
  238 |       chrome.storage.local.get = function (keyOrKeys) {
  239 |         if (keyOrKeys == null) return Promise.resolve(Object.assign({}, store));
  240 |         if (typeof keyOrKeys === "string") {
  241 |           return Promise.resolve(
  242 |             Object.prototype.hasOwnProperty.call(store, keyOrKeys)
  243 |               ? { [keyOrKeys]: store[keyOrKeys] }
  244 |               : {}
  245 |           );
  246 |         }
  247 |         if (Array.isArray(keyOrKeys)) {
  248 |           const out = {};
  249 |           for (const k of keyOrKeys) if (k in store) out[k] = store[k];
  250 |           return Promise.resolve(out);
  251 |         }
  252 |         const out = {};
  253 |         for (const [k, def] of Object.entries(keyOrKeys)) {
  254 |           out[k] = k in store ? store[k] : def;
  255 |         }
  256 |         return Promise.resolve(out);
  257 |       };
  258 |       chrome.storage.local.set = function (obj) {
  259 |         const changes = {};
  260 |         for (const [k, v] of Object.entries(obj)) {
  261 |           changes[k] = { oldValue: store[k], newValue: v };
  262 |           store[k] = v;
  263 |         }
  264 |         if (Object.keys(changes).length) {
  265 |           setTimeout(() => {
  266 |             for (const listener of storageListeners) {
  267 |               try { listener(changes, "local"); } catch (_e) {}
  268 |             }
  269 |           }, 0);
  270 |         }
  271 |         return Promise.resolve();
  272 |       };
  273 |       chrome.storage.onChanged.addListener = function (listener) {
  274 |         storageListeners.push(listener);
  275 |       };
  276 |       chrome.storage.onChanged.removeListener = function (listener) {
  277 |         const idx = storageListeners.indexOf(listener);
  278 |         if (idx >= 0) storageListeners.splice(idx, 1);
  279 |       };
  280 |     })();
  281 |   `;
  282 | }
  283 | 
  284 | export const test = base.extend({
  285 |   // Persistent context with the unpacked extension loaded.
  286 |   context: async ({}, use) => {
  287 |     const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "styx-pw-"));
  288 |     // MV3 service workers don't register under chromium-headless-shell, so we
  289 |     // must use the full chromium channel. Playwright 1.49 supports running
  290 |     // extensions under the new headless mode when `channel: 'chromium'` is set.
> 291 |     const context = await chromium.launchPersistentContext(userDataDir, {
      |                     ^ Error: browserType.launchPersistentContext: Target page, context or browser has been closed
  292 |       channel: "chromium",
  293 |       headless: true,
  294 |       args: [
  295 |         `--disable-extensions-except=${REPO_ROOT}`,
  296 |         `--load-extension=${REPO_ROOT}`,
  297 |         "--no-sandbox",
  298 |       ],
  299 |     });
  300 |     await use(context);
  301 |     await context.close();
  302 |     try {
  303 |       fs.rmSync(userDataDir, { recursive: true, force: true });
  304 |     } catch (_e) {
  305 |       /* best-effort cleanup */
  306 |     }
  307 |   },
  308 | 
  309 |   // The MV3 service worker registers shortly after launch; its URL gives us
  310 |   // the extension ID. Headless Chromium with --load-extension can take a
  311 |   // beat to come up, so we wait up to a few seconds.
  312 |   extensionId: async ({ context }, use) => {
  313 |     let [worker] = context.serviceWorkers();
  314 |     if (!worker) worker = await context.waitForEvent("serviceworker");
  315 |     const url = worker.url();
  316 |     const match = url.match(/^chrome-extension:\/\/([a-z0-9]+)\//i);
  317 |     if (!match) throw new Error("Could not parse extension ID from " + url);
  318 |     await use(match[1]);
  319 |   },
  320 | 
  321 |   // Provided to tests as a factory: call `await popup({ carts, settings })`
  322 |   // to open popup.html with seeded state and the backend stub installed.
  323 |   popup: async ({ context, extensionId }, use) => {
  324 |     async function openPopup(initial) {
  325 |       const page = await context.newPage();
  326 |       // Run the stub BEFORE popup.js evaluates. addInitScript fires on every
  327 |       // load for this page, including the first navigation.
  328 |       await page.addInitScript(buildInitScript(initial));
  329 |       await page.goto(`chrome-extension://${extensionId}/popup.html`);
  330 |       // Wait until the popup's first refresh() finished — the list count
  331 |       // element is the cheapest signal that initial render happened.
  332 |       await page.waitForSelector("#mc-list-count");
  333 |       return page;
  334 |     }
  335 |     await use(openPopup);
  336 |   },
  337 | });
  338 | 
  339 | export { expect };
  340 | 
```