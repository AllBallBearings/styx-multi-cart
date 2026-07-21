# Monetization & Premium Tier Plan

Decisions captured for the free/premium model across Chrome Web Store (launch) and Apple App Store (later, via Safari Web Extension).

---

## Core Strategy

**One extension, not two.** Single listing on each store with premium features unlocked via in-app entitlements. No separate "Free" and "Pro" builds.

### Why

- Chrome Web Store's paid/licensing API was deprecated in 2020 — payments must be handled externally anyway.
- Apple requires StoreKit / IAP for digital goods inside the wrapper app — same gate-on-entitlement pattern.
- Same JS feature flags on both platforms; only the payment/entitlement source differs.

---

## Current Model (updated 2026-07-14)

The product pivoted: **Amazon lists ARE the carts** — the extension surfaces the user's Amazon wish lists rather than a separate local-cart store. The tier limits below now apply to **custom Amazon lists**, with these adjustments from the original plan:

- **Free tier = 3 custom carts** (raised from 2 — a "Wish List" is not auto-created for new Amazon accounts, so the original count was low).
- **Amazon's own default lists don't count** and are always usable: the account **Default List** (Wish List) and the **Alexa Shopping List**. The 3-cart limit is for the user's _own_ custom lists, on top of these.
- **Premium unlocks all custom lists** (no 20-cap on the Amazon-list path — locking a paying user's real Amazon lists would be user-hostile). The "up to 20" figure below is legacy/marketing for the local-cart model.
- **List creation is never blocked** (avoids making the extension a target for Amazon). Over-limit custom carts render **grayed/locked** in the extension, lose the "send all to Amazon cart" action, and open the paywall on click.

Gate logic: `computeListAccess()` in `lib/helpers.js` (mirrored in `src/background/index.js`); `FREE_CART_LIMIT = 3` (single source, shared with the dormant local-cart gate). The local-cart sections below remain accurate for the dormant `mc.carts.v1` model and the shared gate constants; treat their "2" as the historical value now superseded by 3.

---

## Pricing

- **Free tier**: 3 extension-managed saved carts (= 4 total shopping contexts including Amazon's live cart)
- **Premium**: **Unlimited carts**, two ways to buy:
  - **$9.99/year** — annual subscription
  - **$19.99 one-time** — lifetime access

### Pricing rationale

- Goal is reach + "no-brainer" conversion, not margin optimization.
- The annual subscription funds ongoing maintenance (Amazon DOM changes break scrapers); the lifetime option captures subscription-averse buyers at ~2× the annual.
- Cap of 20 chosen as plenty for realistic use; can be raised later if demand emerges. Performance-test at ~50 so the cap is a product decision, not a technical one.

---

## Entitlement Model

Three states:

1. **Free / trial** — `savedCartsCount < 3`
2. **Free / exhausted** — `savedCartsCount >= 3`, no license
3. **Premium** — valid license, unlimated carts based on Amazon Lists (local-cart model; unlimited on the Amazon-list path)

### The Amazon cart is first-class and always free

Even an expired premium user keeps Amazon-cart passthrough functionality. The extension must never brick core functionality on payment lapse — important for store review and user trust.

---

## Lapsed Premium Behavior

When a premium subscription expires and the user has more than 3 saved carts:

- **Top 3 by `lastUsedAt`**: behave exactly like free tier (full edit, move to/from Amazon cart).
- **Carts 4–20**: visible but **pure read-only reference**.
  - ✅ View items, names, prices (cached/stale, with "data may be outdated" note)
  - ✅ Delete the cart entirely (let them clean up)
  - ❌ Add, remove, rename, reorder items
  - ❌ Move to Amazon cart
  - ❌ Restore as active without renewing
- Persistent (non-dismissible) banner: _"Renew to unlock N saved carts"_

### Auto-promotion on deletion

If a lapsed user deletes one of their top-3 active carts, the next-most-recent locked cart auto-promotes to active. The user always has exactly 3 active slots — consistent with free-tier mental model.

### Rationale for strict read-only

Allowing "move to Amazon cart" on lapsed carts was considered and rejected — too much surface area for "is this allowed?" edge cases. Clean rule: **lapsed carts are pure reference material.** If users want to act on them, they can manually re-add the items.

---

## Renewal Warnings

Three touchpoints, only shown when **auto-renew will actually fail** (expired card, canceled sub, etc.). Healthy auto-renewing subs get **no warnings** — silent renewal is the whole point.

1. **30 days out**: subtle banner in extension UI, dismissible. "Premium renews in 30 days" + manage-billing link.
2. **7 days out**: stronger banner, still dismissible. Add "Update payment method" if Stripe flagged the card as expiring.
3. **Day of / day after lapse**: one email (if available) + persistent in-extension banner, not dismissible until renewed or explicitly acknowledged.

### Cross-platform note

When Safari/iOS ships, StoreKit handles its own renewal warnings — suppress in-extension warnings for App Store users to avoid duplicate notifications. Entitlement object should carry `source: "stripe" | "appstore"` from day one.

---

## Data Model Sketch

```js
entitlement: {
  tier: "free" | "premium",
  premiumUntil: <timestamp> | null,
  autoRenew: boolean,
  source: "stripe" | "appstore",
  lastChecked: <timestamp>
}

carts: [
  {
    id,
    name,
    items[],
    createdAt,
    lastUsedAt,
    pinned: boolean    // reserved for future
  }
]
```

### Derived at render time

- `isPremium = entitlement.tier === "premium" && now < entitlement.premiumUntil`
- `editableCartIds = isPremium ? all : top3ByLastUsed(carts)`

### Storage location

- **Local storage** (`chrome.storage.local`) for `cartsUsed` / cart data — simple, no auth for free users.
- Acceptable that determined users could reset by reinstalling; at this price point the friction isn't worth gaming.
- Entitlement verification: lazy + cached (re-verify with license server ~once/day), so the extension stays fast and works offline.

---

## Gate Functions

Single source of truth for limits:

```js
canCreateSavedCart() → { allowed, reason, remaining }
canEditCart(cartId)  → { allowed, reason }
```

Every "new cart" and "edit cart" entry point calls these. Paywall UI, badge counter, and backend all read from the same logic.

---

## Paywall UX

- Triggered on attempted 4th saved cart creation.
- Framing: _"You're using all your saved carts — unlock up to 20 for $9.99/yr or $19.99 once"_ (not "Limit reached").
- Acknowledges the user is getting value, doesn't feel like a wall.

---

## Payment Provider

### Chrome (launch)

- **Stripe** directly, or **ExtensionPay** (turnkey wrapper around Stripe, ~5% fee on top of Stripe fees).
- Backend: small license-verify endpoint (Cloudflare Worker is sufficient).
- Stripe webhook → server updates `premiumUntil`; extension pulls on next daily check.

### Apple (future)

- StoreKit auto-renewing subscription at same $9.99/yr.
- Wrapper app handles purchase; writes entitlement to shared App Group storage; extension reads it.

---

## Build Order

1. ✅ Decisions captured (this doc)
2. ✅ **Core entitlement + gate logic** (purely ours, provider-agnostic) — _shipped 2026-05-21_
   - ✅ Entitlement object + daily lazy license check
   - ✅ `canCreateSavedCart()` / `canEditCart(cartId)` gates
   - ✅ `lastUsedAt` tracking on every cart interaction
   - ✅ Derived `activeCartIds = top3ByLastUsed` when not premium
3. ✅ **UI states**: active / locked-readonly / banners (lapsed) — _shipped 2026-05-25_
   - ✅ Tier strip "X / 3 carts (Free)" near header
   - ✅ Lapsed banner "Renew to unlock N saved carts" (non-dismissible-by-default; now snooze-dismissible 7d)
   - ✅ Read-only lock pill on locked carts (`Read-Only — Go Premium?`) → opens paywall
   - ✅ Premium flair badge in header (replaces tier strip when premium)
   - ✅ Conditional render: lapsed banner pre-empts tier strip (no double-banner)
   - ✅ Dismiss × on tier strip + lapsed banner with 7-day snooze model
   - ✅ In-popup paywall modal (placeholder "Coming soon" CTA pending Stripe wiring)
   - ✅ In-popup `confirmDialog()` / `promptDialog()` replacing native `confirm()` / `prompt()`
   - ✅ Toast restyled to match modal card aesthetic
   - ✅ Debug panel for entitlement-state toggling (Ctrl+Alt+D / 5-click tagline backup) — gated behind dev flag
   - [ ] 30-day / 7-day renewal warning banners (deferred until Phase 5 — depends on real `premiumUntil` from Stripe)
4. **Chrome Web Store prep** (listing assets, manifest, privacy, permissions justification) — _next up_
   - [ ] Strip / wrap `console.error` / `console.warn` behind `DEBUG` build flag
   - [ ] Hide `#mc-debug` panel behind compile-time `DEBUG` or remove for store build
   - [ ] `LICENSE` file
   - [ ] Privacy policy page (hosted)
   - [ ] Permissions justification doc
   - [ ] Manifest polish: `homepage_url`, `author`, long description, version bump to `0.x.y`
   - [ ] Store assets: 440×280, 920×680, 1400×560, 1280×800 screenshots
5. **Stripe integration** + webhook → server updates `premiumUntil`
6. **Paywall trigger** wired to real checkout (popup paywall modal already exists — just needs CTA action)
7. Ship to Chrome Web Store
8. Later: Safari wrapper + StoreKit for App Store

---

## Open Questions / Future

- **Pinning**: ship without; add if users complain about "wrong 3 carts active" after lapse.
- **Performance cap raise**: profile actual ceiling; raise from 20 if demand emerges.
- **Lifetime $9.99 one-time option**: considered, deferred — rules out cloud-sync upside later.
- **Naming**: confirm UI consistently frames Amazon cart as part of the set ("Active Cart" + "Saved Cart 1/3") so free tier reads as 4 total contexts.
- **Stale data warning** for read-only lapsed carts when prices/availability may have changed.
