# store-assets/

Assets uploaded to the Chrome Web Store listing form. **Not bundled into the extension zip.**

## What goes where

| File | Chrome Web Store field | Size | Status |
|------|------------------------|------|--------|
| `product-logo.svg` | Product logo master | SVG, scalable | ✅ done |
| `product-logo-512.png` | Stripe / website product logo | 512×512 PNG | ✅ done — regenerate via `node store-assets/_render_product_logo.js` |
| `product-logo-1024.png` | High-resolution product logo | 1024×1024 PNG | ✅ done — regenerate via `node store-assets/_render_product_logo.js` |
| `product-logo-2048.png` | Extra-large product logo | 2048×2048 PNG | ✅ done — regenerate via `node store-assets/_render_product_logo.js` |
| `icon-128.png` | Store icon | 128×128 PNG | ✅ done (copied from `icons/icon128.png`) |
| `promo-440x280.png` | Small promo tile | 440×280 PNG (no transparency) | ✅ done — regenerate via `python3 store-assets/_render_promo.py` |
| `promo-1400x560.png` | Marquee promo tile | 1400×560 PNG (no transparency) | ✅ done — regenerate via `python3 store-assets/_render_promo.py` |
| `screenshots/01-popup.png` | Screenshot 1 | 1280×800 PNG | ✅ done — Amazon cart beside the side panel with 2 saved carts |
| `screenshots/02-switchCart.png` | Screenshot 2 | 1280×800 PNG | ✅ done — "Switch to this cart?" confirmation |
| `screenshots/03-clickToAdd.png` | Screenshot 3 | 1280×800 PNG | ✅ done — add-to-cart interception callout |
| `screenshots/04-toCart.png` | Screenshot 4 | 1280×800 PNG | ✅ done — "Add to which saved cart?" picker modal |

Optional (defer until after initial launch):

- `promo-920x680.png` — large promo tile (improves featured-section placement)
- demo video (YouTube link, 30s)

## How to capture screenshots

1. Open Chrome at 1280×800 (or use a 1280×800 capture region). DevTools device toolbar can force this.
2. Load the extension unpacked, open Amazon, populate the cart with 3-5 test items.
3. Save the cart under 2-3 different names so the popup has content.
4. Capture each screenshot. macOS: `cmd-shift-4` then space-bar over the window, or use a tool like CleanShot.
5. Crop/scale to exactly 1280×800 if needed. Save as PNG, sRGB.

## Promo tile spec

- 440×280 PNG, sRGB, no transparency.
- Brand: navy (#0b1a2b or similar) gradient, Styx logo on left, tagline "Multiple carts. One click." on right.
- Keep critical content inside a 400×240 safe area (some browsers crop edges).
- Avoid screenshots or UI mockups inside the tile — Google rejects tiles that look like screenshots.
