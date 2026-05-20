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

## Host permissions

The extension declares host permissions for the Amazon storefronts it supports:

`amazon.com`, `amazon.co.uk`, `amazon.ca`, `amazon.com.au`, `amazon.de`, `amazon.fr`, `amazon.it`, `amazon.es`, `amazon.co.jp`, `amazon.in`, `amazon.com.mx`, `amazon.com.br`.

The extension's entire purpose is to interact with the Amazon cart page on whichever regional storefront you use. It does not request access to any non-Amazon site. Content scripts are further narrowed to the specific cart, product, and checkout paths the extension needs (see the `content_scripts.matches` entries in `manifest.json`).

## What the extension does NOT do

- It does not run on, read from, or transmit data to any non-Amazon website.
- It does not collect analytics, telemetry, or any personally identifiable information.
- It does not transmit your saved carts to any server.
- It does not bundle or load any third-party SDK, tracker, ad network, or fingerprinting library.
- It does not read or store your Amazon password — authentication is handled entirely by Amazon in your normal browser session.

See the [privacy policy](privacy.html) for the full data-handling statement.
