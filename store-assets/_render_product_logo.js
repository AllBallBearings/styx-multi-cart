#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const dir = path.dirname(fileURLToPath(import.meta.url));
const svgPath = path.join(dir, "product-logo.svg");
const websiteAssetDir = path.resolve(dir, "../docs/assets");
const sizes = [512, 1024, 2048];

async function renderLogo(size, svgSource) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent("<canvas></canvas>");
    const pngBase64 = await page.evaluate(
      async ({ svgSource, size }) => {
        const canvas = document.querySelector("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        const svgBlob = new Blob([svgSource], { type: "image/svg+xml" });
        const url = URL.createObjectURL(svgBlob);
        try {
          const img = new Image();
          img.decoding = "sync";
          img.src = url;
          await img.decode();
          ctx.clearRect(0, 0, size, size);
          ctx.drawImage(img, 0, 0, size, size);
          return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
        } finally {
          URL.revokeObjectURL(url);
        }
      },
      { svgSource, size }
    );

    const outPath = path.join(dir, `product-logo-${size}.png`);
    fs.writeFileSync(outPath, Buffer.from(pngBase64, "base64"));
    console.log(`wrote ${outPath}`);

    if (size === 1024) {
      const websitePath = path.join(websiteAssetDir, "product-logo-1024.png");
      fs.writeFileSync(websitePath, Buffer.from(pngBase64, "base64"));
      console.log(`wrote ${websitePath}`);
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  const svgSource = fs.readFileSync(svgPath, "utf8");
  fs.mkdirSync(websiteAssetDir, { recursive: true });
  fs.copyFileSync(svgPath, path.join(websiteAssetDir, "product-logo.svg"));
  console.log(`wrote ${path.join(websiteAssetDir, "product-logo.svg")}`);

  for (const size of sizes) {
    await renderLogo(size, svgSource);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
