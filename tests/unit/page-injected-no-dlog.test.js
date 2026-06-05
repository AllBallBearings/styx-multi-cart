/**
 * Regression guard for a class of bug we hit on 0.9.3:
 *
 * Functions named `function page*(...)` in background.js are injected into
 * Amazon page contexts via chrome.scripting.executeScript. The page context
 * has no access to the service-worker scope, so calling the dlog/dinfo/dwarn
 * helpers there throws ReferenceError, rejects the wrapping Promise, and
 * the caller sees a generic failure with zero diagnostic info in the SW
 * console.
 *
 * This test scans background.js for any page* function body that uses
 * dlog/dinfo/dwarn and fails the build. Inside page* functions always use
 * raw console.log / console.warn.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BG_PATH = resolve(__dirname, "../../background.js");
const SRC = readFileSync(BG_PATH, "utf8");
const LINES = SRC.split("\n");

/**
 * Brace-balanced extraction of every top-level `function page*(...)` body.
 * Returns [{ name, startLine, endLine, body }].
 */
function findPageFunctions(src) {
  const out = [];
  const re = /^\s*function (page[A-Za-z0-9_]+)\s*\(/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    const startLine = src.slice(0, m.index).split("\n").length;
    // Find opening brace, then brace-balance to find closing brace.
    let i = src.indexOf("{", re.lastIndex);
    if (i === -1) continue;
    let depth = 1;
    let j = i + 1;
    while (j < src.length && depth > 0) {
      const ch = src[j];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      j++;
    }
    const body = src.slice(i, j);
    const endLine = src.slice(0, j).split("\n").length;
    out.push({ name, startLine, endLine, body });
  }
  return out;
}

describe("background.js: injected page* functions must not reference SW-only helpers", () => {
  const fns = findPageFunctions(SRC);

  it("found at least one page* function (sanity)", () => {
    expect(fns.length).toBeGreaterThan(0);
  });

  for (const fn of fns) {
    it(`${fn.name} (line ${fn.startLine}-${fn.endLine}) doesn't call dlog/dinfo/dwarn`, () => {
      const offenders = [];
      // Walk the function body line by line so the error message points at
      // an exact source line.
      const bodyLines = fn.body.split("\n");
      for (let i = 0; i < bodyLines.length; i++) {
        const line = bodyLines[i];
        // Skip comments — they're allowed to discuss the helpers.
        const stripped = line.replace(/\/\/.*$/, "").replace(/\/\*[\s\S]*?\*\//g, "");
        if (/\b(dlog|dinfo|dwarn)\s*\(/.test(stripped)) {
          offenders.push(`background.js:${fn.startLine + i}: ${line.trim()}`);
        }
      }
      expect(
        offenders,
        `Use raw console.log / console.warn inside ${fn.name} — see the comment near the dlog definitions in background.js.`
      ).toEqual([]);
    });
  }
});
