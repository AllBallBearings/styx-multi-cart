---
title: Privacy Policy — Styx Multi-Cart
---

[← Back to Styx Multi-Cart](./)

# Privacy Policy

_Last updated: 2026-05-25_

Styx Multi-Cart ("the extension") is designed to operate on your device as much as possible. This page explains, in plain language, what data the extension touches.

## Data the extension stores locally

When you click **Save** on an Amazon cart, the extension stores a snapshot of that cart in your browser via the [`chrome.storage.local`](https://developer.chrome.com/docs/extensions/reference/api/storage) API. Each saved snapshot contains:

- A name you choose (or a timestamped default).
- The Amazon storefront the cart came from (for example `amazon.com`).
- For each item: ASIN, title, quantity, price string, and product image URL.
- The timestamps the snapshot was created and last used.

The extension also stores a small set of preferences locally:

- Default restore mode (quick vs. reliable).
- Recorded protection-plan / coverage choices, which expire after 24 hours.
- An entitlement record (free or premium tier, expiry timestamp) — used to decide which features are unlocked.
- A short, opaque license token issued by the payment provider when you buy Premium.

**Local data lives only on your device.** Uninstalling the extension or clearing your browser's extension storage erases it.

## Data we never collect

- We do not collect personally identifiable information.
- We do not collect analytics, telemetry, or usage statistics.
- We do not transmit your saved carts, browsing activity, search history, or any product data to any server.
- We do not embed any third-party tracker, advertising network, or fingerprinting library inside the extension.
- We do not read or store your Amazon account credentials. Authentication is handled entirely by Amazon in your normal browser session.

## Network requests the extension makes

There are two categories of outbound requests:

### 1. Requests to Amazon

When you take a Save, Clear, or Restore action, the extension drives Amazon pages on your behalf — opening product pages, clicking "Add to Cart," reading the cart contents. These requests go directly from your browser to Amazon, using your existing Amazon session, exactly as if you had clicked the buttons yourself.

### 2. Requests to the payment / license provider (Premium only)

If you purchase a Premium subscription, the extension uses [ExtensionPay](https://extensionpay.com) (which uses [Stripe](https://stripe.com) for payment processing). In that context:

- When you click **Upgrade**, the extension opens an ExtensionPay-hosted checkout page in a new tab. You enter your payment details on that page, where they are handled by Stripe directly. **We never see or store your credit-card number, billing address, or other payment details.** Card information is governed by [Stripe's privacy policy](https://stripe.com/privacy) and [ExtensionPay's privacy policy](https://extensionpay.com/privacy).
- After purchase, the extension stores an opaque license token locally and periodically (about once a day) checks with ExtensionPay's servers to confirm the subscription is still active. The check transmits only the license token; it does not transmit any cart contents, browsing history, or personally identifiable information from this extension.
- If you cancel your subscription or it lapses, the extension returns to free-tier behavior on the next license check. Your saved carts are never deleted.

Users who **never click the Upgrade button** are never contacted by ExtensionPay or Stripe, and no payment-related data is generated — the SDK short-circuits to a local "not paid" response without making any network request.

Users who click Upgrade (whether or not they complete the purchase) have a randomly generated ExtensionPay API key written into their local `chrome.storage.local`, and the daily license-status check begins from that point. The check transmits only the opaque API key and never reveals which Amazon storefronts you use, which carts you've saved, or any other behavioral data from this extension.

## Permissions

The extension requests the following Chrome permissions, each used solely for the purpose described:

- **`storage`** — to save your cart snapshots, preferences, and license token locally on your device.
- **`activeTab`** — to read the current Amazon tab when you ask the extension to save a cart.
- **`scripting`** — to inject the cart scraper, status overlay, and add-to-cart driver into Amazon pages during save, clear, and restore operations.
- **`tabs`** — to open a helper tab during restore (and the ExtensionPay checkout tab if you purchase Premium), and close it when finished.
- **Host permissions for `*.amazon.com` and 11 other Amazon regional domains** — the extension's entire purpose is to interact with the Amazon cart page on whichever regional storefront you use.

A more detailed per-permission justification is on the [permissions page](permissions.html).

## Children

The extension is not directed to children under 13 and does not knowingly collect any data from anyone.

## Changes to this policy

If the extension's data handling changes in the future, this page will be updated and the "Last updated" date at the top will be revised. Material changes will also be noted in the extension's release notes on the [GitHub repository](https://github.com/AllBallBearings/styx-multi-cart/releases).

## Contact

Questions, complaints, or takedown requests:

- File an issue at <https://github.com/AllBallBearings/styx-multi-cart/issues>
- Email: jaredgoolsby@gmail.com
