"""
Render Styx Multi-Cart toolbar icons (16/32/48/128 PNG).
Mirrors the canvas code in generate_icons.html so output matches the in-browser
preview. Run once; re-run only if the design changes.

Usage: python3 icons/_render.py
"""

import os
from PIL import Image, ImageDraw

ICON_DIR = os.path.dirname(os.path.abspath(__file__))
SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 4  # render at Nx target and downsample with LANCZOS for AA


def hex_rgba(h, alpha=255):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), alpha)


def trace_wave_points(width, y_center, amp, segments=4, samples_per_segment=24):
    """Sample points along the chained quadratic-Bezier wave."""
    seg_w = width / segments
    pts = [(0.0, y_center)]
    for i in range(segments):
        x0 = i * seg_w
        x2 = (i + 1) * seg_w
        cx = x0 + seg_w * 0.5
        cy = y_center + (-amp if i % 2 == 0 else amp)
        for k in range(1, samples_per_segment + 1):
            t = k / samples_per_segment
            mt = 1 - t
            x = mt * mt * x0 + 2 * mt * t * cx + t * t * x2
            y = mt * mt * y_center + 2 * mt * t * cy + t * t * y_center
            pts.append((x, y))
    return pts


def draw_icon(target_size):
    s = target_size * SUPERSAMPLE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img, "RGBA")

    # Rounded charcoal background
    radius = int(round(s * 0.22))
    draw.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=hex_rgba("#131a22"))

    orange = hex_rgba("#ff9900")
    stroke_w = max(1, int(round(s * 0.034)))

    def cart(cx, cy, body_w, body_h, draw_wheels):
        left = cx - body_w / 2
        right = cx + body_w / 2
        top = cy - body_h / 2
        bot = cy + body_h / 2

        body = [
            (left, top),
            (right, top),
            (right - body_w * 0.1, bot),
            (left + body_w * 0.1, bot),
        ]
        for i in range(4):
            a = body[i]
            b = body[(i + 1) % 4]
            draw.line([a, b], fill=orange, width=stroke_w, joint="curve")

        handle_end = (left - body_w * 0.21, top - body_h * 0.41)
        draw.line([(left, top), handle_end], fill=orange, width=stroke_w, joint="curve")

        if draw_wheels:
            wheel_r = max(1.0, s * 0.028)
            wy = bot + body_h * 0.55
            for wx in (left + body_w * 0.27, right - body_w * 0.27):
                draw.ellipse(
                    [wx - wheel_r, wy - wheel_r, wx + wheel_r, wy + wheel_r],
                    fill=orange,
                )

    cart_w = s * 0.22
    cart_h = s * 0.1
    cart(s * 0.5, s * 0.32, cart_w, cart_h, True)        # top apex
    cart(s * 0.235, s * 0.5, cart_w, cart_h, True)       # bottom-left (wheels lap waterline)
    cart(s * 0.79, s * 0.5, cart_w, cart_h, True)        # bottom-right (shifted right; clears top cart wheel)

    wave_cfg = [
        dict(y=0.62, amp=0.045, alpha=1.00, width=0.032),
        dict(y=0.72, amp=0.030, alpha=0.55, width=0.025),
        dict(y=0.81, amp=0.028, alpha=0.38, width=0.022),
        dict(y=0.89, amp=0.022, alpha=0.25, width=0.018),
    ]

    top_pts = trace_wave_points(s, wave_cfg[0]["y"] * s, wave_cfg[0]["amp"] * s)
    river_poly = top_pts + [(s, s), (0, s)]
    draw.polygon(river_poly, fill=(26, 58, 92, int(round(0.55 * 255))))

    for w in wave_cfg:
        line_w = max(1, int(round(s * w["width"])))
        color = (93, 181, 255, int(round(w["alpha"] * 255)))
        pts = trace_wave_points(s, w["y"] * s, w["amp"] * s)
        draw.line(pts, fill=color, width=line_w, joint="curve")

    return img.resize((target_size, target_size), Image.LANCZOS)


def main():
    for size in SIZES:
        path = os.path.join(ICON_DIR, f"icon{size}.png")
        draw_icon(size).save(path, optimize=True)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
