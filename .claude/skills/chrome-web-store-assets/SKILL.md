---
name: chrome-web-store-assets
description: Create, capture, post-process, and validate Chrome Web Store listing media for browser extensions, including exact-dimension screenshots, demo videos, small promo tiles, marquee promo tiles, and optional large promo tiles. Use when asked to produce Chrome Web Store screenshots or promotional assets, automate desktop/browser capture with Playwright, computer use, Shottr, OBS/QuickTime, or ffmpeg, add callouts/graphics, or verify store-assets compliance before upload.
---

# Chrome Web Store Assets

Use this skill to produce Chrome Web Store media that passes dimension,
format, and visual-quality checks. Prefer deterministic capture and validation
over manual eyeballing.

## Start Here

1. Read the project's asset spec first, usually `store-assets/README.md`.
2. Verify current Chrome Web Store media requirements from official Chrome docs
   before final delivery if internet access is available.
3. Inventory current assets with `find store-assets -maxdepth 3 -type f` and
   inspect image/video metadata.
4. Produce or recapture assets, then run `scripts/validate_assets.py`.
5. Visually inspect every final image/video. Metadata compliance is necessary
   but not sufficient.

## Required Asset Targets

Use project-specific requirements when present. Otherwise default to:

- Screenshots: PNG, exactly `1280x800` preferred, or `640x400`; full bleed,
  square corners, no OS window shadow, no transparent padding, sRGB/RGB.
- Small promo tile: PNG, exactly `440x280`, no transparency.
- Marquee promo tile: PNG, exactly `1400x560`, no transparency.
- Optional large promo tile: PNG, exactly `920x680`, no transparency.
- Demo video: usually a YouTube URL for the listing, not a local file upload.
  Target about 30 seconds unless the project asks otherwise.

Promo tiles should be graphic/brand assets, not screenshots or UI mockups,
because Chrome Store review can reject screenshot-like promotional tiles.

For this repo's current convention, place outputs in:

- `store-assets/screenshots/`
- `store-assets/videos/`
- `store-assets/promo-440x280.png`
- `store-assets/promo-1400x560.png`
- `store-assets/promo-920x680.png` if requested

## Capture Strategy

Prefer the lowest-friction tool that captures the actual surface needed.

- Use Playwright when the target is page content or an extension page that can
  be opened directly, such as `popup.html?surface=sidepanel`.
- Use desktop control plus Shottr on macOS when the screenshot must include
  Chrome UI, browser side panel, extension popup chrome, or cross-app state.
- Use OBS or QuickTime for screen recording. Use ffmpeg afterward for trimming,
  scaling, cropping, and encoding.
- Do not use macOS window capture via spacebar for final screenshots; it creates
  rounded corners, alpha, shadow/padding, and Retina-size images.

### Playwright Screenshot Flow

Use this when the image can be represented by browser content alone.

1. Build the extension if the repo has a build step.
2. Launch a persistent Chromium profile with the unpacked extension loaded.
3. Set `viewport: { width: 1280, height: 800 }` and `deviceScaleFactor: 1`.
4. Navigate to the target page or extension page.
5. Seed deterministic demo data through the UI, fixtures, or `chrome.storage`
   only when doing so matches the product behavior being shown.
6. Capture `page.screenshot({ path, fullPage: false })`.
7. Run validation and visual inspection.

### Desktop/Shottr Screenshot Flow

Use this when the screenshot should show the real Chrome browser plus extension
side panel or popup.

1. Prepare a clean demo browser profile with no personal data visible.
2. Open Chrome large enough to contain a clean `1280x800` capture region.
3. Arrange the page and extension UI exactly as the screenshot storyboard needs.
4. Use Shottr fixed-size region capture or an equivalent exact-region tool.
5. Capture the rectangular region only. Do not capture the window shadow.
6. Export PNG, then run validation. If needed, flatten or fit with
   `scripts/fit_png.py`.

If a desktop automation agent controls Shottr, have it explicitly set/select an
exact `1280x800` region. Do not rely on "capture window" behavior.

## Screenshot Storyboard

Before capturing, write a short storyboard mapping filename to purpose. Good
screenshots show one user value each:

- Saved carts visible beside a real cart page.
- Confirmation for switching to a saved cart.
- Add-to-cart interception or picker.
- Restore completion or final cart review.
- Optional premium/paywall only if it improves listing clarity.

Avoid:

- Personal account details, addresses, order history, email, payment details.
- Browser bookmarks, private tabs, notifications, or visible local files.
- Blurry UI, cropped text, rounded transparent corners, or unreadable callouts.
- Excessive annotation. One callout per screenshot is usually enough.

## Added Graphics and Callouts

Use annotations only when they make a workflow obvious at store-thumbnail size.

- Keep callouts inside the safe area, away from browser chrome edges.
- Use the extension's brand colors and typography where practical.
- Prefer simple arrows, highlight rings, labels, and short phrases.
- Keep text short enough to read at reduced scale.
- Flatten annotations into the final PNG and revalidate alpha/no transparency.

If adding graphics programmatically, use Pillow, SVG rendered to PNG, or an
existing design tool. Avoid destructive edits to original raw captures; keep
raw captures in a temporary folder or a clearly named `raw/` folder only if the
project wants them checked in.

## Promo Tile Workflow

Promo tiles are advertisements, not screenshots.

1. Use the project logo or icon as the primary visual anchor.
2. Use a short value prop, such as "Multiple carts. One click."
3. Add 2-3 simple supporting shapes/icons only if they improve clarity.
4. Respect safe areas:
   - Small tile `440x280`: keep critical content within roughly `400x240`.
   - Marquee `1400x560`: keep critical content away from edges and avoid tiny
     text that fails on smaller placements.
5. Export RGB/sRGB PNG with no alpha.
6. Validate dimensions and inspect at 100%, 50%, and thumbnail size.

Do not put screenshots, browser chrome, fake UI cards, or dense feature lists in
promo tiles unless the current Chrome docs explicitly allow it and the project
accepts the rejection risk.

## Video Workflow

For the demo video:

1. Storyboard a 25-35 second sequence:
   - Problem: one Amazon cart is not enough.
   - Save a cart.
   - Switch or add item to another saved cart.
   - Restore/review before checkout.
2. Record a clean browser session with OBS or QuickTime.
3. Use a 16:9 output for YouTube when possible, or preserve the project's
   requested aspect ratio if already defined.
4. Trim dead time and cursor wandering.
5. Add minimal captions/callouts if the action is not obvious without audio.
6. Export H.264 MP4 for upload to YouTube, then store the local source under
   `store-assets/videos/` if the repo tracks video source files.

Keep video free of personal data. Never show checkout, payment, address, order
history, or private account pages.

## Validation Commands

From the skill directory:

```bash
python3 scripts/validate_assets.py --root /path/to/repo
```

To flatten and fit a screenshot into an exact target canvas:

```bash
python3 scripts/fit_png.py input.png output.png --width 1280 --height 800
```

Use `--mode cover` to crop-fill the target canvas, or `--mode contain` to fit
inside with a solid background. For store screenshots, prefer recapture or
cover-crop over contain padding.

## Final Delivery Checklist

- Exact dimensions match the project spec.
- PNGs are RGB/sRGB or at least RGB with no alpha for promo tiles.
- Screenshots have square corners and no transparent padding.
- Screenshots are full bleed and readable at store preview size.
- Promo tiles are graphic promotional images, not screenshots.
- Video is trimmed, clean, and close to the requested duration.
- Filenames match `store-assets/README.md` or the README is updated to match.
- Run validation and summarize every warning.
