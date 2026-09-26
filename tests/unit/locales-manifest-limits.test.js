/**
 * App Store Connect rejects the Safari build if any locale's extension
 * description is over 112 characters (validation error 90862: "The
 * description field must be present, of string type, and 112 or fewer
 * characters long"). Chrome allows 132, so a longer translation passes
 * everywhere except the App Store upload. Keep every locale under Apple's
 * stricter limit so this fails in CI instead of at archive-validation time.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCALES_DIR = path.join(ROOT, "_locales");
const APPLE_MAX_DESCRIPTION = 112;

const locales = fs
  .readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

describe("locale manifest strings stay within App Store limits", () => {
  it("finds the locale folders", () => {
    expect(locales.length).toBeGreaterThan(0);
  });

  for (const locale of locales) {
    it(`${locale}: manifest_description is a string of at most ${APPLE_MAX_DESCRIPTION} chars`, () => {
      const messages = JSON.parse(
        fs.readFileSync(path.join(LOCALES_DIR, locale, "messages.json"), "utf8")
      );
      const description = messages.manifest_description?.message;
      expect(typeof description).toBe("string");
      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(APPLE_MAX_DESCRIPTION);
    });
  }
});
