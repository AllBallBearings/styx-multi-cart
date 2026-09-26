#!/usr/bin/env python3
"""Generate the Styx Multi-Cart logo SVGs (the single source of truth).

Writes, next to this file:
  product-logo.svg        detailed rounded-tile master (store, website, >=64px)
  product-logo-small.svg  simplified rounded tile for 16-48px toolbar sizes
  product-logo-square.svg full-bleed square (iOS-style universal icon, no corners)

Then `node store-assets/_render_logo_assets.mjs` renders every PNG from them.

Usage: python3 store-assets/_build_logo.py
"""
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def squircle(n=5.0, r=512.0, c=512.0, steps=240):
    """Superellipse approximating Apple's continuous-corner icon shape."""
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        ct, st = math.cos(t), math.sin(t)
        x = c + r * math.copysign(abs(ct) ** (2 / n), ct)
        y = c + r * math.copysign(abs(st) ** (2 / n), st)
        pts.append(f"{x:.1f} {y:.1f}")
    return "M" + " L".join(pts) + " Z"


def wave(y0, amp, wavelength=256.0, phase=0.0, x0=-64.0, x1=1088.0, step=8.0):
    """Smooth sine crest as a polyline path (no closing)."""
    pts, x = [], x0
    while x <= x1:
        y = y0 + amp * math.sin((x + phase) / wavelength * 2 * math.pi)
        pts.append(f"{x:.1f} {y:.1f}")
        x += step
    return "M" + " L".join(pts)


def cart(x, y, s, detail=True):
    """Outline cart, drawn from the same 24-unit geometry as the cart icons in
    the extension UI (observer.js / popup.html), scaled x11. (x, y) is the
    glyph's top-left, s the scale. Glyph spans x 15..241, y 26..239 (detail) / 249 (small)."""
    sw = 24 if detail else 31      # bolder stroke when small
    r = 25 if detail else 30       # wheel radius
    cy = 214 if detail else 219    # wheel centre y (just clear of the basket stroke)
    return f"""
    <g transform="translate({x:.1f} {y:.1f}) scale({s})" filter="url(#cartShadow)">
      <path d="M27.5 38.5 h24.2 l24.2 122.1 a14.3 14.3 0 0 0 14.08 11.55 h91.3
               a14.3 14.3 0 0 0 13.97 -11.22 L228.8 82.5 H66"
            fill="none" stroke="url(#amber)" stroke-width="{sw}"
            stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="99" cy="{cy}" r="{r}" fill="url(#amberDeep)"/>
      <circle cx="187" cy="{cy}" r="{r}" fill="url(#amberDeep)"/>
    </g>"""


