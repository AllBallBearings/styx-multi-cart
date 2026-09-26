/**
 * While a save / clear / restore runs, the panel must (1) say what is
 * happening, (2) show a spinner and progressive label on the button that
 * started it, and (3) make everything else unusable so a second operation
 * can't be kicked off on top of the first. The real code is pulled out of
 * popup.js and run against a DOM shaped like the popup.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const popupSrc = fs.readFileSync(path.join(ROOT, "popup.js"), "utf8");

// The status machinery: from $listBlock's declaration to the end of runOp().
const start = popupSrc.indexOf("  const $listBlock = document.querySelector");
const runOpAt = popupSrc.indexOf("  async function runOp(");
if (start < 0 || runOpAt < 0) throw new Error("status block not found in popup.js");
const end = popupSrc.indexOf("\n  }\n", runOpAt) + "\n  }\n".length;
const block = popupSrc.slice(start, end);

const SAVE_LABEL = "Save Amazon cart\nfor later";

function setup({ send, loadAmazonLists = vi.fn() } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <section class="mc-list-block">
      <div id="mc-op-status" hidden>
        <div id="mc-op-title"></div><div id="mc-op-detail" hidden></div>
      </div>
      <div class="mc-list-header"><div class="mc-list-header-actions">
        <button id="mc-clear"><svg></svg><span data-i18n="popup_clear_button">Clear Amazon cart</span></button>
        <button id="mc-save-for-later"><svg></svg><span class="mc-cart-action-label">${SAVE_LABEL}</span></button>
      </div></div>
    </section></body></html>`);
  const { document } = dom.window;
  const t = (k) => `T(${k})`;
  const api = new Function(
    "document",
    "t",
    "send",
    "loadAmazonLists",
    "$clear",
    "$saveForLater",
    `${block}
     return { applyOpStatus, pollOpStatus, runOp, state: () => ({ opBusy, opKind }) };`
  )(
    document,
    t,
    send || (async () => ({ busy: false })),
    loadAmazonLists,
    document.getElementById("mc-clear"),
    document.getElementById("mc-save-for-later")
  );
  return {
    ...api,
    loadAmazonLists,
    document,
    $clear: document.getElementById("mc-clear"),
    $save: document.getElementById("mc-save-for-later"),
    $block: document.querySelector(".mc-list-block"),
    $banner: document.getElementById("mc-op-status"),
    $title: document.getElementById("mc-op-title"),
    $detail: document.getElementById("mc-op-detail"),
  };
}

const saveLabel = (ui) => ui.$save.querySelector(".mc-cart-action-label").textContent;

describe("applyOpStatus", () => {
  let ui;
  beforeEach(() => {
    ui = setup();
  });

  it("while saving: spinner + 'saving' label on Save only, banner shown, panel locked", () => {
    ui.applyOpStatus({ busy: true, kind: "save", title: "Saving cart…", detail: "Adding item 9 of 10…" });

    expect(ui.$save.classList.contains("mc-op-busy")).toBe(true);
    expect(saveLabel(ui)).toBe("T(popup_op_saving)");
    expect(ui.$clear.classList.contains("mc-op-busy")).toBe(false);

    expect(ui.$banner.hidden).toBe(false);
    expect(ui.$title.textContent).toBe("Saving cart…");
    expect(ui.$detail.textContent).toBe("Adding item 9 of 10…");
    expect(ui.$detail.hidden).toBe(false);

    expect(ui.$block.inert).toBe(true);
    expect(ui.document.documentElement.hasAttribute("data-op-busy")).toBe(true);
  });

  it("while clearing: the Clear button animates, not Save", () => {
    ui.applyOpStatus({ busy: true, kind: "clear", title: "Clearing cart", detail: "" });
    expect(ui.$clear.classList.contains("mc-op-busy")).toBe(true);
    expect(ui.$clear.querySelector("span").textContent).toBe("T(popup_op_clearing)");
    expect(ui.$save.classList.contains("mc-op-busy")).toBe(false);
    expect(ui.$detail.hidden).toBe(true); // no detail yet -> no empty line
  });

  it("other operations lock the panel and show the banner without animating either button", () => {
    ui.applyOpStatus({ busy: true, kind: "restore", title: "Adding to cart", detail: "3 of 8" });
    expect(ui.$save.classList.contains("mc-op-busy")).toBe(false);
    expect(ui.$clear.classList.contains("mc-op-busy")).toBe(false);
    expect(ui.$banner.hidden).toBe(false);
    expect(ui.$block.inert).toBe(true);
  });

  it("falls back to a generic title before the first progress update arrives", () => {
    ui.applyOpStatus({ busy: true, kind: "save", title: "", detail: "" });
    expect(ui.$title.textContent).toBe("T(popup_op_working)");
  });

  it("restores the original labels exactly when the operation ends", () => {
    ui.applyOpStatus({ busy: true, kind: "save", title: "x" });
    ui.applyOpStatus({ busy: false });
    expect(saveLabel(ui)).toBe(SAVE_LABEL); // including the line break
    expect(ui.$save.classList.contains("mc-op-busy")).toBe(false);
    expect(ui.$banner.hidden).toBe(true);
    expect(ui.$block.inert).toBe(false);
    expect(ui.document.documentElement.hasAttribute("data-op-busy")).toBe(false);
  });

  it("does not corrupt the saved label when polled repeatedly mid-operation", () => {
    for (let i = 0; i < 5; i++) ui.applyOpStatus({ busy: true, kind: "save", title: "x" });
    ui.applyOpStatus({ busy: false });
    expect(saveLabel(ui)).toBe(SAVE_LABEL);
  });
});

describe("pollOpStatus", () => {
  it("leaves the UI alone when the message fails to arrive", async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, error: "No response from extension service worker." });
    const ui = setup({ send });
    ui.applyOpStatus({ busy: true, kind: "save", title: "Saving" });
    await ui.pollOpStatus();
    expect(ui.state().opBusy).toBe(true);
    expect(ui.$block.inert).toBe(true);
  });

  it("clears the busy UI when the service worker reports idle", async () => {
    const send = vi.fn().mockResolvedValue({ busy: false, kind: "other", title: "", detail: "" });
    const ui = setup({ send });
    ui.applyOpStatus({ busy: true, kind: "save", title: "Saving" });
    await ui.pollOpStatus();
    expect(ui.state().opBusy).toBe(false);
    expect(ui.$banner.hidden).toBe(true);
  });
});

describe("reloading the carts when the service worker says they changed", () => {
  const status = (listsVersion, busy = false) => ({ busy, kind: "other", title: "", detail: "", listsVersion });

  it("takes the first version it sees as the baseline and does not reload", async () => {
    const send = vi.fn().mockResolvedValue(status(4));
    const ui = setup({ send });
    await ui.pollOpStatus();
    expect(ui.loadAmazonLists).not.toHaveBeenCalled();
  });

  it("force-reloads exactly once when the version changes (a save or new cart finished)", async () => {
    const send = vi.fn();
    const ui = setup({ send });
    send.mockResolvedValueOnce(status(4));
    await ui.pollOpStatus();
    send.mockResolvedValueOnce(status(5));
    await ui.pollOpStatus();
    expect(ui.loadAmazonLists).toHaveBeenCalledTimes(1);
    expect(ui.loadAmazonLists).toHaveBeenCalledWith(true); // forced: a plain load is a no-op after the first
    send.mockResolvedValue(status(5));
    await ui.pollOpStatus();
    await ui.pollOpStatus();
    expect(ui.loadAmazonLists).toHaveBeenCalledTimes(1); // same version again -> nothing
  });

  it("still reloads if the version changed while the panel was hidden (no busy state was ever seen)", async () => {
    const send = vi.fn();
    const ui = setup({ send });
    send.mockResolvedValueOnce(status(7));
    await ui.pollOpStatus(); // baseline
    // panel hidden; save runs and finishes; panel shown again -> first poll is already idle
    send.mockResolvedValueOnce(status(8, false));
    await ui.pollOpStatus();
    expect(ui.loadAmazonLists).toHaveBeenCalledWith(true);
  });

  it("reloads even while the optimistic busy window would swallow an idle answer", async () => {
    const send = vi.fn();
    const ui = setup({ send });
    send.mockResolvedValueOnce(status(1));
    await ui.pollOpStatus();
    await ui.runOp("save", async () => {
      send.mockResolvedValueOnce(status(2, false));
      await ui.pollOpStatus();
      expect(ui.loadAmazonLists).toHaveBeenCalledWith(true);
    });
  });

  it("does not reload on a transport failure", async () => {
    const send = vi.fn().mockResolvedValueOnce(status(1)).mockResolvedValueOnce({ ok: false, error: "No response" });
    const ui = setup({ send });
    await ui.pollOpStatus();
    await ui.pollOpStatus();
    expect(ui.loadAmazonLists).not.toHaveBeenCalled();
  });

  it("does not reload when a worker without the counter answers (older build)", async () => {
    const send = vi.fn().mockResolvedValue({ busy: false, kind: "other", title: "", detail: "" });
    const ui = setup({ send });
    await ui.pollOpStatus();
    await ui.pollOpStatus();
    expect(ui.loadAmazonLists).not.toHaveBeenCalled();
  });
});

describe("runOp", () => {
  it("shows the busy UI immediately and ignores an early 'idle' poll", async () => {
    // The service worker hasn't taken its lock yet -> it truthfully says idle.
    const send = vi.fn().mockResolvedValue({ busy: false });
    const ui = setup({ send });
    await ui.runOp("save", async () => {
      expect(ui.$save.classList.contains("mc-op-busy")).toBe(true);
      await ui.pollOpStatus(); // idle answer during the start request
      expect(ui.state().opBusy).toBe(true); // must not flicker off
      return { ok: true };
    });
  });

  it("drops the busy UI once the start request is over and the worker is idle (e.g. it failed)", async () => {
    const send = vi.fn().mockResolvedValue({ busy: false });
    const ui = setup({ send });
    await ui.runOp("save", async () => ({ ok: false, error: "Cart appears empty" }));
    await new Promise((r) => setTimeout(r, 0)); // let the trailing poll settle
    expect(ui.state().opBusy).toBe(false);
    expect(saveLabel(ui)).toBe(SAVE_LABEL);
  });

  it("stays busy after a successful start while the worker reports it is running", async () => {
    const send = vi.fn().mockResolvedValue({ busy: true, kind: "save", title: "Saving", detail: "Adding item 1 of 10…" });
    const ui = setup({ send });
    await ui.runOp("save", async () => ({ ok: true, started: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(ui.state().opBusy).toBe(true);
    expect(ui.$detail.textContent).toBe("Adding item 1 of 10…");
  });
});
