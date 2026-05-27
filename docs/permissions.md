---
title: Permissions Justification — Styx Multi-Cart
---

# Permissions Justification

This document explains why Styx Multi-Cart requests each permission listed in its `manifest.json`. The content here is intended both as user-facing transparency and as copy-paste text for the Chrome Web Store's per-permission justification fields.

## `storage`

The extension saves your cart snapshots and a small set of preferences (default restore mode, recorded upsell choices with 24-hour TTL) using `chrome.storage.local`. Without this permission the extension could not remember any saved cart between popup opens.

## `activeTab`

When you click the toolbar icon and then **Save**, the extension reads the contents of the Amazon tab that is currently in front of you. `activeTab` is the minimum-privilege way to do that — it grants temporary access only to the tab the user explicitly invoked the extension on.

## `scripting`

The extension uses `chrome.scripting.executeScript` to inject three small, self-contained helpers into Amazon pages:

1. **Cart scraper** — reads the items already on the Amazon cart page when you click Save.
2. **Status overlay** — shows the floating progress toast at the top of the page while a clear or restore is in progress.
3. **Add-to-Cart driver** — clicks the page's real "Add to Cart" button during a restore, just as a human would.

All injected code lives in the extension's own bundle. The extension never executes remote code.

## `tabs`

During restore the extension opens one helper tab, navigates it through each saved product page in sequence, and closes the tab when finished. `tabs` is required to create, navigate, and close that helper, and to detect when each product page has finished loading.

## `alarms`

Used solely to schedule a once-per-day wake-up of the service worker so it can refresh the Premium license status from ExtensionPay (see "Outbound non-Amazon network requests" below). Without `alarms`, MV3 service workers are evicted within minutes of inactivity and the license check would never run on its own; the user would have to keep the popup open. No alarms are used for anything else.

## Host permissions

The extension declares host permissions for the Amazon storefronts it supports:

`amazon.com`, `amazon.co.uk`, `amazon.ca`, `amazon.com.au`, `amazon.de`, `amazon.fr`, `amazon.it`, `amazon.es`, `amazon.co.jp`, `amazon.in`, `amazon.com.mx`, `amazon.com.br`.

The extension's entire purpose is to interact with the Amazon cart page on whichever regional storefront you use. It does not request access to any non-Amazon site. Content scripts are further narrowed to the specific cart, product, and checkout paths the extension needs (see the `content_scripts.matches` entries in `manifest.json`).

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
- It does not transmit your saved carts to any server.
- It does not read or store your Amazon password — authentication is handled entirely by Amazon in your normal browser session.

See the [privacy policy](privacy.html) for the full data-handling statement.
