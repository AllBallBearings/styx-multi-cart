/**
 * Safari freezes requestAnimationFrame and CSS transitions in hidden tabs
 * (measured live: 1 frame in 1.5 s hidden vs 86 visible, transitions never
 * finish). Amazon's Add-to-List chooser is animated, so a helper tab opened with
 * active:false never finishes opening it and "save cart" hangs until the user
 * brings that tab forward. The write flows therefore run their helper in the
 * foreground on Safari, then put the user back where they were. Chrome keeps the
 * silent background tab.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = fs.readFileSync(path.join(ROOT, "src", "background", "index.js"), "utf8");

const start = src.indexOf("let _fgHelperTabId = null;");
const end = src.indexOf('/** Scrape the user\'s wish lists from the "Your Lists" index page. */');
if (start < 0 || end < 0) throw new Error("runInAmazonTab block not found");
const block = src.slice(start, end);

function setup({ isSafari, activeTab = { id: 100 }, progress = null } = {}) {
  const log = [];
  const chrome = {
    tabs: {
      query: vi.fn(async () => (activeTab ? [activeTab] : [])),
      create: vi.fn(async (opts) => {
        log.push(`create(active:${opts.active})`);
        return { id: 555 };
      }),
      remove: vi.fn(async (id) => void log.push(`remove(${id})`)),
      update: vi.fn(async (id, props) => void log.push(`update(${id},active:${props.active})`)),
    },
  };
  const notifyTab = vi.fn();
  const waitForTabComplete = vi.fn(async () => {});
  const api = new Function(
    "IS_SAFARI",
    "chrome",
    "notifyTab",
    "waitForTabComplete",
    `${block}
     return { runInAmazonTab, setProgress: (v) => { _lastListProgress = v; }, fg: () => _fgHelperTabId };`
  )(isSafari, chrome, notifyTab, waitForTabComplete);
  if (progress) api.setProgress(progress);
  return { ...api, chrome, log, notifyTab };
}

describe("runInAmazonTab", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("Safari + foreground: opens the helper in front, then closes it and returns to the user's tab", async () => {
    const h = setup({ isSafari: true });
    await h.runInAmazonTab("https://x/", async () => "ok", { foreground: true });
    expect(h.log).toEqual(["create(active:true)", "remove(555)", "update(100,active:true)"]);
  });

  it("Safari, no foreground request (reads, prefetch): stays a silent background tab", async () => {
    const h = setup({ isSafari: true });
    await h.runInAmazonTab("https://x/", async () => "ok");
    expect(h.log).toEqual(["create(active:false)", "remove(555)"]);
    expect(h.chrome.tabs.query).not.toHaveBeenCalled();
  });

  it("Chrome + foreground request: unchanged, still a background tab (Chrome doesn't throttle it)", async () => {
    const h = setup({ isSafari: false });
    await h.runInAmazonTab("https://x/", async () => "ok", { foreground: true });
    expect(h.log).toEqual(["create(active:false)", "remove(555)"]);
  });

  it("returns what the work returns", async () => {
    const h = setup({ isSafari: true });
    await expect(
      h.runInAmazonTab("https://x/", async (tabId) => ({ tabId }), { foreground: true })
    ).resolves.toEqual({ tabId: 555 });
  });

  it("still closes the helper and restores the user's tab when the work throws", async () => {
    const h = setup({ isSafari: true });
    await expect(
      h.runInAmazonTab(
        "https://x/",
        async () => {
          throw new Error("chooser never opened");
        },
        { foreground: true }
      )
    ).rejects.toThrow("chooser never opened");
    expect(h.log).toEqual(["create(active:true)", "remove(555)", "update(100,active:true)"]);
    expect(h.fg()).toBe(null);
  });

  it("does not try to restore when there was no active tab to return to", async () => {
    const h = setup({ isSafari: true, activeTab: null });
    await h.runInAmazonTab("https://x/", async () => "ok", { foreground: true });
    expect(h.log).toEqual(["create(active:true)", "remove(555)"]);
  });

  it("leaves a keepOpen helper alone (nothing to close, nothing to restore)", async () => {
    const h = setup({ isSafari: true });
    await h.runInAmazonTab("https://x/", async () => "ok", { foreground: true, keepOpen: true });
    expect(h.log).toEqual(["create(active:true)"]);
  });

  it("exposes the foreground helper while the work runs, and forgets it after", async () => {
    const h = setup({ isSafari: true });
    let during = "unset";
    await h.runInAmazonTab("https://x/", async () => void (during = h.fg()), { foreground: true });
    expect(during).toBe(555);
    expect(h.fg()).toBe(null);
  });

  it("shows the running save's progress on the helper, then again once its page script is ready", async () => {
    const payload = { type: "MC_LIST_SAVE_PROGRESS", detail: "Adding item 3 of 10…" };
    const h = setup({ isSafari: true, progress: payload });
    await h.runInAmazonTab("https://x/", async () => "ok", { foreground: true });
    expect(h.notifyTab).toHaveBeenCalledTimes(1);
    expect(h.notifyTab).toHaveBeenCalledWith(555, payload);
    vi.advanceTimersByTime(1300);
    expect(h.notifyTab).toHaveBeenCalledTimes(2);
  });

  it("sends nothing to the helper when no save is in progress", async () => {
    const h = setup({ isSafari: true });
    await h.runInAmazonTab("https://x/", async () => "ok", { foreground: true });
    vi.advanceTimersByTime(2000);
    expect(h.notifyTab).not.toHaveBeenCalled();
  });
});

describe("which flows use a foreground helper", () => {
  const body = (name) => {
    const a = src.indexOf(`async function ${name}(`);
    const b = src.indexOf("\n}\n", a);
    return src.slice(a, b);
  };

  for (const name of ["createAmazonListFromPdp", "addItemToList", "setListQuantities"]) {
    it(`${name} (a write that needs Amazon's animated chooser) asks for the foreground`, () => {
      expect(body(name)).toMatch(/foreground: true/);
    });
  }

  for (const name of ["listAmazonLists", "readAmazonList", "findAmazonListIdByName"]) {
    it(`${name} (a read, including background prefetch) stays silent`, () => {
      expect(body(name)).not.toMatch(/foreground/);
    });
  }

  it("progress is forwarded to the foreground helper and forgotten when the save ends", () => {
    expect(src).toMatch(/_fgHelperTabId !== progressTabId\) notifyTab\(_fgHelperTabId, payload\)/);
    expect(src).toMatch(/_lastListProgress = null;\s*await setUiBusy\(false\);/);
  });
});
