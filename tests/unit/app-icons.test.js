/**
 * The macOS app icon set is rendered from one SVG at several sizes. An earlier
 * renderer raced its own page layout and one 256px file came out as the top of
 * the logo with a second copy of the top underneath it, which is what the Dock
 * and App Store Connect displayed. Two files at the same pixel size are the same
 * art, so they must be byte-identical; a mismatch means one is corrupt. Each file
 * must also really be the size Contents.json says it is.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = path.join(
  ROOT,
  "safari/Styx Multi-Cart/Shared (App)/Assets.xcassets/AppIcon.appiconset"
);
const contents = JSON.parse(fs.readFileSync(path.join(DIR, "Contents.json"), "utf8"));

// Width and height straight from the PNG header (IHDR), no image library needed.
function pngSize(buf) {
  const sig = buf.subarray(0, 8).toString("hex");
  if (sig !== "89504e470d0a1a0a") throw new Error("not a PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const macEntries = contents.images
  .filter((i) => i.idiom === "mac")
  .map((i) => {
    const pt = parseInt(i.size, 10);
    const scale = parseInt(i.scale, 10);
    const buf = fs.readFileSync(path.join(DIR, i.filename));
    return { file: i.filename, px: pt * scale, buf };
  });

describe("macOS app icon set", () => {
  it("has all ten macOS sizes", () => {
    expect(macEntries.map((e) => e.px).sort((a, b) => a - b)).toEqual(
      [16, 32, 32, 64, 128, 256, 256, 512, 512, 1024]
    );
  });

  for (const e of macEntries) {
    it(`${e.file} is really ${e.px}x${e.px}`, () => {
      expect(pngSize(e.buf)).toEqual({ width: e.px, height: e.px });
    });
  }

  it("files at the same pixel size are byte-identical (a mismatch means one is corrupt)", () => {
    const bySize = new Map();
    for (const e of macEntries) {
      if (!bySize.has(e.px)) bySize.set(e.px, []);
      bySize.get(e.px).push(e);
    }
    for (const [px, group] of bySize) {
      for (const other of group.slice(1)) {
        expect(
          Buffer.compare(group[0].buf, other.buf),
          `${group[0].file} and ${other.file} are both ${px}px but differ`
        ).toBe(0);
      }
    }
  });

  it("the iOS-style marketing icon is 1024x1024", () => {
    const universal = contents.images.find((i) => i.idiom === "universal");
    const buf = fs.readFileSync(path.join(DIR, universal.filename));
    expect(pngSize(buf)).toEqual({ width: 1024, height: 1024 });
  });
});
