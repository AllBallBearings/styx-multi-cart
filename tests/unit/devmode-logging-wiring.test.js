/**
 * Guards the dev-mode diagnostic logging wiring so it can't silently regress.
 *
 * The single source of truth is the `mc.dev.v1` flag in chrome.storage.local
 * (popup Settings → Developer mode). Every context must:
 *   - read that flag at startup and stay in sync via chrome.storage.onChanged
 *   - forward dev-mode logs to the service worker's ring buffer (MC_LOG_PUSH)
 *
 * The historic bug (0.9.x) was observer.js shipping `const DEBUG = false`
 * hardcoded with no hydration, so the content-script that runs Amazon's
 * Add-to-Cart interception could never emit a log in the field — even with
 * Developer mode on. This test fails the build if that wiring goes missing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(__dirname, "../../", rel), "utf8");

const CONTEXTS = [
  { name: "observer.js", src: read("observer.js") },
  { name: "content.js", src: read("content.js") },
];

describe("dev-mode logging is wired to mc.dev.v1 in every page context", () => {
  for (const { name, src } of CONTEXTS) {
    it(`${name} hydrates DEBUG from mc.dev.v1`, () => {
      expect(src).toMatch(/mc\.dev\.v1/);
      expect(src).toMatch(/chrome\.storage\.local\.get/);
    });

    it(`${name} keeps DEBUG in sync via storage.onChanged`, () => {
      expect(src).toMatch(/chrome\.storage\.onChanged\.addListener/);
    });

    it(`${name} forwards logs to the service worker ring (MC_LOG_PUSH)`, () => {
      expect(src).toMatch(/MC_LOG_PUSH/);
    });

    it(`${name} does not hardcode an un-hydrated DEBUG flag`, () => {
      // A bare `const DEBUG = false;` with no storage read is the regression.
      const hasStaticConst = /\bconst\s+DEBUG\s*=/.test(src);
      const hasMutableLet = /\blet\s+DEBUG\s*=/.test(src);
      expect(hasStaticConst && !hasMutableLet).toBe(false);
    });
  }
});

describe("service worker exposes the diagnostic log ring", () => {
  const bg = read("background.js");
  const sw = read("src/background/index.js");

  it("background.js handles MC_LOG_PUSH and MC_LOG_GET", () => {
    expect(bg).toMatch(/MC_LOG_PUSH/);
    expect(bg).toMatch(/MC_LOG_GET/);
  });

  it("source records dev logs into a ring buffer", () => {
    expect(sw).toMatch(/pushLogEntry/);
    expect(sw).toMatch(/LOG_RING/);
  });

  it("background.js is built from the current source (ring present)", () => {
    expect(bg).toMatch(/LOG_RING/);
    expect(bg).toMatch(/pushLogEntry/);
  });
});

describe("popup gathers a cross-context diagnostic report", () => {
  const popup = read("popup.js");

  it("popup.js requests the ring and copies a report", () => {
    expect(popup).toMatch(/MC_LOG_GET/);
    expect(popup).toMatch(/buildDiagnosticReport/);
    expect(popup).toMatch(/clipboard\.writeText/);
  });
});
