#!/usr/bin/env python3
import argparse
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError as exc:
    raise SystemExit("Pillow is required: python3 -m pip install Pillow") from exc


def parse_color(value):
    value = value.strip()
    if value.startswith("#") and len(value) == 7:
        return tuple(int(value[i : i + 2], 16) for i in (1, 3, 5))
    raise argparse.ArgumentTypeError("color must be #RRGGBB")


def main():
    parser = argparse.ArgumentParser(description="Flatten and fit a PNG to an exact canvas.")
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("--mode", choices=["cover", "contain"], default="cover")
    parser.add_argument("--background", type=parse_color, default=(255, 255, 255))
    args = parser.parse_args()

    src = Path(args.input)
    dst = Path(args.output)

    with Image.open(src) as image:
        image = ImageOps.exif_transpose(image)
        if image.mode in ("RGBA", "LA") or "transparency" in image.info:
            bg = Image.new("RGB", image.size, args.background)
            bg.paste(image.convert("RGBA"), mask=image.convert("RGBA").getchannel("A"))
            image = bg
        else:
            image = image.convert("RGB")

        if args.mode == "cover":
            fitted = ImageOps.fit(image, (args.width, args.height), method=Image.Resampling.LANCZOS)
        else:
            fitted = ImageOps.contain(image, (args.width, args.height), method=Image.Resampling.LANCZOS)
            canvas = Image.new("RGB", (args.width, args.height), args.background)
            x = (args.width - fitted.width) // 2
            y = (args.height - fitted.height) // 2
            canvas.paste(fitted, (x, y))
            fitted = canvas

        dst.parent.mkdir(parents=True, exist_ok=True)
        fitted.save(dst, format="PNG", optimize=True)


if __name__ == "__main__":
    main()
