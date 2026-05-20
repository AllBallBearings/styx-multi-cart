---
title: Privacy Policy — Styx Multi-Cart
---

# Privacy Policy

_Last updated: 2026-05-18_

Styx Multi-Cart ("the extension") is designed to operate entirely on your device. This page explains, in plain language, what data the extension touches and what it does not do.

## Data the extension stores

When you click **Save** on an Amazon cart, the extension stores a snapshot of that cart locally in your browser via the [`chrome.storage.local`](https://developer.chrome.com/docs/extensions/reference/api/storage) API. Each saved snapshot contains:

- A name you choose (or a timestamped default).
- The Amazon storefront the cart came from (for example `amazon.com`).
- For each item in the cart: ASIN, title, quantity, price string, and product image URL.
- The time the snapshot was created.

The extension also stores a small number of preferences (for example, your default restore mode and your recorded upsell choices, which expire after 24 hours).

**All of this data lives only on your device.** Uninstalling the extension or clearing your browser's extension storage erases it. No copy is sent anywhere.

## Data the extension does NOT collect

- We do not collect personally identifiable information.
- We do not collect analytics or telemetry.
- We do not transmit your saved carts, browsing activity, or any other data to any server controlled by us or any third party.
- We do not embed any third-party SDKs, trackers, advertising networks, or fingerprinting tools.
- We do not read or store your Amazon account credentials. Authentication is handled entirely by Amazon in your normal browser session.

## Network requests the extension makes

The only network requests the extension initiates are to Amazon itself (`amazon.com` and its regional variants), and only when you explicitly take an action that requires it:

- **Restore** opens Amazon product pages in a helper tab and drives the page's "Add to Cart" button on your behalf.
- **Clear** opens Amazon's cart page and clicks each item's delete button.
- **Save** reads the contents of the Amazon cart page already open in your browser.

These requests go directly from your browser to Amazon, with your existing Amazon session cookies — exactly as if you had clicked the buttons yourself.

## Permissions

The extension requests the following permissions, each used solely for the purpose described:

- **`storage`** — to save your cart snapshots locally on your device.
- **`activeTab`** — to read the current Amazon tab when you ask the extension to save a cart.
- **`scripting`** — to inject the cart scraper, status overlay, and add-to-cart driver into Amazon pages during save, clear, and restore operations.
- **`tabs`** — to open a helper tab during restore and close it when finished.
- **Host permissions for `*.amazon.com` and 11 other Amazon regional domains** — the extension's entire purpose is to interact with the Amazon cart page on whichever regional storefront you use.

A more detailed per-permission justification is on the [permissions page](permissions.html).

## Children

The extension is not directed to children under 13 and does not knowingly collect any data from anyone.

## Changes to this policy

If the extension's data handling changes in the future, this page will be updated and the "Last updated" date at the top will be revised. Material changes will also be noted in the extension's release notes.

## Contact

Questions, complaints, or takedown requests:

- File an issue at <https://github.com/AllBallBearings/styx-multi-cart/issues>
- Email: jaredgoolsby@gmail.com
