/**
 * lib/storage.js — chrome.storage.local wrappers extracted from background.js
 * for unit testing.
 *
 * Like lib/helpers.js, these are byte-identical copies of the originals.
 * Keep both in sync until background.js is refactored to import from here.
 */

import {
  STORAGE_KEY,
  SETTINGS_KEY,
  UPSELL_CHOICES_KEY,
  DEFAULT_SETTINGS,
  pruneUpsellChoices,
} from "./helpers.js";

export async function readCarts() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
}

export async function writeCarts(carts) {
  await chrome.storage.local.set({ [STORAGE_KEY]: carts });
}

export async function readSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = result[SETTINGS_KEY];
  return Object.assign(
    {},
    DEFAULT_SETTINGS,
    stored && typeof stored === "object" ? stored : {}
  );
}

export async function writeSettings(patch) {
  const current = await readSettings();
  const next = Object.assign({}, current, patch || {});
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function getUpsellChoices() {
  const obj = await chrome.storage.local.get(UPSELL_CHOICES_KEY);
  const map = obj[UPSELL_CHOICES_KEY] || {};
  const pruned = pruneUpsellChoices(map);
  if (Object.keys(pruned).length !== Object.keys(map).length) {
    await chrome.storage.local.set({ [UPSELL_CHOICES_KEY]: pruned });
  }
  return pruned;
}

export async function recordUpsellChoice(asin, entry) {
  if (!asin) return;
  const map = await getUpsellChoices();
  map[asin] = { ...entry, recordedAt: Date.now() };
  await chrome.storage.local.set({ [UPSELL_CHOICES_KEY]: map });
}

export async function getRecordedUpsellChoice(asin) {
  if (!asin) return null;
  const map = await getUpsellChoices();
  return map[asin] || null;
}
