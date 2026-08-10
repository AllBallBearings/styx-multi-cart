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

Styx Multi-Cart — Simply Clear, Save, or Restore

## Short description (max 132 chars)

Styx Multi-Cart — Simply Clear, Save, or Restore your Amazon cart and the items you have in it.

> 95 chars. Alt (leads on the carts):
> `One click to clear your Amazon cart, or save it for a later checkout. Your Amazon lists become reusable carts.` (109)

## Category

Shopping

---

## Detailed description

**Styx Multi-Cart gives your Amazon cart three simple actions: clear it, save it, or restore it when you are ready to check out.**

Amazon carts get cluttered fast. A few things you need now, a few things you might buy later, and a few things you are only comparing can all end up in the same checkout path. Amazon makes you remove cart items one at a time, so clearing the cart becomes tedious.

Styx makes that simple. Use it to clear your current Amazon cart, keep **Saved for Later** untouched, and optionally save the items before they disappear from checkout.

The key idea is that Styx repurposes **Amazon Lists** as reusable carts. Save a cart full of items into an Amazon list, keep building it over time, then send that whole list back to your Amazon cart in bulk when you are ready to buy. Use one list for groceries, one for gifts, one for a home project, one for travel, or any other checkout you want to keep separate.

**What it does**

🧹 **Clear your Amazon cart** — remove the items in your current cart without deleting them one at a time. Clearing is free and unlimited, and **Saved for Later** is never touched. Larger carts clear item by item, so give Styx a moment to work through them.

💾 **Save a cart for later** — before clearing, Styx can save the cart items into a new Amazon list. The items stay in your Amazon account as a reusable Styx cart instead of sitting in your live checkout cart.

🛒 **Turn Amazon Lists into carts** — a floating Styx button rides along on Amazon; click it to open a draggable panel with your carts. A **Go to Carts** button jumps you straight to them on Amazon, where Styx renames "Your Lists" to **Your Styx Carts** and adds "Cart" to each list name (toggle the relabeling off anytime).

⚡ **Restore a saved cart in bulk** — when you are ready, use **Send All to Amazon Cart** to load an entire saved cart back into your Amazon cart for checkout. Out-of-stock items are skipped automatically, and for books Styx asks which edition or format you want.

⭐ **Add items to the right cart while browsing** — Styx puts a branded **Add to a Styx cart** button next to **Add to Cart** on product pages, so you can build the right saved cart without sending everything to checkout immediately.

🌍 **Use Amazon as the source of truth** — your Styx carts _are_ Amazon lists, stored in your Amazon account. There is nothing to sync, nothing to sign up for, and no Styx account to manage.

🌗 **Light & dark mode**, and a **pulse** on the floating button you can switch off in Settings.

🔒 **Private by design** — Styx works entirely between your browser and Amazon. There is no Styx server, and no analytics or tracking of your browsing.

**Affiliate disclosure**

To send a whole cart back to Amazon in one step, Styx uses Amazon's bulk add-to-cart endpoint, which will not add your items unless the link includes an Amazon Associates tag (`tag=styxmcart-20`). Styx includes this placeholder tag **only so bulk cart restore works** — it is **not a registered Associates account**, and Styx **earns no commission, referral fee, or other compensation** from your purchases. You can review this any time in the extension's **Settings → Affiliate disclosure** and on our permissions page.

**Free & Premium**

- **Free** — emptying your cart and saving it are **always free and unlimited**, plus **3 carts** with every core action: send to your Amazon cart and add while you browse.
- **Premium** — **unlimited carts**. **$9.99/year**, or **$19.99 once** for lifetime access.

Your live Amazon cart is always first-class and always free — Styx never breaks core Amazon shopping, even if Premium lapses.

Works on Chrome, Edge, Brave, Arc, Opera, Vivaldi and other Chromium browsers.

---

## Notes for reviewer / permissions justification

Accesses `amazon.com` pages to read your lists and cart and to add/remove items on your behalf (for example, emptying your cart, saving your cart into a new list, or sending a cart to your Amazon cart). Settings and preferences are stored locally (`chrome.storage.local`); cart and list contents live in the user's own Amazon account, not in the extension and not on any server of ours. The only non-Amazon network requests are to `extensionpay.com` for Premium licensing, and only after a user clicks Upgrade; no cart contents or PII are ever transmitted. Bulk add-to-cart URLs carry an Amazon Associates–style `tag=` parameter (`styxmcart-20`) because Amazon's bulk add-to-cart endpoint will not render items without one. It is a placeholder, not a registered Associates account, and the extension earns no commission or referral fee; this is stated in the privacy policy and permissions page.

**Re: affiliate-ads policy (previous rejection "Grey Titanium").** The `tag=` parameter above is now disclosed prominently to users in three places: (1) this Store description, under **Affiliate disclosure**; (2) the extension UI, under **Settings → Affiliate disclosure**; and (3) before installation, via the disclosure in the Store listing and the linked permissions page. The tag exists solely so Amazon's bulk endpoint will restore a saved cart; the extension is not enrolled in Amazon Associates and earns nothing from it.
