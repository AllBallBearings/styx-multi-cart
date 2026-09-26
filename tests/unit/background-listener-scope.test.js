/**
 * The service worker's onMessage listener declares its second parameter once
 * and reads it in several handlers far below (save-cart progress, the
 * tab-navigation handler, ...). Renaming the parameter without updating every
 * use throws "Can't find variable: _sender" only when one of those handlers
 * runs, and none of the unit tests exercise them, so it shipped once and broke
 * "Save Amazon cart for later" in Safari. Fail here instead.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Comments may mention "sender.tab" in prose; only real code counts.
const source = fs
  .readFileSync(path.join(ROOT, "src", "background", "index.js"), "utf8")
  .split("\n")
  .filter((line) => !/^\s*\/\//.test(line))
  .join("\n");

describe("background onMessage listener sender parameter", () => {
  const declared = source.match(
    /chrome\.runtime\.onMessage\.addListener\(\(\s*msg\s*,\s*(\w+)\s*,\s*sendResponse\s*\)/
  );

  it("declares a sender parameter", () => {
    expect(declared).not.toBeNull();
  });

  it("uses only the declared name when reading the sender's tab", () => {
    const name = declared[1];
    // Every `<ident>.tab` read that looks like the sender (sender / _sender).
    const used = new Set(
      [...source.matchAll(/\b(_?sender)\s*&&\s*\1\.tab|\b(_?sender)\.tab\b/g)].map(
        (m) => m[1] || m[2]
      )
    );
    expect([...used].filter((n) => n !== name)).toEqual([]);
  });
});
