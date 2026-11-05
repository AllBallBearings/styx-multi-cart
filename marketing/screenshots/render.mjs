// Renders scenes.html to store and landing page sizes. Run capture.mjs first.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Chrome Web Store and the landing page use 1280x800; the Mac App Store takes up to 2880x1800.
const sizes = [{ dir: "1280x800", scale: 1 }, { dir: "2880x1800", scale: 2.25 }];

const browser = await chromium.launch({ channel: "chrome", headless: true });
for (const { dir, scale } of sizes) {
  const out = join(here, "out", dir);
  mkdirSync(out, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: scale });
  page.on("pageerror", (e) => { console.error("PAGE ERROR", e.message); process.exitCode = 1; });
  await page.goto(pathToFileURL(join(here, "scenes.html")).href, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  for (const scene of await page.locator(".scene").all()) {
    const name = await scene.getAttribute("data-name");
    const raw = join(out, name + ".raw.png");
    await scene.screenshot({ path: raw });
    // Flatten to opaque RGB: the stores reject or mishandle alpha.
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-pix_fmt", "rgb24", join(out, name + ".png")]);
    rmSync(raw);
  }
  await page.close();
}
await browser.close();
