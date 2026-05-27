"""
Render the 440x280 Chrome Web Store small promo tile.

Style brief:
  - Dark navy background matching the brand (#131a22, same as the toolbar icon).
  - 128px Styx icon (rendered fresh at 4x supersample) on the left.
  - Tagline + product name on the right, in white.

Re-run after edits with: python3 store-assets/_render_promo.py
"""

import os
import sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "icons"))

# Reuse the icon renderer so brand stays consistent.
from _render import draw_icon, hex_rgba  # noqa: E402

W, H = 440, 280
OUT_PATH = os.path.join(HERE, "promo-440x280.png")

# Brand palette (mirrors the toolbar icon).
BG = hex_rgba("#131a22")
ORANGE = hex_rgba("#ff9900")
WHITE_PRIMARY = (255, 255, 255, 255)
WHITE_SECONDARY = (210, 220, 230, 255)


def pick_font(candidates, size):
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


def main():
    img = Image.new("RGBA", (W, H), BG)
    draw = ImageDraw.Draw(img, "RGBA")

    # Subtle radial highlight from top-left to suggest gradient depth.
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
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
    img.alpha_composite(icon, (24, (H - 140) // 2))

    # Right column — product name + tagline + sub-tagline.
    font_candidates_bold = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    font_candidates_regular = [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]

    title_font = pick_font(font_candidates_bold, 32)
    sub_title_font = pick_font(font_candidates_bold, 18)
    tagline_font = pick_font(font_candidates_bold, 19)
    sub_font = pick_font(font_candidates_regular, 13)

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
    img.convert("RGB").save(OUT_PATH, optimize=True)
    print(f"wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
