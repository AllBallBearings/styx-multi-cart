import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

// Regression guard for the on-page save toast.
//
// The toast has two states: MC_LIST_SAVE_PROGRESS (spinner, no auto-dismiss)
// and MC_LIST_SAVE_DONE (terminal, auto-dismisses). A save driven from the
// panel has no code on the page awaiting a response, so if the background
// signals completion with PROGRESS instead of DONE the toast spins forever
// even though the save succeeded — which is exactly what shipped once.

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(here, "../../observer.js"), "utf8");

function bootObserver() {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://www.amazon.com/gp/cart/view.html",
    runScripts: "outside-only",
  });
  const listeners = [];
  dom.window.chrome = {
    runtime: {
      id: "test",
      getURL: (p) => "chrome-extension://test/" + p,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: () => Promise.resolve({ ok: true }),
    },
    storage: {
      local: {
        get: (_k, cb) => (cb ? cb({}) : Promise.resolve({})),
        set: () => Promise.resolve(),
      },
    },
  };
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  // JSDOM has no rAF; showStyxToast uses it for the enter transition.
  dom.window.requestAnimationFrame = (fn) => dom.window.setTimeout(fn, 0);
  // observer.js boots several page-specific features that need a real Amazon
  // DOM; those are irrelevant here and are allowed to fail. The message
  // listener is registered regardless.
  try {
    dom.window.eval(SRC);
  } catch (_e) {
    /* partial boot is fine — we only exercise the toast listener */
  }
  return { dom, listeners };
}

const dispatch = (listeners, msg) =>
  listeners.forEach((fn) => {
    try {
      fn(msg);
    } catch (_e) {
      /* other listeners aren't under test */
    }
  });

// Exact id — a looser selector also matches the injected <style id="styx-toast-style">.
const findToast = (dom) =>
  dom.window.document.getElementById("styx-progress-toast");

describe("cart→list save toast lifecycle", () => {
  it("registers a runtime message listener", () => {
    const { listeners } = bootObserver();
    expect(listeners.length).toBeGreaterThan(0);
  });

  it("PROGRESS renders a non-terminal toast", () => {
    const { dom, listeners } = bootObserver();
    dispatch(listeners, {
      type: "MC_LIST_SAVE_PROGRESS",
      detail: "Adding 1 of 3…",
    });

    const el = findToast(dom);
    expect(el).toBeTruthy();
    expect(el.className).not.toContain("styx-toast-done");
    expect(el.className).not.toContain("styx-toast-error");
    expect(el.querySelector(".styx-toast-detail").textContent).toBe(
      "Adding 1 of 3…"
    );
  });

  it("DONE terminates the toast instead of leaving it spinning", () => {
    const { dom, listeners } = bootObserver();
    dispatch(listeners, { type: "MC_LIST_SAVE_PROGRESS", detail: "Working…" });
    dispatch(listeners, {
      type: "MC_LIST_SAVE_DONE",
      ok: true,
      title: "Cart saved for later",
      detail: 'Saved 1 item to "Cart · Jul 30". Your Amazon cart is untouched.',
    });

    const el = findToast(dom);
    expect(el.className).toContain("styx-toast-done");
    expect(el.querySelector(".styx-toast-title").textContent).toBe(
      "Cart saved for later"
    );
    expect(el.querySelector(".styx-toast-detail").textContent).toContain(
      "Your Amazon cart is untouched"
    );
  });

  it("DONE with ok:false renders the error state", () => {
    const { dom, listeners } = bootObserver();
    dispatch(listeners, { type: "MC_LIST_SAVE_PROGRESS", detail: "Working…" });
    dispatch(listeners, {
      type: "MC_LIST_SAVE_DONE",
      ok: false,
      title: "Couldn't save your cart",
      detail: "Your Amazon cart was left as-is.",
    });

    const el = findToast(dom);
    expect(el.className).toContain("styx-toast-error");
    expect(el.className).not.toContain("styx-toast-done");
    expect(el.querySelector(".styx-toast-title").textContent).toBe(
      "Couldn't save your cart"
    );
  });

  it("the background never signals completion via PROGRESS", () => {
    // Guards the actual bug: a terminal message sent as PROGRESS, which leaves
    // the toast spinning. Scans a window after each PROGRESS marker rather
    // than trying to brace-match — the payloads embed ${...} template
    // substitutions, so the first "}" is not the end of the object.
    const bg = readFileSync(
      resolve(here, "../../src/background/index.js"),
      "utf8"
    );

    const MARKER = 'type: "MC_LIST_SAVE_PROGRESS"';
    const windows = [];
    for (let i = bg.indexOf(MARKER); i !== -1; i = bg.indexOf(MARKER, i + 1)) {
      let chunk = bg.slice(i, i + 400);
      // Don't bleed into the following notify call.
      const next = chunk.indexOf("notifyTab(", MARKER.length);
      if (next !== -1) chunk = chunk.slice(0, next);
      windows.push(chunk);
    }
    expect(windows.length, "expected PROGRESS senders to exist").toBeGreaterThan(0);

    const terminalWords =
      /untouched|left as-is|couldn't save|cart is empty|Saved \d/i;
    const offenders = windows.filter((w) => terminalWords.test(w));
    expect(
      offenders,
      "terminal text must be sent as MC_LIST_SAVE_DONE, not PROGRESS"
    ).toEqual([]);
  });
});
