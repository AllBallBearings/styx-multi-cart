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
  ENTITLEMENT_KEY,
  DEV_FLAG_KEY,
  DEFAULT_SETTINGS,
  DEFAULT_ENTITLEMENT,
  pruneUpsellChoices,
  backfillLastUsedAt,
} from "./helpers.js";

export async function readCarts() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const carts = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
  // Backfill lastUsedAt on carts saved before the entitlement layer existed.
  // Done lazily in memory; persistence happens naturally on the next write.
  return backfillLastUsedAt(carts);
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

// ---- Entitlement storage --------------------------------------------------

export async function readEntitlement() {
  const result = await chrome.storage.local.get(ENTITLEMENT_KEY);
  const stored = result[ENTITLEMENT_KEY];
  return Object.assign(
    {},
    DEFAULT_ENTITLEMENT,
    stored && typeof stored === "object" ? stored : {}
  );
}

export async function writeEntitlement(patch) {
  const current = await readEntitlement();
  const next = Object.assign({}, current, patch || {});
  await chrome.storage.local.set({ [ENTITLEMENT_KEY]: next });
  return next;
}

/**
 * Bump lastUsedAt on a single cart. Returns true if the cart existed.
 * Callers should invoke this after any positive interaction (restore, edit,
 * rename, item add/remove, merge target).
 */
export async function touchCartLastUsed(cartId, nowMs = Date.now()) {
  const carts = await readCarts();
  const target = carts.find((c) => c && c.id === cartId);
  if (!target) return false;
  target.lastUsedAt = nowMs;
  await writeCarts(carts);
  return true;
}

/**
 * Hidden developer toggle. Set `chrome.storage.local["mc.dev.v1"] = true`
 * in DevTools to enable MC_DEV_SET_ENTITLEMENT and any other dev-only
 * affordances. Off by default in production.
 */
export async function isDevModeEnabled() {
  const r = await chrome.storage.local.get(DEV_FLAG_KEY);
  return r[DEV_FLAG_KEY] === true;
}
