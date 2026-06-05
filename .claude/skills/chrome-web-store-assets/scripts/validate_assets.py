#!/usr/bin/env python3
import argparse
import json
import shutil
import subprocess
from pathlib import Path

try:
    from PIL import Image, ImageCms
except ImportError as exc:
    raise SystemExit("Pillow is required: python3 -m pip install Pillow") from exc


EXPECTED_IMAGES = {
    "store-assets/promo-440x280.png": (440, 280, False),
    "store-assets/promo-920x680.png": (920, 680, False),
    "store-assets/promo-1400x560.png": (1400, 560, False),
}

SCREENSHOT_SIZE = (1280, 800)
ALT_SCREENSHOT_SIZE = (640, 400)


def profile_name(image):
    profile = image.info.get("icc_profile")
    if not profile:
        return "none"
    try:
        import io

        return ImageCms.getProfileName(ImageCms.ImageCmsProfile(io.BytesIO(profile))).strip()
    except Exception:
        return "present"


def inspect_png(path):
    with Image.open(path) as image:
        alpha = image.getchannel("A") if "A" in image.getbands() else None
        alpha_extrema = alpha.getextrema() if alpha else None
        has_transparent_pixels = bool(alpha_extrema and alpha_extrema[0] < 255)
        return {
            "path": str(path),
            "size": image.size,
            "mode": image.mode,
            "profile": profile_name(image),
            "has_alpha_channel": alpha is not None,
            "has_transparent_pixels": has_transparent_pixels,
        }


def check_image(path, expected_size=None, allow_alpha=True):
    info = inspect_png(path)
    issues = []
    if expected_size and tuple(info["size"]) != tuple(expected_size):
        issues.append(f"expected {expected_size[0]}x{expected_size[1]}, got {info['size'][0]}x{info['size'][1]}")
    if not allow_alpha and info["has_alpha_channel"]:
        issues.append("has alpha channel; promo tiles should be flattened RGB")
    if info["has_transparent_pixels"]:
        issues.append("has transparent pixels")
    return info, issues


def inspect_video(path):
    if not shutil.which("ffprobe"):
        return {"path": str(path), "warning": "ffprobe not found"}, []
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,width,height,avg_frame_rate,pix_fmt:format=duration,size,format_name",
        "-of",
        "json",
        str(path),
    ]
    proc = subprocess.run(cmd, check=False, capture_output=True, text=True)
    if proc.returncode != 0:
        return {"path": str(path), "error": proc.stderr.strip()}, ["ffprobe failed"]
    data = json.loads(proc.stdout)
    duration = float(data.get("format", {}).get("duration") or 0)
    issues = []
    if duration and not (20 <= duration <= 45):
        issues.append(f"duration is {duration:.1f}s; target about 30s")
    data["path"] = str(path)
    return data, issues


def main():
    parser = argparse.ArgumentParser(description="Validate Chrome Web Store asset metadata.")
    parser.add_argument("--root", default=".", help="Repository root containing store-assets/")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    store = root / "store-assets"
    if not store.exists():
        raise SystemExit(f"missing {store}")

    failures = 0

    screenshot_dir = store / "screenshots"
    if screenshot_dir.exists():
        for path in sorted(screenshot_dir.glob("*.png")):
            info, issues = check_image(path)
            size = tuple(info["size"])
            if size not in (SCREENSHOT_SIZE, ALT_SCREENSHOT_SIZE):
                issues.append(
                    f"screenshot should be {SCREENSHOT_SIZE[0]}x{SCREENSHOT_SIZE[1]} or "
                    f"{ALT_SCREENSHOT_SIZE[0]}x{ALT_SCREENSHOT_SIZE[1]}"
                )
            if info["has_transparent_pixels"]:
                issues.append("screenshot has transparent pixels")
            status = "PASS" if not issues else "FAIL"
            failures += int(bool(issues))
            print(f"{status} {path.relative_to(root)} {info['size'][0]}x{info['size'][1]} {info['mode']} profile={info['profile']}")
            for issue in issues:
                print(f"  - {issue}")

    for rel, (width, height, allow_alpha) in EXPECTED_IMAGES.items():
        path = root / rel
        if not path.exists():
            continue
        info, issues = check_image(path, (width, height), allow_alpha=allow_alpha)
        status = "PASS" if not issues else "FAIL"
        failures += int(bool(issues))
        print(f"{status} {rel} {info['size'][0]}x{info['size'][1]} {info['mode']} profile={info['profile']}")
        for issue in issues:
            print(f"  - {issue}")

    video_dir = store / "videos"
    if video_dir.exists():
        for path in sorted(video_dir.glob("*")):
            if path.suffix.lower() not in {".mov", ".mp4", ".m4v"}:
                continue
            info, issues = inspect_video(path)
            status = "PASS" if not issues else "WARN"
            stream = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), {})
            duration = float(info.get("format", {}).get("duration") or 0)
            print(
                f"{status} {path.relative_to(root)} "
                f"{stream.get('width', '?')}x{stream.get('height', '?')} "
                f"{stream.get('codec_name', '?')} duration={duration:.1f}s"
            )
            for issue in issues:
                print(f"  - {issue}")

    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
