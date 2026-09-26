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
const buildZipSrc = fs.readFileSync(
  path.join(ROOT, "scripts", "build-zip.sh"),
  "utf8"
);

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

  it("reuses a fresh lists snapshot and closes helper tabs promptly", () => {
    // Opening the panel must not create a second Amazon Lists tab when a
    // recent snapshot is available. A newly-created helper tab also needs a
    // completion wait; a reload-cycle wait can miss the initial loading event
    // and leave the tab hanging around until timeout.
    expect(backgroundSource).toContain(
      "listAmazonListsWithAccessCached(host, { forceRefresh = false } = {})"
    );
    expect(backgroundSource).toContain("Date.now() - cached.fetchedAt < AMAZON_LIST_READ_CACHE_MS");
    expect(backgroundSource).toContain("await waitForTabComplete(tab.id, timeoutMs)");
    expect(backgroundSrc).toContain("await waitForTabComplete(tab.id, timeoutMs)");
    const listCaseStart = backgroundSource.indexOf('case "MC_LIST_AMAZON_LISTS"');
    const listCaseEnd = backgroundSource.indexOf('case "MC_GET_LIST_COUNTS"', listCaseStart);
    expect(listCaseStart).toBeGreaterThanOrEqual(0);
    expect(listCaseEnd).toBeGreaterThan(listCaseStart);
    expect(backgroundSource.slice(listCaseStart, listCaseEnd)).not.toContain("backfillListCounts");
  });

  it("warms list contents after the panel paints with a bounded queue", () => {
    expect(backgroundSource).toContain('case "MC_PREFETCH_AMAZON_LISTS"');
    expect(backgroundSource).toContain("AMAZON_LIST_PREFETCH_CONCURRENCY = 3");
    expect(backgroundSource).toContain("amazonListReadInFlight");
    expect(popupJsSrc).toContain("scheduleAmazonListPrefetch");
    expect(popupJsSrc).toContain('type: "MC_PREFETCH_AMAZON_LISTS"');
    expect(popupJsSrc).toContain("requestIdleCallback");
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

  it("shows a persistent first-run guide from the floating button", () => {
    expect(observerSrc).toContain("__styx-guide-tip");
    expect(observerSrc).toContain("styx.onboarding.v1");
    expect(observerSrc).toContain("guide-assets/guide-clear-save.png");
    expect(observerSrc).toContain("guide-assets/StyxFabButton.png");
    expect(observerSrc).toContain("guide-assets/AddtoStyxCart.png");
    expect(observerSrc).toContain("guide-assets/CartList.png");
    expect(observerSrc).toContain("guide-assets/SendAllToAmazonCart.png");
    expect(observerSrc).toContain("guide-assets/CartButtons.png");
    expect(observerSrc).toContain("guide-assets/SendAllDockedPill.png");
    expect(observerSrc).toContain("guide-assets/SendAllPanelButton.png");
    expect(observerSrc).toContain("guide-next");
    expect(observerSrc).toContain("guide-back");
    expect(observerSrc).toContain("markGuideSeen");
  });

  it("packages the screenshots used by the first-run walkthrough", () => {
    for (const file of ["guide-clear-save.png", "StyxFabButton.png", "AddtoStyxCart.png", "CartList.png", "SendAllToAmazonCart.png", "SendAllDockedPill.png", "SendAllPanelButton.png", "CartButtons.png"]) {
      expect(fs.existsSync(path.join(ROOT, "guide-assets", file))).toBe(true);
      expect(fs.existsSync(path.join(ROOT, "safari", "Styx Multi-Cart", "Shared (Extension)", "Resources", "guide-assets", file))).toBe(true);
      // Also packaged into the Chrome Web Store zip — without this, real
      // installs 404 on every guide image (web_accessible_resources declares
      // the path, but the zip's FILES array is a separate, exact list).
      expect(buildZipSrc).toContain(`guide-assets/${file}`);
    }
    const resources = manifest.web_accessible_resources.flatMap((entry) => entry.resources || []);
    expect(resources).toContain("guide-assets/*.png");
  });

  it("adds a cart-page clear button with the shared clear flow", () => {
    expect(observerSrc).toContain('const STYX_CLEAR_CART_BTN_ID = "styx-clear-cart"');
    expect(observerSrc).toContain('t("popup_clear_button")');
    expect(observerSrc).toContain('"MC_CLEAR_CURRENT"');
    expect(observerSrc).toContain('"MC_SAVE_AND_CLEAR"');
    expect(observerSrc).toContain('data-styx-clear-choice="save"');
    expect(observerSrc).toContain("STYX_CLEAR_CART_MARK_SVG");
    expect(observerSrc).toContain("STYX_SAVE_CART_MARK_SVG");
    expect(observerSrc).toContain('t("popup_saveForLater_button")');
    expect(observerSrc).toContain("promptSaveCartName");
    expect(observerSrc).toContain('t("observer_nameYourNewList")');
    expect(observerSrc).toContain('t("observer_saveCartHelp")');
    expect(observerSrc).not.toContain('window.prompt("Name your new Amazon list:');
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
