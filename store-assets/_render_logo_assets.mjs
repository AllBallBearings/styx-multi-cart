#!/usr/bin/env node
// Render every logo/icon PNG from the SVG masters in this folder.
//
//   python3 store-assets/_build_logo.py       # (re)generate the SVG masters
//   node    store-assets/_render_logo_assets.mjs
//
// Outputs: extension toolbar icons (icons/), store + website logos, favicon,
// the Apple AppIcon set, and the host-app icon. Sizes below 64px use the
// simplified `product-logo-small.svg`; everything else uses the detailed one.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (f) => fs.readFileSync(path.join(here, f), "utf8");
const full = read("product-logo.svg");
const small = read("product-logo-small.svg");
const square = read("product-logo-square.svg");

const appIconDir = path.join(
  root,
  "safari/Styx Multi-Cart/Shared (App)/Assets.xcassets/AppIcon.appiconset"
);
const hostIcon = path.join(root, "safari/Styx Multi-Cart/Shared (App)/Resources/Icon.png");

// macOS icons are drawn inset in the 1024 canvas with a soft shadow (Big Sur+
// template). Tiny sizes drop the shadow and use a smaller margin so the glyph
// isn't lost.
function macComposite(svg, { inset, shadow }) {
  const inner = svg.replace(/<\?xml[^>]*\?>/, "").replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const body = 1024 - inset * 2;
  const filter = shadow
    ? `<filter id="ds" x="-10%" y="-10%" width="120%" height="125%" color-interpolation-filters="sRGB"><feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000" flood-opacity=".38"/></filter>`
    : "";
  return `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
    <defs>${filter}</defs>
    <g ${shadow ? 'filter="url(#ds)"' : ""}>
      <svg x="${inset}" y="${inset}" width="${body}" height="${body}" viewBox="0 0 1024 1024">${inner}</svg>
    </g></svg>`;
}

const jobs = [];
const add = (file, size, svg) => jobs.push({ file, size, svg });

// Extension toolbar icons (also the on-page floating button)
for (const s of [16, 32, 48]) add(path.join(root, `icons/icon${s}.png`), s, small);
add(path.join(root, "icons/icon128.png"), 128, full);
add(path.join(here, "icon-128.png"), 128, full);

// Store / website logos
for (const s of [512, 1024, 2048]) add(path.join(here, `product-logo-${s}.png`), s, full);
add(path.join(root, "docs/assets/product-logo-1024.png"), 1024, full);
add(path.join(root, "docs/assets/favicon-128.png"), 128, full);

// Host app window icon (shown at 84px; 256 keeps it sharp on Retina)
add(hostIcon, 256, full);

// Apple AppIcon set
const mac = (name, size) => {
  const tiny = size <= 64;
  const svg = macComposite(tiny ? small : full, {
    inset: tiny ? 40 : 100,
    shadow: !tiny,
  });
  add(path.join(appIconDir, name), size, svg);
};
mac("mac-icon-16@1x.png", 16);
mac("mac-icon-16@2x.png", 32);
mac("mac-icon-32@1x.png", 32);
mac("mac-icon-32@2x.png", 64);
mac("mac-icon-128@1x.png", 128);
mac("mac-icon-128@2x.png", 256);
mac("mac-icon-256@1x.png", 256);
mac("mac-icon-256@2x.png", 512);
mac("mac-icon-512@1x.png", 512);
mac("mac-icon-512@2x.png", 1024);
add(path.join(appIconDir, "universal-icon-1024@1x.png"), 1024, square);

async function launch() {
  try {
    return await chromium.launch();
  } catch {
    return await chromium.launch({ channel: "chrome" }); // fall back to installed Chrome
  }
}

const browser = await launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const { file, size, svg } of jobs) {
    await page.setViewportSize({ width: size, height: size });
    const b64 = Buffer.from(svg).toString("base64");
    await page.setContent(
      `<body style="margin:0;background:transparent"><img id="i" style="display:block;width:${size}px;height:${size}px" src="data:image/svg+xml;base64,${b64}"></body>`
    );
    await page.waitForFunction(() => document.getElementById("i").complete);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file, omitBackground: true });
    console.log(`wrote ${path.relative(root, file)} (${size}px)`);
  }
} finally {
  await browser.close();
}

fs.copyFileSync(path.join(here, "product-logo.svg"), path.join(root, "docs/assets/product-logo.svg"));
console.log("wrote docs/assets/product-logo.svg");
