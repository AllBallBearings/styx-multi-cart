"""
Render Chrome Web Store promotional tiles.

Style brief:
  - Dark navy background matching the brand (#131a22, same as the toolbar icon).
  - Styx icon (rendered fresh at 4x supersample) as the visual anchor.
  - Short brand/value copy in white and orange.

Re-run after edits with: python3 store-assets/_render_promo.py
"""

import os
import sys
import math
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "icons"))

# Reuse the icon renderer so brand stays consistent.
from _render import draw_icon, hex_rgba  # noqa: E402

SMALL_W, SMALL_H = 440, 280
MARQUEE_W, MARQUEE_H = 1400, 560
SMALL_OUT_PATH = os.path.join(HERE, "promo-440x280.png")
MARQUEE_OUT_PATH = os.path.join(HERE, "promo-1400x560.png")

# Brand palette (mirrors the toolbar icon).
BG = hex_rgba("#131a22")
ORANGE = hex_rgba("#ff9900")
WHITE_PRIMARY = (255, 255, 255, 255)
WHITE_SECONDARY = (210, 220, 230, 255)
BLUE = hex_rgba("#5db5ff")
DARK_BLUE = hex_rgba("#1a3a5c")


def pick_font(candidates, size):
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


def font_candidates_bold():
    return [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]


def font_candidates_regular():
    return [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]


def add_radial_highlight(img, origin, radius, color, max_alpha):
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    odraw = ImageDraw.Draw(overlay, "RGBA")
    ox, oy = origin
    steps = 44
    for step in range(steps, 0, -1):
        r = radius * step / steps
        alpha = int(max_alpha * (step / steps) ** 2)
        odraw.ellipse(
            [ox - r, oy - r, ox + r, oy + r],
            fill=(*color[:3], alpha),
        )
    return Image.alpha_composite(img, overlay)


def draw_small():
    w, h = SMALL_W, SMALL_H
    img = Image.new("RGBA", (w, h), BG)
    draw = ImageDraw.Draw(img, "RGBA")

    # Subtle radial highlight from top-left to suggest gradient depth.
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    odraw = ImageDraw.Draw(overlay, "RGBA")
    for i in range(40, 0, -2):
        alpha = int(2 + i * 1.2)
        odraw.ellipse(
            [-180 + i * 4, -120 + i * 4, 320 - i * 2, 260 - i * 2],
            outline=None,
            fill=(60, 110, 170, alpha if alpha < 14 else 14),
        )
    img = Image.alpha_composite(img, overlay)
    draw = ImageDraw.Draw(img, "RGBA")

    # Icon on the left.
    icon = draw_icon(140)
    img.alpha_composite(icon, (24, (h - 140) // 2))

    # Right column — product name + tagline + sub-tagline.
    title_font = pick_font(font_candidates_bold(), 32)
    sub_title_font = pick_font(font_candidates_bold(), 18)
    tagline_font = pick_font(font_candidates_bold(), 19)
    sub_font = pick_font(font_candidates_regular(), 13)

    text_x = 180
    draw.text((text_x, 60), "Styx", font=title_font, fill=WHITE_PRIMARY)
    draw.text((text_x, 100), "Multi-Cart", font=sub_title_font, fill=ORANGE)
    draw.text(
        (text_x, 140),
        "Multiple Amazon carts.",
        font=tagline_font,
        fill=WHITE_PRIMARY,
    )
    draw.text(
        (text_x, 165),
        "One click to switch.",
        font=tagline_font,
        fill=WHITE_PRIMARY,
    )
    draw.text(
        (text_x, 215),
        "Local-only · No tracking",
        font=sub_font,
        fill=WHITE_SECONDARY,
    )

    # Chrome Web Store rejects promos with transparency.
    img.convert("RGB").save(SMALL_OUT_PATH, optimize=True)
    print(f"wrote {SMALL_OUT_PATH}")


def draw_marquee():
    w, h = MARQUEE_W, MARQUEE_H
    img = Image.new("RGBA", (w, h), BG)
    img = add_radial_highlight(img, (260, 90), 520, BLUE, 30)
    img = add_radial_highlight(img, (1160, 520), 520, ORANGE, 28)
    draw = ImageDraw.Draw(img, "RGBA")

    # Brand-forward wave bands keep the image graphic, not screenshot-like.
    wave_color = (*DARK_BLUE[:3], 120)
    draw.polygon([(0, 474), (235, 452), (470, 482), (700, 462), (930, 486), (1160, 454), (1400, 476), (1400, h), (0, h)], fill=wave_color)
    for offset, alpha, width_px in [(0, 220, 8), (36, 135, 6), (72, 90, 5), (108, 60, 4)]:
        points = []
        for x in range(-20, w + 21, 20):
            y = 480 + offset + 14 * math.sin((x / 96.0) + offset / 34.0)
            points.append((x, y))
        draw.line(points, fill=(*BLUE[:3], alpha), width=width_px, joint="curve")

    icon = draw_icon(276)
    img.alpha_composite(icon, (108, 132))

    title_font = pick_font(font_candidates_bold(), 76)
    product_font = pick_font(font_candidates_bold(), 44)
    tagline_font = pick_font(font_candidates_bold(), 54)

    text_x = 460
    draw.text((text_x, 126), "Styx", font=title_font, fill=WHITE_PRIMARY)
    draw.text((text_x, 210), "Multi-Cart", font=product_font, fill=ORANGE)
    draw.text((text_x, 296), "Multiple Amazon carts.", font=tagline_font, fill=WHITE_PRIMARY)
    draw.text((text_x, 360), "One click to switch.", font=tagline_font, fill=WHITE_PRIMARY)

    # Keep edges defined on light gray Chrome Web Store backgrounds.
    draw.rectangle([0, 0, w - 1, h - 1], outline=(255, 255, 255, 18), width=2)

    img.convert("RGB").save(MARQUEE_OUT_PATH, optimize=True)
    print(f"wrote {MARQUEE_OUT_PATH}")


def main():
    draw_small()
    draw_marquee()


if __name__ == "__main__":
    main()
