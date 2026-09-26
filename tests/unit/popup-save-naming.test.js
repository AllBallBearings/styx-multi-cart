/**
 * "Save Amazon cart for later" must ask the user to name the new cart first,
 * pre-filled with a dated suggestion so Enter still works as a one-tap save,
 * and must do nothing at all if they back out. The real click handler is
 * pulled out of popup.js and run with stubs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = fs.readFileSync(path.join(ROOT, "popup.js"), "utf8");

const start = src.indexOf("  if ($saveForLater) {");
if (start < 0) throw new Error("save-for-later handler not found in popup.js");
const end = src.indexOf("\n  }\n", start) + "\n  }\n".length;
const handlerBlock = src.slice(start, end);

function setup({ promptResult, sendResult = { ok: true, saving: 3 } }) {
  const calls = [];
  const promptDialog = vi.fn(async (opts) => {
    calls.push("prompt");
    return typeof promptResult === "function" ? promptResult(opts) : promptResult;
  });
  const runOp = vi.fn(async (kind, fn) => {
    calls.push("runOp:" + kind);
    return fn();
  });
  const send = vi.fn(async (msg) => {
    calls.push("send:" + msg.type);
    return sendResult;
  });
  const toast = vi.fn();
  const win = { close: vi.fn() };
  let onClick;
  const $saveForLater = { addEventListener: (_evt, fn) => (onClick = fn) };

  new Function(
    "$saveForLater",
    "promptDialog",
    "runOp",
    "send",
    "toast",
    "t",
    "defaultName",
    "itemCountText",
    "handleEntitlementError",
    "IS_PANEL_SURFACE",
    "window",
    handlerBlock
  )(
    $saveForLater,
    promptDialog,
    runOp,
    send,
    toast,
    (k) => `T(${k})`,
    () => "Cart · Sep 26, 11:02 AM",
    (n) => `${n} items`,
    () => false,
    true,
    win
  );
  return { click: () => onClick(), calls, promptDialog, runOp, send, toast, win };
}

describe("Save Amazon cart for later asks for a name", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prompts first, pre-filled with the dated suggestion and a Save button", async () => {
    const ui = setup({ promptResult: "Garden party" });
    await ui.click();
    expect(ui.promptDialog).toHaveBeenCalledTimes(1);
    const opts = ui.promptDialog.mock.calls[0][0];
    expect(opts.initialValue).toBe("Cart · Sep 26, 11:02 AM");
    expect(opts.title).toBe("T(popup_prompt_saveForLater_title)");
    expect(opts.message).toBe("T(popup_prompt_saveForLater_message)");
    expect(opts.okLabel).toBe("T(popup_action_save)");
  });

  it("saves with exactly the name the user chose", async () => {
    const ui = setup({ promptResult: "Garden party" });
    await ui.click();
    await Promise.resolve();
    expect(ui.send).toHaveBeenCalledTimes(1);
    expect(ui.send).toHaveBeenCalledWith({ type: "MC_SAVE_FOR_LATER", name: "Garden party" });
  });

  it("shows no busy state while the user is still typing the name", async () => {
    const ui = setup({ promptResult: "Garden party" });
    await ui.click();
    expect(ui.calls.indexOf("prompt")).toBeLessThan(ui.calls.indexOf("runOp:save"));
  });

  it("does nothing when the user cancels", async () => {
    const ui = setup({ promptResult: null });
    await ui.click();
    await Promise.resolve();
    expect(ui.runOp).not.toHaveBeenCalled();
    expect(ui.send).not.toHaveBeenCalled();
    expect(ui.toast).not.toHaveBeenCalled();
  });

  it("confirms the save with a toast on success", async () => {
    const ui = setup({ promptResult: "Garden party", sendResult: { ok: true, saving: 3 } });
    await ui.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(ui.toast).toHaveBeenCalledWith("T(popup_toast_savingForLater)");
  });

  it("reports the error and does not close the panel when the save can't start", async () => {
    const ui = setup({
      promptResult: "Garden party",
      sendResult: { ok: false, error: "Cart appears empty" },
    });
    await ui.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(ui.toast).toHaveBeenCalledWith("Cart appears empty", "error");
    expect(ui.win.close).not.toHaveBeenCalled();
  });
});
