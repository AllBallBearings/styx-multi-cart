# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: popup.spec.js >> popup — Amazon list dashboard >> loads and displays list items only when expanded
- Location: tests/e2e/popup.spec.js:64:3

# Error details

```
Error: browserType.launchPersistentContext: Target page, context or browser has been closed
Browser logs:

<launching> /Users/jaredgoolsby/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --disable-field-trial-config --disable-background-networking --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-back-forward-cache --disable-breakpad --disable-client-side-phishing-detection --disable-component-extensions-with-background-pages --disable-component-update --no-default-browser-check --disable-default-apps --disable-dev-shm-usage --disable-edgeupdater --disable-extensions --disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion --enable-features=CDPScreenshotNewSurface --allow-pre-commit-input --disable-hang-monitor --disable-ipc-flooding-protection --disable-popup-blocking --disable-prompt-on-repost --disable-renderer-backgrounding --force-color-profile=srgb --metrics-recording-only --no-first-run --password-store=basic --use-mock-keychain --no-service-autorun --export-tagged-pdf --disable-search-engine-choice-screen --unsafely-disable-devtools-self-xss-warnings --edge-skip-compat-layer-relaunch --disable-infobars --disable-search-engine-choice-screen --disable-sync --enable-unsafe-swiftshader --headless --hide-scrollbars --mute-audio --blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4 --no-sandbox --disable-extensions-except=/Users/jaredgoolsby/Documents/Github/styx-multi-cart --load-extension=/Users/jaredgoolsby/Documents/Github/styx-multi-cart --no-sandbox --user-data-dir=/var/folders/3z/n_wtd9b94gx3hq81wrs459dh0000gn/T/styx-pw-evZHwV --remote-debugging-pipe about:blank
<launched> pid=64214
Call log:
  - <launching> /Users/jaredgoolsby/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --disable-field-trial-config --disable-background-networking --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-back-forward-cache --disable-breakpad --disable-client-side-phishing-detection --disable-component-extensions-with-background-pages --disable-component-update --no-default-browser-check --disable-default-apps --disable-dev-shm-usage --disable-edgeupdater --disable-extensions --disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion --enable-features=CDPScreenshotNewSurface --allow-pre-commit-input --disable-hang-monitor --disable-ipc-flooding-protection --disable-popup-blocking --disable-prompt-on-repost --disable-renderer-backgrounding --force-color-profile=srgb --metrics-recording-only --no-first-run --password-store=basic --use-mock-keychain --no-service-autorun --export-tagged-pdf --disable-search-engine-choice-screen --unsafely-disable-devtools-self-xss-warnings --edge-skip-compat-layer-relaunch --disable-infobars --disable-search-engine-choice-screen --disable-sync --enable-unsafe-swiftshader --headless --hide-scrollbars --mute-audio --blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4 --no-sandbox --disable-extensions-except=/Users/jaredgoolsby/Documents/Github/styx-multi-cart --load-extension=/Users/jaredgoolsby/Documents/Github/styx-multi-cart --no-sandbox --user-data-dir=/var/folders/3z/n_wtd9b94gx3hq81wrs459dh0000gn/T/styx-pw-evZHwV --remote-debugging-pipe about:blank
  - <launched> pid=64214
  - [pid=64214] <gracefully close start>
  - [pid=64214] <kill>
  - [pid=64214] <will force kill>
  - [pid=64214] exception while trying to kill process: Error: kill EPERM
  - [pid=64214] <process did exit: exitCode=null, signal=SIGABRT>
  - [pid=64214] starting temporary directories cleanup
  - [pid=64214] finished temporary directories cleanup
  - [pid=64214] <gracefully close end>

```

# Test source

