# Chrome Web Store — Listing Copy

Paste these into the Chrome Web Store Developer Dashboard listing form. Keep the
`store-assets/` media as-is; this file is just the text.

> **Claim discipline:** every line here is checked against shipping behavior.
> Don't introduce "instantly" or "in seconds" (clearing runs item by item,
> ~2–4s each), inline item editing (Amazon-list carts are read-only in the
> panel), a toolbar popup or side panel (only the in-page floating panel
> ships), or Safari/Firefox availability (Chrome Web Store only).
>
> **"One click" is a deliberate owner decision, not an oversight.** Clearing
> actually takes two clicks — the button, then a choice in the confirm dialog
> ("Save & Clear" / "Just Clear"). The owner opted to keep the phrase. Don't
> "fix" it to something weaker without asking; equally, don't propagate it to
> _other_ actions, where it has never been true.

---

## Name

Styx Multi-Cart — Multiple Amazon Carts

## Short description (max 132 chars)

Empty your Amazon cart, save it for later, and manage multiple carts with reusable Amazon Lists.

> 96 chars. The key search terms lead the sentence: empty Amazon cart, save it for later,
> multiple carts, and Amazon Lists.

## Category

Shopping

---

## Detailed description

**Need multiple Amazon carts? Styx Multi-Cart is a Chrome extension for emptying a crowded cart, saving items for later, and restoring separate carts when you are ready to check out.**

Shopping carts get mixed together quickly: gifts, groceries, work supplies, and items you are still comparing all compete for one checkout. Styx turns **Amazon Lists** into reusable carts, so each purchase can stay organized and separate.

**What it does**

🧹 **Empty an Amazon cart** — clear the live cart without removing products one at a time. Clearing is free and unlimited, and **Saved for Later** is never touched. Larger carts are processed item by item, so give Styx a moment to finish.

💾 **Save an Amazon cart for later** — preserve the current items in a new list before clearing. The saved cart stays in your account and is ready whenever you want to return to it.

🛒 **Manage multiple carts** — use the floating Styx button to open a draggable cart organizer. Keep a list for gifts, groceries, travel, or a home project; the **Go to Carts** control opens your lists page, where optional relabeling calls them **Your Styx Carts**.

⚡ **Restore a cart for checkout** — choose **Send All to Amazon Cart** to load a whole list back into the live cart. Out-of-stock items are skipped, and books prompt for the edition or format you want.

⭐ **Add products to the right cart while browsing** — use **Add to a Styx cart** beside Amazon's normal Add to Cart button to build a separate purchase without sending it to checkout yet.

🌍 **Keep your account as the source of truth** — Styx carts are Amazon Lists, so they remain in your account across devices. No Styx account, import, or separate sync service is required.

🌗 **Light and dark mode** plus an optional pulse on the floating button.

🔒 **Private by design** — the extension works between your browser and Amazon. There is no Styx server, analytics, or browsing tracking.

**Affiliate disclosure**

To send a whole cart back to Amazon in one step, Styx uses Amazon's bulk add-to-cart endpoint, which will not add your items unless the link includes an Amazon Associates tag (`tag=styxmcart-20`). Styx includes this placeholder tag **only so bulk cart restore works** — it is **not a registered Associates account**, and Styx **earns no commission, referral fee, or other compensation** from your purchases. You can review this any time in the extension's **Settings → Affiliate disclosure** and on our permissions page.

**Free & Premium**

- **Free** — emptying your cart and saving it are **always free and unlimited**, plus **3 carts** with every core action: send to your Amazon cart and add while you browse.
- **Premium** — **unlimited carts**. **$9.99/year**, or **$19.99 once** for lifetime access.

Your live Amazon cart is always first-class and always free — Styx never breaks core Amazon shopping, even if Premium lapses.

---

## Notes for reviewer / permissions justification

Accesses `amazon.com` pages to read your lists and cart and to add/remove items on your behalf (for example, emptying your cart, saving your cart into a new list, or sending a cart to your Amazon cart). Settings and preferences are stored locally (`chrome.storage.local`); cart and list contents live in the user's own Amazon account, not in the extension and not on any server of ours. The only non-Amazon network requests are to `extensionpay.com` for Premium licensing, and only after a user clicks Upgrade; no cart contents or PII are ever transmitted. Bulk add-to-cart URLs carry an Amazon Associates–style `tag=` parameter (`styxmcart-20`) because Amazon's bulk add-to-cart endpoint will not render items without one. It is a placeholder, not a registered Associates account, and the extension earns no commission or referral fee; this is stated in the privacy policy and permissions page.

**Re: affiliate-ads policy (previous rejection "Grey Titanium").** The `tag=` parameter above is now disclosed prominently to users in three places: (1) this Store description, under **Affiliate disclosure**; (2) the extension UI, under **Settings → Affiliate disclosure**; and (3) before installation, via the disclosure in the Store listing and the linked permissions page. The tag exists solely so Amazon's bulk endpoint will restore a saved cart; the extension is not enrolled in Amazon Associates and earns nothing from it.
