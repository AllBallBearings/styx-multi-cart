import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../popup.js", import.meta.url), "utf8");
const start = source.indexOf('  $clear.addEventListener("click", async () => {');
const end = source.indexOf("\n\n  // Save the live Amazon cart", start);
if (start < 0 || end < 0) throw new Error("Clear-cart handler not found");
const handler = source.slice(start, end);

function setup({ choice = "alt", name = "Weekend supplies" } = {}) {
  let click;
  const sent = [];
  const promptDialog = vi.fn(async () => name);
  const runOp = vi.fn(async (_kind, action) => action());
  const send = vi.fn(async (message) => {
    sent.push(message);
    return message.type === "MC_GET_CART_COUNT" ? { ok: true, count: 2 } : { ok: true };
  });
  new Function(
    "$clear", "send", "t", "confirmDialog", "promptDialog", "defaultName",
    "runOp", "toast", "handleEntitlementError", "IS_PANEL_SURFACE", "window", handler
  )(
    { addEventListener: (_event, listener) => { click = listener; } },
    send, (key) => key, async () => choice, promptDialog,
    () => "Cart · Oct 10, 11:00 PM", runOp, vi.fn(), () => false, true, {}
  );
  return { click, sent, promptDialog, runOp };
}

describe("Save & Clear naming", () => {
  it("asks for a cart name before saving and sends the chosen name", async () => {
    const ui = setup();
    await ui.click();
    expect(ui.promptDialog).toHaveBeenCalledWith(expect.objectContaining({
      initialValue: "Cart · Oct 10, 11:00 PM",
      message: "popup_prompt_saveAndClear_message",
      okLabel: "popup_confirm_clear_altLabel",
    }));
    expect(ui.sent).toContainEqual({ type: "MC_SAVE_AND_CLEAR", name: "Weekend supplies" });
  });

  it("does not save or clear when naming is cancelled", async () => {
    const ui = setup({ name: null });
    await ui.click();
    expect(ui.runOp).not.toHaveBeenCalled();
    expect(ui.sent.map((message) => message.type)).toEqual(["MC_GET_CART_COUNT"]);
  });
});
