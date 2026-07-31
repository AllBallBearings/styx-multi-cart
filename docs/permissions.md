---
title: Permissions Justification — Styx Multi-Cart
---

[← Back to Styx Multi-Cart](./)

# Permissions Justification

This document explains why Styx Multi-Cart requests each permission listed in its `manifest.json`. The content here is intended both as user-facing transparency and as copy-paste text for the Chrome Web Store's per-permission justification fields.

> **Where your data lives:** your carts are your own Amazon lists, held in your Amazon account — not in the extension and not on any server of ours. `chrome.storage.local` holds only settings and licensing state. See the [privacy policy](privacy.html).

## `storage`

The extension keeps a small set of local state using `chrome.storage.local`: your preferences (relabeling Amazon's Lists page as carts, floating-button pulse, developer mode), recorded upsell choices with a 24-hour TTL, your entitlement record and license token, and a short-lived (about five minutes) cache of list contents so the panel doesn't re-read Amazon on every open. Without this permission the extension could not remember your settings or your Premium status between sessions.

## `activeTab`

When you invoke the extension on an Amazon page — via the floating Styx button or the toolbar icon — it reads the contents of the tab in front of you to find your cart or list. `activeTab` is the minimum-privilege way to do that: it grants temporary access only to the tab the user explicitly invoked the extension on.

## `scripting`

The extension uses `chrome.scripting.executeScript` to inject its own interface and helpers into Amazon pages. All of them are small, self-contained, and shipped inside the extension package:

1. **The floating button and panel** — the round Styx button and the draggable cart panel it opens.
2. **Page buttons** — "Save cart to a new list" on the cart page, "Send All to Amazon Cart" on a list page, and the branded "Add to a Styx cart" button on a product page.
3. **Cart picker** — the in-page chooser for picking which cart an item goes into.
4. **Readers** — reads the items on your cart page or list page when you save, empty, or send a cart.
5. **Drivers** — clicks the page's real "Add to Cart" and delete controls, just as a human would, when sending a cart to your Amazon cart or emptying it.
6. **Status overlay** — the progress toast shown while a save, empty, or send is running.
7. **Lists relabeler** — the display-only text swap that renames Amazon's Lists page to "Your Styx Carts" (toggleable in Settings).

All injected code lives in the extension's own bundle. The extension never executes remote code.

## `tabs`

The extension opens helper tabs to act on Amazon on your behalf: navigating to your cart page to empty it, and opening a product page per item when saving a cart into a new Amazon list or sending a cart to your Amazon cart. `tabs` is required to create, navigate, and close those helpers, and to detect when each page has finished loading. It is also used to open the ExtensionPay checkout tab if you purchase Premium.

## `alarms`

Used solely to schedule a once-per-day wake-up of the service worker so it can refresh the Premium license status from ExtensionPay (see "Outbound non-Amazon network requests" below). Without `alarms`, MV3 service workers are evicted within minutes of inactivity and the license check would never run on its own; the user would have to keep the popup open. No alarms are used for anything else.

## Host permissions

The extension declares host permissions for the Amazon storefronts it supports:

`amazon.com`, `amazon.co.uk`, `amazon.ca`, `amazon.com.au`, `amazon.de`, `amazon.fr`, `amazon.it`, `amazon.es`, `amazon.co.jp`, `amazon.in`, `amazon.com.mx`, `amazon.com.br`.

The extension's entire purpose is to interact with your cart and lists on whichever regional storefront you use. It does not request access to any non-Amazon site. Content scripts are further narrowed to the specific cart, product, list/wish-list, and checkout paths the extension needs (see the `content_scripts.matches` entries in `manifest.json`).

## The `tag=` parameter in add-to-cart URLs

When the extension sends a whole cart to your Amazon cart, the Amazon add-to-cart URL it opens carries an Amazon Associates–style parameter (`tag=styxmcart-20`). Amazon's bulk add-to-cart endpoint will not render the items without one, so the extension supplies a placeholder value purely to make the feature function.

**This is not a registered Associates account. We earn no commission, referral fee, or other compensation from your purchases.** The parameter carries no information about you, does not track your browsing, and sends nothing to us or any third party. It is noted here only because it is visible in network traffic and would otherwise look like undisclosed affiliate monetization.

## Outbound non-Amazon network requests

The extension communicates with **`extensionpay.com`** to handle Premium licensing:

1. **Checkout** — opening ExtensionPay's hosted Stripe checkout page in a new tab, only when the user explicitly clicks Upgrade. This is the moment an ExtensionPay API key is first generated locally for that install.
2. **License verification** — a once-per-day `fetch()` (and one on each popup open) that sends only the opaque ExtensionPay API key stored locally; receives a subscription-status response. **This request is only made on installs that have an API key on file**, i.e. installs that have at least clicked Upgrade. Users who never engage with the upgrade flow never contact ExtensionPay — the SDK short-circuits to a local "not paid" response without any network call.
3. **Post-checkout handshake** — a small content script (`ExtPay.js`, bundled with the extension) runs on `https://extensionpay.com/*` so a successful purchase can `postMessage` back to the extension and update the license state immediately. This script does not run on any other domain.

No cart contents, browsing data, or PII are transmitted in any of these requests. Payment-card data is handled entirely by Stripe on ExtensionPay's hosted page; the extension never sees it. See the [privacy policy](privacy.html) for the full data-handling statement and links to ExtensionPay's and Stripe's policies.

## Bundled third-party code

The extension bundles one third-party JavaScript file: **`ExtPay.js`** (≈55 KB), the official client SDK from [ExtensionPay](https://extensionpay.com). It is delivered as a static asset in the extension package — no remote code is loaded at runtime. The bundled file is identical to the one published at <https://github.com/Glench/ExtPay> and can be regenerated locally by running `npm install extpay@latest` and copying `node_modules/extpay/dist/ExtPay.js`. The extension does not include any analytics SDK, advertising network, fingerprinting library, or other third-party code.

## What the extension does NOT do

- It does not run on, read from, or transmit data to any non-Amazon website besides `extensionpay.com` (used solely for Premium licensing as described above).
- It does not collect analytics, telemetry, or any personally identifiable information.
- It does not transmit your carts to any server of ours — there isn't one. Cart and list contents move only between your browser and Amazon.
- It does not read or store your Amazon password — authentication is handled entirely by Amazon in your normal browser session.

See the [privacy policy](privacy.html) for the full data-handling statement.
