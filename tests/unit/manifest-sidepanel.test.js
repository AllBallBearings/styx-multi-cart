/**
 * Locks in the native Side Panel contract introduced when we replaced the
 * in-page iframe overlay (which broke Amazon's responsive layouts) with
 * chrome.sidePanel. These are config-level guarantees that nothing else
 * asserts, so a regression here would silently revert the fix.
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
const observerSrc = fs.readFileSync(path.join(ROOT, "observer.js"), "utf8");

describe("native side panel config", () => {
  it("declares the sidePanel permission", () => {
    expect(manifest.permissions).toContain("sidePanel");
  });

  it("points the side panel at the popup with the sidepanel surface", () => {
    expect(manifest.side_panel).toBeTruthy();
    expect(manifest.side_panel.default_path).toBe("popup.html?surface=sidepanel");
  });

  it("has no action.default_popup so the toolbar icon can open the side panel", () => {
    expect(manifest.action).toBeTruthy();
    expect(manifest.action.default_popup).toBeUndefined();
  });

  it("no longer ships the iframe-panel web_accessible_resources", () => {
    expect(manifest.web_accessible_resources).toBeUndefined();
  });

  it("opens the side panel on toolbar click from the service worker", () => {
    expect(backgroundSrc).toContain("setPanelBehavior");
    expect(backgroundSrc).toContain("openPanelOnActionClick: true");
  });

  it("removed the in-page overlay panel from the content script", () => {
    // The old overlay reflowed the page with CSS and broke Amazon's layout.
    expect(observerSrc).not.toContain("__styx-side-panel");
    expect(observerSrc).not.toContain("syncSidePanelPageOffset");
    expect(observerSrc).not.toContain("--styx-page-available-width");
  });
});