```ts
  222 |             return;
  223 |           }
  224 | 
  225 |           case "MC_UPDATE_ITEM_QUANTITY": {
  226 |             const c = store[STORAGE_KEY].find((c) => c.id === message.id);
  227 |             if (!c) { respond({ ok: false, error: "not found" }); return; }
  228 |             const item = (c.items || []).find((it) => it.asin === message.asin);
  229 |             if (!item) { respond({ ok: false, error: "item not found" }); return; }
  230 |             const qty = Math.max(1, Math.min(99, Number(message.quantity) || 1));
  231 |             item.quantity = qty;
  232 |             respond({ ok: true, quantity: qty });
  233 |             return;
  234 |           }
  235 | 
  236 |           case "MC_RESTORE_CART": {
  237 |             const c = store[STORAGE_KEY].find((c) => c.id === message.id);
  238 |             if (!c) { respond({ ok: false, error: "not found" }); return; }
  239 |             respond({ ok: true, total: (c.items || []).length });
  240 |             return;
  241 |           }
  242 | 
  243 |           case "MC_CLEAR_CURRENT":
  244 |             respond({ ok: true, cleared: 0 });
  245 |             return;
  246 | 
  247 |           case "MC_SAVE_AND_CLEAR": {
  248 |             const cart = {
  249 |               id: makeId(),
  250 |               name: String(message.name || "Untitled"),
  251 |               savedAt: new Date().toISOString(),
  252 |               host: "www.amazon.com",
  253 |               items: [{ asin: "B000FAKE03", title: "X", quantity: 1, price: "", image: "", url: "" }],
  254 |             };
  255 |             store[STORAGE_KEY].push(cart);
  256 |             respond({ ok: true, cart, cleared: 1 });
  257 |             return;
  258 |           }
  259 | 
  260 |           default:
  261 |             respond({ ok: false, error: "unhandled message type: " + message.type });
  262 |         }
  263 |       };
  264 | 
  265 |       // ---- chrome.storage.local fake -----------------------------------
  266 |       // The popup only reaches for chrome.storage.local directly for the
  267 |       // theme setting; everything else routes through sendMessage. We keep
  268 |       // this minimal so the surface is obvious.
  269 |       chrome.storage.local.get = function (keyOrKeys) {
  270 |         if (keyOrKeys == null) return Promise.resolve(Object.assign({}, store));
  271 |         if (typeof keyOrKeys === "string") {
  272 |           return Promise.resolve(
  273 |             Object.prototype.hasOwnProperty.call(store, keyOrKeys)
  274 |               ? { [keyOrKeys]: store[keyOrKeys] }
  275 |               : {}
  276 |           );
  277 |         }
  278 |         if (Array.isArray(keyOrKeys)) {
  279 |           const out = {};
  280 |           for (const k of keyOrKeys) if (k in store) out[k] = store[k];
  281 |           return Promise.resolve(out);
  282 |         }
  283 |         const out = {};
  284 |         for (const [k, def] of Object.entries(keyOrKeys)) {
  285 |           out[k] = k in store ? store[k] : def;
  286 |         }
  287 |         return Promise.resolve(out);
  288 |       };
  289 |       chrome.storage.local.set = function (obj) {
  290 |         const changes = {};
  291 |         for (const [k, v] of Object.entries(obj)) {
  292 |           changes[k] = { oldValue: store[k], newValue: v };
  293 |           store[k] = v;
  294 |         }
  295 |         if (Object.keys(changes).length) {
  296 |           setTimeout(() => {
  297 |             for (const listener of storageListeners) {
  298 |               try { listener(changes, "local"); } catch (_e) {}
  299 |             }
  300 |           }, 0);
  301 |         }
  302 |         return Promise.resolve();
  303 |       };
  304 |       chrome.storage.onChanged.addListener = function (listener) {
  305 |         storageListeners.push(listener);
  306 |       };
  307 |       chrome.storage.onChanged.removeListener = function (listener) {
  308 |         const idx = storageListeners.indexOf(listener);
  309 |         if (idx >= 0) storageListeners.splice(idx, 1);
  310 |       };
  311 |     })();
  312 |   `;
  313 | }
  314 | 
  315 | export const test = base.extend({
  316 |   // Persistent context with the unpacked extension loaded.
  317 |   context: async ({}, use) => {
  318 |     const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "styx-pw-"));
  319 |     // MV3 service workers don't register under chromium-headless-shell, so we
  320 |     // must use the full chromium channel. Playwright 1.49 supports running
  321 |     // extensions under the new headless mode when `channel: 'chromium'` is set.
> 322 |     const context = await chromium.launchPersistentContext(userDataDir, {
      |                     ^ Error: browserType.launchPersistentContext: Target page, context or browser has been closed
  323 |       channel: "chromium",
  324 |       headless: true,
  325 |       args: [
  326 |         `--disable-extensions-except=${REPO_ROOT}`,
  327 |         `--load-extension=${REPO_ROOT}`,
  328 |         "--no-sandbox",
  329 |       ],
  330 |     });
  331 |     await use(context);
  332 |     await context.close();
  333 |     try {
  334 |       fs.rmSync(userDataDir, { recursive: true, force: true });
  335 |     } catch (_e) {
  336 |       /* best-effort cleanup */
  337 |     }
  338 |   },
  339 | 
  340 |   // The MV3 service worker registers shortly after launch; its URL gives us
  341 |   // the extension ID. Headless Chromium with --load-extension can take a
  342 |   // beat to come up, so we wait up to a few seconds.
  343 |   extensionId: async ({ context }, use) => {
  344 |     let [worker] = context.serviceWorkers();
  345 |     if (!worker) worker = await context.waitForEvent("serviceworker");
  346 |     const url = worker.url();
  347 |     const match = url.match(/^chrome-extension:\/\/([a-z0-9]+)\//i);
  348 |     if (!match) throw new Error("Could not parse extension ID from " + url);
  349 |     await use(match[1]);
  350 |   },
  351 | 
  352 |   // Provided to tests as a factory: call `await popup({ carts, settings })`
  353 |   // to open popup.html with seeded state and the backend stub installed.
  354 |   popup: async ({ context, extensionId }, use) => {
  355 |     async function openPopup(initial) {
  356 |       const page = await context.newPage();
  357 |       // Run the stub BEFORE popup.js evaluates. addInitScript fires on every
  358 |       // load for this page, including the first navigation.
  359 |       await page.addInitScript(buildInitScript(initial));
  360 |       await page.goto(`chrome-extension://${extensionId}/popup.html`);
  361 |       // Wait until the Amazon-list dashboard's initial discovery request has
  362 |       // completed, including the empty-list case where the count stays zero.
  363 |       await page.waitForFunction(() =>
  364 |         Array.isArray(window.__mcMessageLog) &&
  365 |         window.__mcMessageLog.some((message) => message.type === "MC_LIST_AMAZON_LISTS")
  366 |       );
  367 |       await page.waitForTimeout(20);
  368 |       return page;
  369 |     }
  370 |     await use(openPopup);
  371 |   },
  372 | });
  373 | 
  374 | export { expect };
  375 | 
```