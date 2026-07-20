/**
 * Locks in the floating-modal contract that replaced the native Side Panel.
 * The UI is now an in-page draggable modal (an iframe embedding popup.html)
 * toggled by a bottom-right floating button injected by observer.js, plus the
 * toolbar icon. These are config-level guarantees nothing else asserts, so a
 * regression here would silently break how the panel opens.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")
);
const backgroundSrc = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
const backgroundSource = fs.readFileSync(
  path.join(ROOT, "src", "background", "index.js"),
  "utf8"
);
const observerSrc = fs.readFileSync(path.join(ROOT, "observer.js"), "utf8");
const popupJsSrc = fs.readFileSync(path.join(ROOT, "popup.js"), "utf8");
const popupCssSrc = fs.readFileSync(path.join(ROOT, "popup.css"), "utf8");

describe("floating modal config", () => {
  it("no longer declares the sidePanel permission", () => {
    expect(manifest.permissions).not.toContain("sidePanel");
  });

  it("drops the native side_panel block", () => {
    expect(manifest.side_panel).toBeUndefined();
  });

  it("has no action.default_popup so the toolbar icon fires action.onClicked", () => {
    expect(manifest.action).toBeTruthy();
    expect(manifest.action.default_popup).toBeUndefined();
  });

  it("exposes popup.html + icons as web_accessible_resources for the iframe", () => {
    const war = manifest.web_accessible_resources;
    expect(Array.isArray(war)).toBe(true);
    const entry = war.find(
      (e) => Array.isArray(e.resources) && e.resources.includes("popup.html")
    );
    expect(entry).toBeTruthy();
    expect(entry.resources).toContain("icons/*.png");
    // Restricted to Amazon hosts (the extension's only content-script surface).
    expect(entry.matches.some((m) => /amazon\./i.test(m))).toBe(true);
    expect(entry.matches).not.toContain("<all_urls>");
  });

  it("toggles the modal on toolbar click from the service worker", () => {
    // Assert both the source and the bundle so the wiring can't be dropped in
    // one without the other.
    expect(backgroundSource).toContain("chrome.action.onClicked");
    expect(backgroundSource).toContain("MC_TOGGLE_FLOATING");
    expect(backgroundSrc).toContain("MC_TOGGLE_FLOATING");
  });

  it("injects the floating button + modal iframe from the content script", () => {
    expect(observerSrc).toContain("__styx-fab");
    expect(observerSrc).toContain("popup.html");
    expect(observerSrc).toContain("surface=floating");
    // Listens for the toolbar-forwarded toggle.
    expect(observerSrc).toContain("MC_TOGGLE_FLOATING");
    // Top-frame only — Amazon embeds many iframes.
    expect(observerSrc).toContain("window.top !== window");
  });

  it("teaches popup.html/css about the floating surface", () => {
    expect(popupJsSrc).toContain('"floating"');
    expect(popupCssSrc).toContain('data-surface="floating"');
  });

  it("does not resurrect the old page-reflowing overlay panel", () => {
    // The pre-side-panel overlay reflowed the page with CSS and broke Amazon's
    // layout. The new modal floats over the page (fixed position) instead.
    expect(observerSrc).not.toContain("__styx-side-panel");
    expect(observerSrc).not.toContain("syncSidePanelPageOffset");
    expect(observerSrc).not.toContain("--styx-page-available-width");
  });
});
