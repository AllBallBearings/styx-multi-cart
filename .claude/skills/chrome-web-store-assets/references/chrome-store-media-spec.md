# Chrome Web Store Media Reference

Always prefer the current official Chrome Web Store documentation when making
final upload decisions. This reference captures common requirements and
practical capture rules for repeated local work.

## Common Dimensions

| Asset | Dimension | Notes |
|---|---:|---|
| Screenshot | 1280x800 | Preferred Chrome Web Store screenshot size |
| Screenshot | 640x400 | Smaller allowed screenshot size |
| Small promo tile | 440x280 | PNG, no transparency |
| Large promo tile | 920x680 | Optional, PNG, no transparency |
| Marquee promo tile | 1400x560 | PNG, no transparency |
| Store icon | 128x128 | PNG icon |

## Common Rejection Risks

- Wrong pixel dimensions.
- Transparent screenshots caused by macOS window capture.
- Rounded window corners or visible drop shadows.
- Screenshots with padding, black canvas, or non-full-bleed browser capture.
- Promo tiles that look like screenshots.
- Text too small to read in listing thumbnails.
- Visible personal data, account info, addresses, payment data, or order data.

## Capture Tool Selection

- Playwright: best for exact browser content and repeatable states.
- Shottr: best for macOS exact-region screenshots of real Chrome UI.
- OBS: best free recording tool when repeatability and overlays matter.
- QuickTime: good free macOS screen recording for simple captures.
- ffmpeg: use for trim, crop, scale, transcode, and metadata inspection.

## Metadata Inspection

Use several tools when available:

```bash
file store-assets/screenshots/*.png
sips -g pixelWidth -g pixelHeight -g space -g hasAlpha store-assets/screenshots/*.png
ffprobe -v error -show_entries stream=codec_type,codec_name,width,height,avg_frame_rate:format=duration,size -of json store-assets/videos/*.mov
python3 .claude/skills/chrome-web-store-assets/scripts/validate_assets.py --root .
```