def build(shape="tile", detail=True):
    """shape: 'tile' (squircle, transparent corners) or 'square' (full bleed)."""
    s = 1.13 if detail else 1.26  # bolder carts when small
    sq = squircle()
    tile_shape = (
        f'<path d="{sq}"' if shape == "tile" else '<rect width="1024" height="1024"'
    )
    clip_shape = (
        f'<path d="{sq}"/>' if shape == "tile" else '<rect width="1024" height="1024"/>'
    )
    ripples = (
        f"""
    <g fill="none" stroke="#bfefff" stroke-linecap="round" opacity=".5">
      <path d="M166 700 q 42 12 84 0" stroke-width="5"/>
      <path d="M774 700 q 42 12 84 0" stroke-width="5"/>
    </g>"""
        if detail else ""
    )
    lower_waves = (
        f"""
    <path d="{wave(752, 15, phase=64)}" fill="none" stroke="url(#crest)" stroke-width="7" stroke-linecap="round" opacity=".5"/>
    <path d="{wave(826, 12, phase=128)}" fill="none" stroke="url(#crest)" stroke-width="6" stroke-linecap="round" opacity=".34"/>
    <path d="{wave(894, 10, phase=32)}" fill="none" stroke="url(#crest)" stroke-width="5" stroke-linecap="round" opacity=".22"/>"""
        if detail
        else f"""
    <path d="{wave(776, 15, phase=64)}" fill="none" stroke="url(#crest)" stroke-width="18" stroke-linecap="round" opacity=".5"/>"""
    )
    horizon = 668 if detail else 690
    crest_w = 12 if detail else 22
    water = f"{wave(horizon, 20)} L1088 1088 L-64 1088 Z"

    # carts: two on the water, one slightly larger cart above and between them.
    # Positioned by visual midpoint (glyph spans x 15..241, so mid = 128).
    def at(mid, wheel_bottom, scale):
        glyph_bottom = 239 if detail else 249
        return cart(mid - 128 * scale, wheel_bottom - glyph_bottom * scale, scale, detail)

    gap = 36 if detail else 28            # wheels rest just above the crest
    rest = horizon - gap
    d = 298 if detail else 292
    big = s * 1.08
    carts = "".join(
        [
            at(512, rest - (150 if detail else 132), big),
            at(512 - d, rest, s),
            at(512 + d, rest, s),
        ]
    )

    glow = (
        '<radialGradient id="glow" cx="512" cy="650" r="560" gradientUnits="userSpaceOnUse">'
        '<stop offset="0" stop-color="#3b82f6" stop-opacity=".42"/>'
        '<stop offset=".55" stop-color="#2563eb" stop-opacity=".14"/>'
        '<stop offset="1" stop-color="#2563eb" stop-opacity="0"/></radialGradient>'
    )
    rim = (
        f'<path d="{sq}" fill="none" stroke="url(#rim)" stroke-width="5"/>'
        if shape == "tile" and detail
        else ""
    )
    sheen_overlay = (
        '<rect width="1024" height="520" fill="url(#topLight)" clip-path="url(#tileClip)"/>'
        if detail
        else ""
    )

    return f"""<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="t d">
  <title id="t">Styx Multi-Cart logo</title>
  <desc id="d">Three amber shopping carts above a glowing blue river on a midnight tile.</desc>
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1024" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#1c2f52"/><stop offset="1" stop-color="#0a1222"/>
    </linearGradient>
    {glow}
    <linearGradient id="topLight" x1="0" y1="0" x2="0" y2="520" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".11"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1024" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".34"/><stop offset=".45" stop-color="#ffffff" stop-opacity=".04"/><stop offset="1" stop-color="#ffffff" stop-opacity=".1"/>
    </linearGradient>
    <linearGradient id="amber" x1="0" y1="0" x2="300" y2="230" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffd46b"/><stop offset=".5" stop-color="#ffa412"/><stop offset="1" stop-color="#f28400"/>
    </linearGradient>
    <linearGradient id="amberDeep" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">
      <stop offset="0" stop-color="#ffb02e"/><stop offset="1" stop-color="#e57800"/>
    </linearGradient>
    <linearGradient id="water" x1="0" y1="{horizon}" x2="0" y2="1024" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2b7fe6"/><stop offset=".5" stop-color="#173f8f"/><stop offset="1" stop-color="#0a1f4f"/>
    </linearGradient>
    <linearGradient id="crest" x1="0" y1="0" x2="1024" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#7fd6ff"/><stop offset=".5" stop-color="#c9f1ff"/><stop offset="1" stop-color="#7fd6ff"/>
    </linearGradient>
    <filter id="cartShadow" x="-30%" y="-30%" width="160%" height="170%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceAlpha" stdDeviation="13" result="blur"/>
      <feFlood flood-color="#ff9f0a" flood-opacity=".30" result="amb"/>
      <feComposite in="amb" in2="blur" operator="in" result="glow"/>
      <feOffset in="blur" dy="14" result="off"/>
      <feFlood flood-color="#000" flood-opacity=".30" result="blk"/>
      <feComposite in="blk" in2="off" operator="in" result="shadow"/>
      <feMerge><feMergeNode in="shadow"/><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="crestGlow" x="-5%" y="-40%" width="110%" height="200%" color-interpolation-filters="sRGB">
      <feGaussianBlur stdDeviation="7"/>
    </filter>
    <clipPath id="tileClip">{clip_shape}</clipPath>
  </defs>

  {tile_shape} fill="url(#tile)"/>
  <g clip-path="url(#tileClip)">
    <rect width="1024" height="1024" fill="url(#glow)"/>
    {sheen_overlay}
    {carts}
    <path d="{water}" fill="url(#water)"/>
    <path d="{wave(horizon, 20)}" fill="none" stroke="#7fd6ff" stroke-width="{crest_w + 10}" stroke-linecap="round" opacity=".55" filter="url(#crestGlow)"/>
    <path d="{wave(horizon, 20)}" fill="none" stroke="url(#crest)" stroke-width="{crest_w}" stroke-linecap="round"/>
    {lower_waves}
    {ripples}
  </g>
  {rim}
</svg>
"""


if __name__ == "__main__":
    outputs = {
        "product-logo.svg": build("tile", True),
        "product-logo-small.svg": build("tile", False),
        "product-logo-square.svg": build("square", True),
    }
    for name, svg in outputs.items():
        with open(os.path.join(HERE, name), "w", encoding="utf-8") as fh:
            fh.write(svg)
        print("wrote", name)
