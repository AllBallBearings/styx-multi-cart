# Styx Multi-Cart

Licensed under [PolyForm Noncommercial 1.0.0](LICENSE) — free for personal and noncommercial use.

You can have multiple carts or separate purchases at checkout in the real world. Why not Amazon?!

**One click to clear your Amazon cart — or save it for a later checkout.** Amazon never gave you an Empty Cart button, so you delete items one at a time, or you never clear it and the thing you actually want to buy stays buried. Styx empties the whole cart for you, and offers to save it first as a reusable cart so clearing costs you nothing. Those saved carts are just your Amazon lists, so they're backed by your Amazon account and already on every device you sign in on — a separate cart for every occasion (the birthday, the holidays, the weekly groceries, the home project), each one ready to send to checkout.

## What it does

- **Empty your Amazon cart** — clears your live cart from one button in the Styx panel, instead of deleting items one at a time. Free and unlimited on every plan. **Saved for Later is never touched.** Larger carts are cleared item by item, so it takes a moment to work through them.
- **Save & Clear** — the confirm dialog offers to save everything in the cart into a brand-new Amazon list first, so you can empty it and shop something else without losing a thing. Also available without clearing, via **Save Cart for Later** in the panel or **Save cart to a new list** on the Amazon cart page.
- **Lists are carts** — every Amazon list shows up as a cart. Styx also relabels Amazon's own Lists page to **Your Styx Carts** and appends "Cart" to each list name (toggle the relabeling off in Settings).
- **Floating panel** — a floating Styx button rides along on Amazon; click it for a draggable panel of all your carts, and click off it to dismiss. A **Go to Carts** button jumps to them on Amazon.
- **Send All to Amazon Cart** — load an entire cart into your live Amazon cart, ready to check out. Out-of-stock items skip; books ask which edition/format. Amazon's own bulk-add confirmation still needs one click from you.
- **Add to a Styx cart while you browse** — a branded button next to **Add to Cart** on every product page lets you drop an item straight into the cart you choose.

Items inside a cart are shown as picture tiles for review; editing them (quantity, removal) happens on Amazon's own list page.

**Free & Premium:** emptying your cart and saving it are **always free and unlimited**. The free tier also covers **3 carts** with every core action; **Premium unlocks unlimited carts** ($9.99/year or $19.99 lifetime). Over-limit carts render grayed and open the upgrade screen — list creation itself is never blocked. Your live Amazon cart is always first-class and always free, even if Premium lapses.

Your carts live in your Amazon account; the extension stores only settings and preferences locally (`chrome.storage.local`) and never sends your cart contents to any server.

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

1. On any Amazon page, click the **floating Styx button** (bottom-right) to open the panel of your carts. (You can also click the Styx toolbar icon.)
2. **Clear your cart:** hit **Clear Amazon Cart**. Styx asks whether to save it first — pick **Save & Clear** to keep everything as a new cart, or **Just Clear** to wipe it. Either way your Saved for Later is untouched.
3. **Send a cart to checkout:** open a cart and hit **Send All to Amazon Cart**. Styx loads the whole cart into your live Amazon cart, ready to check out.
4. **Build a cart:** while browsing, click **Add to a Styx cart** next to Add to Cart on a product page and pick the cart — or add items to any list on Amazon as usual.
5. **Save without emptying:** on the Amazon cart page, click **Save cart to a new list** to snapshot everything in your live cart into a brand-new cart.

### How "Send All to Amazon Cart" works under the hood

The extension drives Amazon the same way you would: it opens one helper tab, navigates it through each product page in the cart in turn, and clicks the page's real **Add to Cart** button. When every item has been processed, it lands on `gp/cart/view.html` so you can review what came through.

This is slower than a single-shot batch URL — figure roughly 3–5 seconds per item — but it goes through the exact same UI flow as a human, so authentication, regional locks, multi-seller buy-box selection, and quantity caps are all handled by Amazon's own page logic. Items that have been delisted, are out of stock, or no longer ship to your region simply skip; the rest go through.

You'll need to be signed in to Amazon — the extension never handles your credentials.

**Protection plans require your choice.** Amazon often interrupts Add-to-Cart with a protection-plan upsell. Styx pauses on that Amazon page, tells you to choose the option you want, then continues with the remaining items after the prompt is complete.

## Files

| File                                    | What it does                                                        |
| --------------------------------------- | ------------------------------------------------------------------- |
| `manifest.json`                         | Extension metadata, permissions, content-script targets             |
| `src/background/index.js`               | Canonical service-worker source                                     |
| `background.js`                         | Generated bundled classic service worker loaded by the manifest     |
| `content.js`                            | Runs on Amazon cart pages — scrapes items and clears the cart       |
| `observer.js`                           | Runs on Amazon product/list/cart pages — the floating button and panel, page buttons, relabeling |
| `popup.html` / `popup.css` / `popup.js` | The panel UI, loaded inside the in-page floating modal              |
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
- **Emptying stopped partway** — very large carts can hit the per-run ceiling, or Amazon may have stalled on a row. Click **Clear Amazon Cart** again to finish the rest.
- **A tab opened but nothing was added** — you're probably not signed in to Amazon, or Amazon is showing a CAPTCHA on a product page. Sign in, dismiss any prompts, then try again.
- **Some items didn't make it into the cart** — Amazon may have removed the listing, the seller may be out of stock, the product may have a custom-options page (e.g., engraving) that the extension doesn't fill in, or the ASIN may now be region-locked. Anything the extension couldn't add is simply skipped; the rest go through.
- **Cart-page selectors stop working** — Amazon A/B tests its cart layout. Open an issue / file a fix; the relevant selectors are at the top of `content.js`.

## Privacy

Your carts are your own Amazon lists, held in your Amazon account — not in the extension and not on any server of ours, because there isn't one. The extension stores only settings, preferences, and Premium licensing state in your browser's local extension storage. Its network requests go to amazon.com on your behalf, plus `extensionpay.com` for Premium licensing (only if you click Upgrade). Bulk add-to-cart URLs carry our Amazon Associates tag. Full details in the [privacy policy](https://allballbearings.github.io/styx-multi-cart/privacy.html).
