---
title: Report a Bug — Styx Multi-Cart
---

[← Back to Styx Multi-Cart](./)

# Report a Bug

Found something broken or behaving oddly? Thank you — clear bug reports are the
fastest way to get a fix shipped. Reports live on the public
[GitHub issue tracker](https://github.com/AllBallBearings/styx-multi-cart/issues).

## The quick way (from the extension)

1. Open the Styx Multi-Cart popup.
2. Click the small **life-buoy icon** in the bottom-right corner.
3. Choose **Report a bug**.

That opens a pre-filled GitHub issue with your extension version and browser
already attached, so you can jump straight to describing the problem. You'll need
a free GitHub account to post (the same login works for every project on GitHub).

## Before you file

- **Search [open issues](https://github.com/AllBallBearings/styx-multi-cart/issues) first.**
  If your bug is already listed, add a 👍 or a comment with anything new instead
  of opening a duplicate — it helps us see how many people are affected.
- **Try to reproduce it once more.** A bug you can trigger on demand is far
  easier to fix than a one-off.

## What makes a great report

Include as much of this as you can:

| Item | Why it helps |
| --- | --- |
| **What happened** vs. **what you expected** | Pins down the actual defect. |
| **Step-by-step to reproduce** | Lets us see it for ourselves. |
| **The Amazon storefront** (e.g. `amazon.com`, `amazon.co.uk`) | Behavior can differ per region. |
| **Screenshot or short screen recording** | A picture beats a paragraph. |
| **Extension version** | Confirms whether it's already fixed. Find it in **Settings → version**, or the prefilled report adds it automatically. |
| **Browser + version** | Chrome, Edge, Brave, Arc, Safari, etc. |

## Attaching diagnostic logs (optional but powerful)

For tricky or intermittent bugs, the extension can package up its recent logs:

1. Open **Settings** (the gear icon) and type `STYXDEV` to reveal **Developer
   mode**, then turn it on.
2. Scroll to the **Debug** panel at the bottom of the popup (or press
   **Ctrl + Alt + D**).
3. Reproduce the bug.
4. Click **Copy diagnostic logs** and paste the result into your GitHub issue.

The logs contain the extension version, current state, and recent messages from
the service worker, content scripts, and popup. They do **not** include your
Amazon login or payment details — see the
[Privacy Policy](privacy.html) for exactly what the extension touches.

## Requesting a feature

Have an idea instead of a bug? Open an issue the same way and start the title
with **[Feature]**. Describe the problem you're trying to solve, not just the
solution you have in mind — it gives us more room to find the best fix.

---

Prefer email? Reach out at
[jaredgoolsby@gmail.com](mailto:jaredgoolsby@gmail.com). GitHub issues are
preferred because they're public, searchable, and let other users chime in.
