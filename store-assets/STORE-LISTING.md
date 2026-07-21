# Chrome Web Store — Listing Copy

Paste these into the Chrome Web Store Developer Dashboard listing form. Keep the
`store-assets/` media as-is; this file is just the text.

---

## Name
Styx Multi-Cart — Amazon carts from your lists

## Short description (max 132 chars)
Supercharge your Amazon lists into reusable carts. Fill one per occasion and send it to your Amazon cart in one click.

> 118 chars. Alt (shorter):
> `Turn Amazon lists into reusable carts — a cart per occasion, sent to checkout in one click. 3 free.` (98)

## Category
Shopping

---

## Detailed description

**Supercharge your Amazon lists. Styx repurposes them as reusable carts you fill with items and move to checkout in one click — so you can keep a separate cart for every occasion and purpose.**

Amazon gives you one cart and buries your lists. Styx Multi-Cart turns those lists into flexible, reusable **carts** — and relabels Amazon's own Lists page to match — so you can shop the way you actually think: a cart for the birthday, a cart for the holidays, a cart for the weekly grocery run, a cart for the home project. Build each one over time, then drop the whole thing into your Amazon cart when you're ready to buy.

**What it does**

🛒 **Every list is a cart, in one floating panel** — a floating Styx button rides along on Amazon; click it to pop open a draggable panel with all your carts, and click anywhere off it to tuck it away. A **Go to Carts** button jumps you straight to them on Amazon, where Styx renames "Your Lists" to **Your Styx Carts** and adds "Cart" to each list name (toggle the relabeling off anytime).

⚡ **Send a whole cart to checkout** — the **Send All to Amazon Cart** button loads an entire cart into your Amazon cart at once, ready to check out. Out-of-stock items are skipped automatically, and for books it asks which edition or format you want.

⭐ **Add to a cart while you browse** — Styx puts a branded **Add to a Styx cart** button right next to **Add to Cart** on every product page, so filling the right cart is as easy as buying.

💾 **Save your Amazon cart into a new cart** — one click on the Amazon cart page saves everything currently in your cart into a brand-new cart, so you can empty your cart and shop something else without losing a thing.

🧹 **Clear your Amazon cart in one click** — empty your live cart instantly for a fresh session. Your carts stay untouched.

🌍 **Synced across your devices** — your carts are backed by your Amazon account, so they follow you everywhere you sign in.

🌗 **Light & dark mode**, and a **pulse** on the floating button you can switch off in Settings.

🔒 **Private by design** — Styx works entirely between your browser and Amazon. No external servers read your carts, no tracking.

**Free & Premium**

- **Free** — up to **3 carts**, with every core action: send to your Amazon cart, add while you browse, save your cart, and clear it.
- **Premium** — **unlimited carts**. **$9.99/year**, or **$19.99 once** for lifetime access.

Your live Amazon cart is always first-class and always free — Styx never breaks core Amazon shopping, even if Premium lapses.

Works on Chrome, Edge, Brave, Arc, Opera, Vivaldi and other Chromium browsers. A Safari version is also available.

---

## Notes for reviewer / permissions justification
Accesses `amazon.com` pages to read your lists and cart and to add/remove items on your behalf (for example, sending a cart to your Amazon cart or saving your cart into a new list). Settings and preferences are stored locally (`chrome.storage.local`). The only non-Amazon network requests are to `extensionpay.com` for Premium licensing, and only after a user clicks Upgrade; no cart contents or PII are ever transmitted.
