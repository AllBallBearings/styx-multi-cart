/**
 * The entitlement preset controls in the debug menu forge a premium state
 * straight into chrome.storage.local — a client-side bypass. They're kept for
 * local dev but stripped from the published Chrome Web Store build by
 * scripts/build-zip.sh, which deletes everything between the
 * MC_DEBUG_ENT_START / MC_DEBUG_ENT_END markers in popup.html and popup.js.
 *
 * This test mirrors that strip so the wiring can't silently rot: it verifies
 * the markers exist, that the bypass code lives *inside* them, and that a
 * strip leaves a clean, still-functional popup (logging tools preserved).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(__dirname, "../../", rel), "utf8");

// Must match the regex used in scripts/build-zip.sh.
const MARKER =
  /[ \t]*(?:<!--|\/\*)\s*MC_DEBUG_ENT_START\s*(?:-->|\*\/)[\s\S]*?(?:<!--|\/\*)\s*MC_DEBUG_ENT_END\s*(?:-->|\*\/)[ \t]*\n?/g;

const popupJs = read("popup.js");
const popupHtml = read("popup.html");

describe("debug entitlement controls are marked for production stripping", () => {
  for (const [name, src] of [
    ["popup.js", popupJs],
    ["popup.html", popupHtml],
  ]) {
    it(`${name} has balanced MC_DEBUG_ENT markers`, () => {
      const starts = (src.match(/MC_DEBUG_ENT_START/g) || []).length;
      const ends = (src.match(/MC_DEBUG_ENT_END/g) || []).length;
      expect(starts).toBeGreaterThan(0);
      expect(starts).toBe(ends);
    });
  }

  it("the entitlement bypass code lives only inside the markers", () => {
    // entPresets() (the forged states) and the data-debug-ent buttons are the
    // bypass; after a strip neither should remain anywhere.
    expect(popupJs).toMatch(/function entPresets/);
    expect(popupHtml).toMatch(/data-debug-ent/);

    const strippedJs = popupJs.replace(MARKER, "");
    const strippedHtml = popupHtml.replace(MARKER, "");

    expect(strippedJs).not.toMatch(/function entPresets/);
    expect(strippedJs).not.toMatch(/\[ENT_KEY\]: next/);
    expect(strippedHtml).not.toMatch(/data-debug-ent/);
  });

  it("stripping removes every marker and leaves the dev tools intact", () => {
    const strippedJs = popupJs.replace(MARKER, "");
    const strippedHtml = popupHtml.replace(MARKER, "");

    expect(strippedJs).not.toMatch(/MC_DEBUG_ENT/);
    expect(strippedHtml).not.toMatch(/MC_DEBUG_ENT/);

    // The diagnostic-logging tooling is NOT part of the bypass and must survive.
    expect(strippedJs).toMatch(/buildDiagnosticReport/);
    expect(strippedJs).toMatch(/setDebugPanelVisible/);
    expect(strippedHtml).toMatch(/mc-copy-logs/);
    expect(strippedHtml).toMatch(/id="mc-debug"/);
  });

  it("nothing the kept code calls is stripped away (no dangling refs)", () => {
    const strippedJs = popupJs.replace(MARKER, "");
    // refreshDebugEntDisplay is called by setDebugPanelVisible — must remain.
    expect(strippedJs).toMatch(/function refreshDebugEntDisplay|refreshDebugEntDisplay\s*=/);
    // ENT_KEY is used by the diagnostic report + display — must remain.
    expect(strippedJs).toMatch(/ENT_KEY = "mc\.entitlement\.v1"/);
  });
});
