// Stands in for the extension APIs so the real observer.js and popup can run on demo pages.
(function () {
  const { messages, lists } = window.__styxDemo;
  const store = {
    "mc.settings.v1": { interceptAtc: true, relabelListsAsCarts: true, theme: "light" },
    "mc.amazonlists.v1": { lists, host: "www.amazon.com", fetchedAt: Date.now() },
    "styx.onboarding.v1": { done: true, seen: true, completed: true, dismissed: true },
  };
  function respond(m) {
    switch (m && m.type) {
      case "MC_LIST_AMAZON_LISTS":
      case "MC_ENSURE_AMAZON_LISTS":
        return { ok: true, lists, host: "www.amazon.com", entitlement: { isPremium: false, limit: 3, customCount: 3 } };
      case "MC_GET_LIST_ACCESS": return { ok: true, access: "editable" };
      case "MC_GET_ENTITLEMENT": return { ok: true, entitlement: { tier: "free" }, premium: false };
      case "MC_GET_INTERCEPT": return { ok: true, enabled: true };
      case "MC_GET_RELABEL": return { ok: true, enabled: true };
      case "MC_GET_FAB_PULSE": return { ok: true, enabled: false };
      case "MC_GET_UI_SURFACE": return { ok: true, surface: "floating" };
      case "MC_GET_CART_COUNT": return { ok: true, count: 3 };
      case "MC_GET_LIST_COUNTS": return { ok: true, counts: {} };
      case "MC_GET_AMAZON_LIST": return { ok: true, list: { host: "www.amazon.com", items: [] } };
      default: return { ok: true };
    }
  }
  const listen = { addListener() {}, removeListener() {} };
  window.chrome = {
    i18n: {
      getUILanguage: () => "en",
      getMessage(key, subs) {
        const entry = messages[key];
        if (!entry) return "";
        const list = subs == null ? [] : Array.isArray(subs) ? subs : [subs];
        return entry.message
          .replace(/\$([A-Za-z_][A-Za-z0-9_]*)\$/g, (m, name) => {
            const p = entry.placeholders && entry.placeholders[name.toLowerCase()];
            return p ? p.content : m;
          })
          .replace(/\$(\d)/g, (m, n) => (list[n - 1] == null ? "" : String(list[n - 1])));
      },
    },
    runtime: {
      id: "styxdemo",
      lastError: null,
      getURL: (p) => "https://www.amazon.com/__ext/" + p,
      getManifest: () => ({ version: "1.0.11", name: "Styx Multi-Cart" }),
      onMessage: listen,
      sendMessage(m, cb) {
        const r = respond(m);
        if (typeof cb === "function") { setTimeout(() => cb(r), 0); return; }
        return Promise.resolve(r);
      },
    },
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          const names = keys == null ? Object.keys(store) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          for (const k of names) if (k in store) out[k] = store[k];
          if (typeof cb === "function") { setTimeout(() => cb(out), 0); return; }
          return Promise.resolve(out);
        },
        set(o, cb) { Object.assign(store, o); if (cb) cb(); return Promise.resolve(); },
        remove(k, cb) { if (cb) cb(); return Promise.resolve(); },
      },
      onChanged: listen,
    },
    tabs: { query: async () => [], create: async () => ({}), onUpdated: listen },
  };
})();
