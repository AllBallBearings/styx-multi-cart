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
> ("Save & Empty" / "Just Empty"). The owner opted to keep the phrase. Don't
> "fix" it to something weaker without asking; equally, don't propagate it to
> *other* actions, where it has never been true.

---

## Name
Styx Multi-Cart — Clear your Amazon cart

## Short description (max 132 chars)
One click to clear your Amazon cart — or save it for a later checkout. Free, unlimited, Saved for Later untouched.

> 113 chars. Alt (leads on the carts):
> `One click to clear your Amazon cart, or save it for a later checkout. Your Amazon lists become reusable carts.` (109)

## Category
Shopping

---

## Detailed description

**One click to clear your Amazon cart — or save it for a later checkout. Amazon never gave you an Empty Cart button. Styx does, and it makes sure clearing costs you nothing.**

Your cart is doing three jobs at once: the things you're buying now, the things you're still thinking about, and the things you'll get around to eventually. Amazon makes you delete items one at a time, so you never clear it — and the one thing you actually want to buy ends up buried under forty things you don't.

Styx empties the whole cart for you. Free, unlimited, and your **Saved for Later** items stay exactly where they are. And when you clear it, Styx offers to save the cart for a **later checkout** — a reusable **Styx cart** that waits in your Amazon account until you're ready to buy.

That's when the real thing clicks: **every Amazon list is a cart.** Keep one for the birthday, one for the holidays, one for the weekly grocery run, one for the home project. Build each over time, then send the whole thing to your Amazon cart when you're ready to buy.

**What it does**

🧹 **Empty your Amazon cart from one button** — no more deleting items one at a time. Free, unlimited, and Saved for Later is never touched. Larger carts clear item by item, so give it a moment to work through them.

💾 **Or save it for a later checkout** — when you clear your cart, Styx offers to save everything in it as a new cart in your Amazon account first. Clear with a clean conscience; it's all still there, ready to check out whenever you are.

🛒 **Every list is a cart, in one floating panel** — a floating Styx button rides along on Amazon; click it to pop open a draggable panel with all your carts, and click anywhere off it to tuck it away. A **Go to Carts** button jumps you straight to them on Amazon, where Styx renames "Your Lists" to **Your Styx Carts** and adds "Cart" to each list name (toggle the relabeling off anytime).

⚡ **Send a whole cart to checkout** — the **Send All to Amazon Cart** button loads an entire cart into your Amazon cart, ready to check out. Out-of-stock items are skipped automatically, and for books it asks which edition or format you want.

⭐ **Add to a cart while you browse** — Styx puts a branded **Add to a Styx cart** button right next to **Add to Cart** on every product page, so filling the right cart is as easy as buying.

🌍 **Already on all your devices** — your carts *are* your Amazon lists, stored in your Amazon account. Nothing to sync, nothing to sign up for, nothing of yours on our servers.

🌗 **Light & dark mode**, and a **pulse** on the floating button you can switch off in Settings.

🔒 **Private by design** — Styx works entirely between your browser and Amazon. There is no Styx server, and no analytics or tracking of your browsing.

**Free & Premium**

- **Free** — emptying your cart and saving it are **always free and unlimited**, plus **3 carts** with every core action: send to your Amazon cart and add while you browse.
- **Premium** — **unlimited carts**. **$9.99/year**, or **$19.99 once** for lifetime access.

Your live Amazon cart is always first-class and always free — Styx never breaks core Amazon shopping, even if Premium lapses.

Works on Chrome, Edge, Brave, Arc, Opera, Vivaldi and other Chromium browsers.

---

## Notes for reviewer / permissions justification
Accesses `amazon.com` pages to read your lists and cart and to add/remove items on your behalf (for example, emptying your cart, saving your cart into a new list, or sending a cart to your Amazon cart). Settings and preferences are stored locally (`chrome.storage.local`); cart and list contents live in the user's own Amazon account, not in the extension and not on any server of ours. The only non-Amazon network requests are to `extensionpay.com` for Premium licensing, and only after a user clicks Upgrade; no cart contents or PII are ever transmitted. Bulk add-to-cart URLs carry an Amazon Associates–style `tag=` parameter (`styxmcart-20`) because Amazon's bulk add-to-cart endpoint will not render items without one. It is a placeholder, not a registered Associates account, and the extension earns no commission or referral fee; this is stated in the privacy policy and permissions page.
