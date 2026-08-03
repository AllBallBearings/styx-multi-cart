---
title: Privacy Policy — Styx Multi-Cart
---

[← Back to Styx Multi-Cart](./)

# Privacy Policy

_Last updated: 2026-07-29_

Styx Multi-Cart ("the extension") runs between your browser and Amazon. There is no Styx server, and no account to create with us. This page explains, in plain language, what data the extension touches and where it goes.

## Where your carts actually live

**Your carts are your own Amazon lists, stored in your Amazon account — not in the extension, and not on any server of ours.**

When you save a cart, the extension creates or updates a list in your Amazon account, acting on your behalf through your existing Amazon session. That is also why your carts appear on every device you sign in to: Amazon is holding them, not us. It also means uninstalling the extension does **not** delete your carts — they remain in your Amazon account until you delete them there.

Using the extension therefore requires being signed in to Amazon.

## Data the extension stores locally

The extension stores only a small set of settings and state in your browser via the [`chrome.storage.local`](https://developer.chrome.com/docs/extensions/reference/api/storage) API:

- Your preferences (whether to relabel Amazon's Lists page as carts, whether the floating button pulses, developer mode).
- Recorded protection-plan / coverage choices, which expire after 24 hours.
- An entitlement record (free or premium tier, expiry timestamp) — used to decide which features are unlocked.
- A short, opaque license token issued by the payment provider when you buy Premium.
- A short-lived cache of list contents (about five minutes) so the panel doesn't re-read Amazon on every open.

Earlier versions of the extension stored full cart snapshots locally. That model has been replaced by Amazon lists; any snapshots left over from an older version stay on your device and are erased when you uninstall or clear extension storage.

## Data we never collect

- We do not collect personally identifiable information.
- We do not collect analytics, telemetry, or usage statistics.
- We do not transmit your carts, browsing activity, search history, or any product data to any server of ours — we do not operate one.
- We do not embed any third-party tracker, advertising network, or fingerprinting library inside the extension.
- We do not read or store your Amazon account credentials. Authentication is handled entirely by Amazon in your normal browser session.

## Network requests the extension makes

There are two categories of outbound requests:

### 1. Requests to Amazon

When you empty your cart, save a cart, send a cart to your Amazon cart, or add an item while browsing, the extension drives Amazon pages on your behalf — reading your cart and lists, opening product pages, clicking "Add to Cart," and deleting cart rows. These requests go directly from your browser to Amazon, using your existing Amazon session, exactly as if you had clicked the buttons yourself. Some of these actions **write** to your Amazon account: creating a list, adding items to it, and removing items from your cart.

**About the `tag=` parameter in add-to-cart links.** If you inspect the URLs the extension opens when sending a whole cart to your Amazon cart, you'll see an Amazon Associates–style parameter (`tag=styxmcart-20`). Amazon's bulk add-to-cart endpoint refuses to render the items without one, so the extension supplies a placeholder to make the feature work. **It is not a registered Associates account, and we earn no commission or referral fee from your purchases.** The parameter carries no information about you and does not track your browsing.

### 2. Requests to the payment / license provider (Premium only)

If you purchase a Premium subscription, the extension uses [ExtensionPay](https://extensionpay.com) (which uses [Stripe](https://stripe.com) for payment processing). In that context:

- When you click **Upgrade**, the extension opens an ExtensionPay-hosted checkout page in a new tab. You enter your payment details on that page, where they are handled by Stripe directly. **We never see or store your credit-card number, billing address, or other payment details.** Card information is governed by [Stripe's privacy policy](https://stripe.com/privacy) and [ExtensionPay's privacy policy](https://extensionpay.com/privacy).
- After purchase, the extension stores an opaque license token locally and periodically (about once a day) checks with ExtensionPay's servers to confirm the subscription is still active. The check transmits only the license token; it does not transmit any cart contents, browsing history, or personally identifiable information from this extension.
- If you cancel your subscription or it lapses, the extension returns to free-tier behavior on the next license check. Your carts are never deleted — they live in your Amazon account, and carts over the free limit simply become read-only in the extension.

Users who **never click the Upgrade button** are never contacted by ExtensionPay or Stripe, and no payment-related data is generated — the SDK short-circuits to a local "not paid" response without making any network request.

Users who click Upgrade (whether or not they complete the purchase) have a randomly generated ExtensionPay API key written into their local `chrome.storage.local`, and the daily license-status check begins from that point. The check transmits only the opaque API key and never reveals which Amazon storefronts you use, which carts you've saved, or any other behavioral data from this extension.

## Permissions

The extension requests the following Chrome permissions, each used solely for the purpose described:

- **`storage`** — to keep your preferences, entitlement record, and license token locally on your device.
- **`activeTab`** — to read the Amazon tab you're on when you ask the extension to act on it.
- **`scripting`** — to inject the extension's own interface and helpers into Amazon pages: the floating button and panel, the cart and list buttons, the product-page cart picker, the status overlay, and the readers/drivers used to empty a cart, save it, or send one to your Amazon cart.
- **`tabs`** — to open and close the helper tabs used when saving a cart or sending one to your Amazon cart (and the ExtensionPay checkout tab if you purchase Premium).
- **`alarms`** — to schedule the roughly-daily Premium license check.
- **Host permissions for `*.amazon.com` and 11 other Amazon regional domains** — the extension's entire purpose is to interact with your cart and lists on whichever regional storefront you use.

A more detailed per-permission justification is on the [permissions page](permissions.html).

## Children

The extension is not directed to children under 13 and does not knowingly collect any data from anyone.

## Changes to this policy

If the extension's data handling changes in the future, this page will be updated and the "Last updated" date at the top will be revised. Material changes will also be noted in the extension's release notes on the [GitHub repository](https://github.com/AllBallBearings/styx-multi-cart/releases).

## Contact

Questions, complaints, or takedown requests:

- File an issue at <https://github.com/AllBallBearings/styx-multi-cart/issues>
- Email: jaredgoolsby@gmail.com
