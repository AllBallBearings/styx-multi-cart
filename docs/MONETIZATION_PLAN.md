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

## Pricing

- **Free tier**: 2 extension-managed saved carts (= 3 total shopping contexts including Amazon's live cart)
- **Premium**: **$4.99/year**, up to **20 saved carts**

### Pricing rationale
- Goal is reach + "no-brainer" conversion, not margin optimization.
- $4.99/yr sits in the impulse-purchase zone; the conversion cliff between $4.99 and $9.99 is steeper than the revenue gain for an unproven utility extension.
- Cap of 20 chosen as plenty for realistic use; can be raised later if demand emerges. Performance-test at ~50 so the cap is a product decision, not a technical one.
- Market "20 saved carts" cleanly; don't claim unlimited.

---

## Entitlement Model

Three states:
1. **Free / trial** — `savedCartsCount < 2`
2. **Free / exhausted** — `savedCartsCount >= 2`, no license
3. **Premium** — valid license, up to 20 saved carts

### The Amazon cart is first-class and always free
Even an expired premium user keeps Amazon-cart passthrough functionality. The extension must never brick core functionality on payment lapse — important for store review and user trust.

---

## Lapsed Premium Behavior

When a premium subscription expires and the user has more than 2 saved carts:

- **Top 2 by `lastUsedAt`**: behave exactly like free tier (full edit, move to/from Amazon cart).
- **Carts 3–20**: visible but **pure read-only reference**.
  - ✅ View items, names, prices (cached/stale, with "data may be outdated" note)
  - ✅ Delete the cart entirely (let them clean up)
  - ❌ Add, remove, rename, reorder items
  - ❌ Move to Amazon cart
  - ❌ Restore as active without renewing
- Persistent (non-dismissible) banner: *"Renew to unlock N saved carts"*

### Auto-promotion on deletion
If a lapsed user deletes one of their top-2 active carts, the next-most-recent locked cart auto-promotes to active. The user always has exactly 2 active slots — consistent with free-tier mental model.

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
- `editableCartIds = isPremium ? all : top2ByLastUsed(carts)`

### Storage location
- **Local storage** (`chrome.storage.local`) for `cartsUsed` / cart data — simple, no auth for free users.
- Acceptable that determined users could reset by reinstalling; at $4.99/yr the friction isn't worth gaming.
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

- Triggered on attempted 3rd saved cart creation.
- Framing: *"You're using all your saved carts — unlock up to 20 for $4.99/yr"* (not "Limit reached").
- Acknowledges the user is getting value, doesn't feel like a wall.

---

## Payment Provider

### Chrome (launch)
- **Stripe** directly, or **ExtensionPay** (turnkey wrapper around Stripe, ~5% fee on top of Stripe fees).
- Backend: small license-verify endpoint (Cloudflare Worker is sufficient).
- Stripe webhook → server updates `premiumUntil`; extension pulls on next daily check.

### Apple (future)
- StoreKit auto-renewing subscription at same $4.99/yr.
- Wrapper app handles purchase; writes entitlement to shared App Group storage; extension reads it.

---

## Build Order

1. ✅ Decisions captured (this doc)
2. ✅ **Core entitlement + gate logic** (purely ours, provider-agnostic) — _shipped 2026-05-21_
   - ✅ Entitlement object + daily lazy license check
   - ✅ `canCreateSavedCart()` / `canEditCart(cartId)` gates
   - ✅ `lastUsedAt` tracking on every cart interaction
   - ✅ Derived `activeCartIds = top2ByLastUsed` when not premium
3. ✅ **UI states**: active / locked-readonly / banners (lapsed) — _shipped 2026-05-25_
   - ✅ Tier strip "X / 2 carts (Free)" near header
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

- **Pinning**: ship without; add if users complain about "wrong 2 carts active" after lapse.
- **Performance cap raise**: profile actual ceiling; raise from 20 if demand emerges.
- **Lifetime $9.99 one-time option**: considered, deferred — rules out cloud-sync upside later.
- **Naming**: confirm UI consistently frames Amazon cart as part of the set ("Active Cart" + "Saved Cart 1/2") so free tier reads as 3 total contexts.
- **Stale data warning** for read-only lapsed carts when prices/availability may have changed.
