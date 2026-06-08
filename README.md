# Styx Multi-Cart

Licensed under [PolyForm Noncommercial 1.0.0](LICENSE) — free for personal and noncommercial use.

You can have multiple carts or separate purchases at checkout in the real world. Why not Amazon?!

A browser extension that for multiple Amazon shopping carts. Save your current cart, switch between multiple named carts, and restore any of them with one click to proceed to checkout.

## What it does

- **Save** — capture every item in your active Amazon cart (ASIN, quantity, title, image) under a name you choose.
- **Multi-cart** — keep as many saved carts as you want. "Birthday gifts," "Office supplies," "Wishlist," whatever.
- **Restore** — replace your live Amazon cart with the items from a saved cart.
- **Clear** — empty your active cart on Amazon.
- **Save & clear** — combine the two: snapshot the current cart, then empty it (so you can start a new one without losing the old).
- **Delete** — remove saved carts you no longer need.
- **Rename** — rename a saved cart any time.
- **Edit items inline** — each item shows as a picture tile. Click the **X** (top-left) to remove it, click the **count badge** (bottom-left) for a +/− quantity popover, or click the **picture** to move that item into another cart. (Removing a cart's last item deletes the cart, so that one asks first.)

Storage is local-only (`chrome.storage.local`), so saved carts never leave the device.

## Install (Chrome / Edge / Brave / Arc / Opera / Vivaldi)

These all share the Chromium / Blink engine and load extensions identically.

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`, etc.).
2. Toggle on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Choose this folder (the one with `manifest.json` in it).
5. The Styx icon appears in your toolbar. Pin it for easy access.

## Install (Safari)

Safari uses true WebKit and ships extensions through the App Store, but Apple provides a one-command converter:

```bash
xcrun safari-web-extension-converter "/path/to/Styx Multi-Cart"
```

That generates an Xcode project. Open it, build it, and Safari will load the extension. (You'll need a Mac with Xcode installed.)

## Install (Firefox)

Firefox supports Manifest V3 with one minor change: you need an `applications.gecko` block. To run it temporarily without modifying anything:

1. Visit `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `manifest.json` in this folder.

The extension will run until Firefox restarts.

## Developer mode & diagnostics

The popup hides a developer panel behind a private unlock so normal users never
stumble into it. To open it: click the gear (**Settings**), then type
`STYXDEV`. A **Developer mode** switch appears; turning it on reveals the debug
panel and enables verbose logging across the service worker and content
scripts.

With Developer mode on you can:

- **Copy diagnostic logs** — gathers the extension version, current state, and
  recent logs from every context (service worker, content scripts, popup) onto
  the clipboard. The intended support flow: ask a user to turn on Developer
  mode, reproduce the issue, then send you the copied report.
- **Run cart diagnostics** — dumps what the cart-clear logic sees on the page.

The unlock code is a convenience to keep normal users out, **not** a security
boundary — anyone can read it in the source. The entitlement-forging controls
in the debug panel are therefore stripped from production builds (see below),
so the shipped artifact carries no in-UI way to grant premium.

## Building for release

The source in this repo is the **developer** build: it includes the debug
entitlement presets (behind the Developer-mode unlock) so you can exercise the
paywall UI locally. Production builds strip those controls.

### Chrome / Edge / Brave / … (Chrome Web Store)

```bash
npm run build              # regenerate background.js from src/
bash scripts/build-zip.sh  # → dist/styx-multi-cart-v<version>.zip (controls stripped)
```

Upload the resulting zip to the Chrome Web Store. To produce a dev-flavored zip
that keeps the debug controls, set `STYX_KEEP_DEBUG_ENT=1`.

### Safari (App Store)

```bash
npm run sync:safari            # dev build  — debug controls KEPT (for Xcode debugging)
npm run sync:safari -- --prod  # release    — debug controls STRIPPED
```

Run the `--prod` sync immediately before archiving in Xcode for App Store
submission. Both forms regenerate `background.js` and copy the web-extension
files into the Xcode project's `Resources/`.

### Loading the dev build unpacked

For day-to-day development just load the repo folder unpacked (see the install
steps above) — no build step needed, and the debug controls are present.

## How to use

1. Go to your Amazon cart (`amazon.com/gp/cart/view.html` or click the cart icon).
2. Click the Styx icon in your browser toolbar.
3. Type a name and hit **Save**. (Leave the field blank to use a timestamped default.)
4. To restore later, open the popup and click **Restore** on the saved cart you want. Styx clears the current Amazon cart first, then opens Amazon with the saved items added.
5. Use **Save & clear** to snapshot what's in your cart and empty it in one step — handy when you want a fresh cart but don't want to lose the items you've gathered.

### How restore works under the hood

The extension drives Amazon the same way you would: it opens one helper tab, navigates it through each saved product page in turn, and clicks the page's real **Add to Cart** button. When every item has been processed, it lands on `gp/cart/view.html` so you can review what came through.

This is slower than a single-shot batch URL — figure roughly 3–5 seconds per item — but it goes through the exact same UI flow as a human, so authentication, regional locks, multi-seller buy-box selection, and quantity caps are all handled by Amazon's own page logic. Items that have been delisted, are out of stock, or no longer ship to your region simply skip; the rest go through.

You'll need to be signed in to Amazon for restore to work — the extension never handles your credentials.

**Protection plans require your choice.** Amazon often interrupts Add-to-Cart with a protection-plan upsell. Styx pauses restore on that Amazon page, tells you to choose the option you want, then continues with the remaining saved items after the prompt is complete.

## Files

| File                                    | What it does                                                        |
| --------------------------------------- | ------------------------------------------------------------------- |
| `manifest.json`                         | Extension metadata, permissions, content-script targets             |
| `src/background/index.js`               | Canonical service-worker source                                     |
| `background.js`                         | Generated bundled classic service worker loaded by the manifest     |
| `content.js`                            | Runs on Amazon cart pages — scrapes items and clears the cart       |
| `popup.html` / `popup.css` / `popup.js` | The toolbar popup UI                                                |
| `generate_icons.html`                   | Optional one-time helper to generate toolbar icon PNGs              |

## Adding custom toolbar icons (optional)

The extension works fine with Chrome's default puzzle-piece icon. If you'd like a real icon:

1. Open `generate_icons.html` in your browser.
2. Click **Download all 4 PNGs**.
3. Make a folder called `icons/` next to `manifest.json` and drop the four PNGs in.
4. Open `manifest.json` and paste the `default_icon` and `icons` blocks shown on the generator page back in.
5. Reload the extension at `chrome://extensions`.

## Troubleshooting

- **"Could not read the Amazon cart page"** — make sure you're on `amazon.com/cart` (not the homepage) and the page is fully loaded. Refresh and try again.
- **Restore opened a tab but nothing was added** — you're probably not signed in to Amazon, or Amazon is showing a CAPTCHA on a product page. Sign in, dismiss any prompts, then click Restore again.
- **Some items didn't restore** — Amazon may have removed the listing, the seller may be out of stock, the product may have a custom-options page (e.g., engraving) that the extension doesn't fill in, or the ASIN may now be region-locked. Anything the extension couldn't add is simply skipped; the rest go through.
- **Cart-page selectors stop working** — Amazon A/B tests its cart layout. Open an issue / file a fix; the relevant selectors are at the top of `content.js`.

## Privacy

The extension stores data only in your browser's local extension storage. It never sends data to any third-party server. The only network requests it makes are to amazon.com itself, on your behalf, when you click Restore.
