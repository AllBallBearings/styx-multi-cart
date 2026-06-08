/**
 * popup.js — drives the extension popup.
 *
 * All real work happens in the background service worker;
 * this file just renders state and forwards button clicks.
 */

(function () {
  "use strict";

  // The native Chrome side panel loads this page with ?surface=sidepanel so
  // it can fill the panel's width/height instead of the fixed popup size.
  // ("panel" is the legacy in-page-iframe value, kept for safety.)
  const _surface = new URLSearchParams(location.search).get("surface");
  if (_surface === "sidepanel" || _surface === "panel") {
    document.documentElement.dataset.surface = _surface;
  }

  // ---- DOM refs ----------------------------------------------------------

  const $name = document.getElementById("mc-name");
  const $save = document.getElementById("mc-save");
  const $clear = document.getElementById("mc-clear");
  const $list = document.getElementById("mc-list");
  const $count = document.getElementById("mc-list-count");
  const $empty = document.getElementById("mc-empty");
  const $toast = document.getElementById("mc-toast");
  const $template = document.getElementById("mc-item-template");
  const $diagnose = document.getElementById("mc-diagnose");
  const $debugOutput = document.getElementById("mc-debug-output");
  const $debugPanel = document.getElementById("mc-debug");
  const $debugEntState = document.getElementById("mc-debug-ent-state");
  const $copyLogs = document.getElementById("mc-copy-logs");
  const $combineBtn = document.getElementById("mc-combine");
  const $combineBar = document.getElementById("mc-combine-bar");
  const $combineStatus = document.getElementById("mc-combine-status");
  const $combineContinue = document.getElementById("mc-combine-continue");
  const $combineCancel = document.getElementById("mc-combine-cancel");
  const $combineModal = document.getElementById("mc-combine-modal");
  const $moveModal = document.getElementById("mc-move-modal");
  const $moveList = $moveModal.querySelector(".mc-move-list");
  const $moveCreate = $moveModal.querySelector('[data-action="move-create"]');
  const $moveThumb = $moveModal.querySelector(".mc-move-thumb");
  const $moveItemName = $moveModal.querySelector(".mc-move-item-name");
  const $qtyPop = document.getElementById("mc-qty-pop");
  const $qtyPopVal = $qtyPop.querySelector(".mc-qty-pop-val");
  const $interceptToggle = document.getElementById("mc-intercept-toggle");
  const $createNew = document.getElementById("mc-create-new");
  const $themeToggle = document.getElementById("mc-theme-toggle");

  // Entitlement / paywall UI refs.
  const $headerPremiumBadge = document.getElementById("mc-header-premium-badge");
  const $tierStrip = document.getElementById("mc-tier-strip");
  const $tierBadge = document.getElementById("mc-tier-badge");
  const $tierUsage = document.getElementById("mc-tier-usage");
  const $tierUpgrade = document.getElementById("mc-tier-upgrade");
  const $lapsedBanner = document.getElementById("mc-lapsed-banner");
  const $lapsedCount = document.getElementById("mc-lapsed-count");
  const $lapsedSuffix = document.getElementById("mc-lapsed-suffix");
  const $lapsedRenew = document.getElementById("mc-lapsed-renew");
  const $paywallModal = document.getElementById("mc-paywall-modal");
  const $paywallTitle = document.getElementById("mc-paywall-title");
  const $paywallSub = document.getElementById("mc-paywall-sub");
  const $paywallStub = document.getElementById("mc-paywall-stub");

  // Confirm-dialog refs (in-popup replacement for window.confirm).
  const $confirmModal = document.getElementById("mc-confirm-modal");
  const $confirmTitle = document.getElementById("mc-confirm-title");
  const $confirmBody = document.getElementById("mc-confirm-body");
  const $confirmOk = document.getElementById("mc-confirm-ok");
  const $confirmCancel = document.getElementById("mc-confirm-cancel");

  // Prompt-dialog refs (in-popup replacement for window.prompt).
  const $promptModal = document.getElementById("mc-prompt-modal");
  const $promptTitle = document.getElementById("mc-prompt-title");
  const $promptBody = document.getElementById("mc-prompt-body");
  const $promptForm = document.getElementById("mc-prompt-form");
  const $promptInput = document.getElementById("mc-prompt-input");
  const $promptOk = document.getElementById("mc-prompt-ok");
  const $promptCancel = document.getElementById("mc-prompt-cancel");

  // Cached at popup boot. Developer mode is unlocked by typing the code
  // STYXDEV while the Settings modal is open (see the Settings section below).
  // Once unlocked, Ctrl+Alt+D and 5-clicking the tagline toggle the debug
  // panel — both are gated on this flag, so production users never trigger
  // them. mc.dev.v1 in chrome.storage.local is the source of truth, mirrored
  // here and in the service worker / content scripts.
  let devModeEnabled = false;

  // ---- Diagnostic logging --------------------------------------------------
  // Mirrors the service-worker / content-script loggers: when Developer mode is
  // on, dlog/dwarn forward popup-side logs (and uncaught errors) to the SW's
  // diagnostic ring via MC_LOG_PUSH, so "Copy diagnostic logs" gathers them
  // alongside the rest. Gated on devModeEnabled, which already tracks mc.dev.v1.
  const mcStringifyArgs = (args) =>
    args
      .map((v) => {
        if (typeof v === "string") return v;
        try { return JSON.stringify(v); } catch (_) { return String(v); }
      })
      .join(" ");
  function mcForwardLog(level, args) {
    try {
      chrome.runtime.sendMessage({
        type: "MC_LOG_PUSH",
        entry: { ts: Date.now(), ctx: "popup", level, url: location.href, msg: mcStringifyArgs(args) },
      });
    } catch (_) {}
  }
  const dlog = (...a) => { if (!devModeEnabled) return; console.log(...a); mcForwardLog("log", a); };
  const dwarn = (...a) => { if (!devModeEnabled) return; console.warn(...a); mcForwardLog("warn", a); };
  window.addEventListener("error", (e) => {
    if (!devModeEnabled) return;
    mcForwardLog("error", [`uncaught: ${e.message} @ ${e.filename}:${e.lineno}`]);
  });
  window.addEventListener("unhandledrejection", (e) => {
    if (!devModeEnabled) return;
    mcForwardLog("error", [`unhandledrejection: ${(e.reason && e.reason.message) || e.reason}`]);
  });
  void dlog;
  void dwarn;

  // Cached entitlement from the last MC_LIST_CARTS / MC_GET_ENTITLEMENT response.
  // See docs/MONETIZATION_PLAN.md. Always populated before render() runs.
  let currentEntitlement = {
    tier: "free",
    isPremium: false,
    limit: 2,
    count: 0,
    premiumUntil: null,
    autoRenew: false,
    source: null,
  };

  // Persistent dismissal snoozes for the tier strip and lapsed banner. Each
  // value is the timestamp at which the user last clicked ×; the surface stays
  // hidden until DISMISS_SNOOZE_MS has elapsed, then it comes back. Also reset
  // on entitlement state changes via the debug menu and (eventually) the
  // payment-provider hook in Phase 3.
  const DISMISS_KEY = "mc.ui.dismissed.v1";
  const DISMISS_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  // Shape: { tierStrip: number|null, lapsedBanner: number|null } where number
  // is a Date.now() timestamp captured when the user clicked ×.
  let uiDismissed = { tierStrip: null, lapsedBanner: null };

  function isSnoozed(key, now) {
    const ts = uiDismissed[key];
    if (!ts) return false;
    return now - ts < DISMISS_SNOOZE_MS;
  }

  // ---- Messaging ---------------------------------------------------------

  /** Wraps chrome.runtime.sendMessage with a Promise + nicer error shape. */
  function send(message) {
    return new Promise((resolve) => {
      let done = false;
      const timeout = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({
          ok: false,
          error: "No response from extension service worker.",
        });
      }, 10000);

      chrome.runtime.sendMessage(message, (response) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            error: chrome.runtime.lastError.message || "Unknown error",
          });
          return;
        }
        resolve(response || { ok: false, error: "No response" });
      });
    });
  }

  // ---- Toast -------------------------------------------------------------

  let toastTimer = null;
  function toast(message, kind) {
    $toast.textContent = message;
    $toast.classList.toggle("mc-toast-error", kind === "error");
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      $toast.hidden = true;
    }, 2600);
  }

  // ---- Confirm dialog (in-popup replacement for window.confirm) ----------
  //
  // Returns a Promise<boolean>. Resolves true on OK, false on Cancel /
  // backdrop / Escape. Only one confirm can be live at a time — if a new
  // call comes in while another is open, the older one auto-cancels.

  let confirmPending = null;

  function confirmDialog(opts) {
    const {
      title = "Are you sure?",
      message = "",
      emphasis = null,
      okLabel = "OK",
      cancelLabel = "Cancel",
      destructive = false,
    } = opts || {};

    // Auto-cancel any previous pending confirm.
    if (confirmPending) confirmPending.resolve(false);

    $confirmTitle.textContent = title;
    $confirmBody.textContent = "";
    if (emphasis && typeof emphasis === "object") {
      const before = emphasis.before || "";
      const text = emphasis.text || "";
      const after = emphasis.after || "";
      if (before) $confirmBody.appendChild(document.createTextNode(before));
      const strong = document.createElement("strong");
      strong.className = "mc-confirm-emphasis";
      strong.textContent = text;
      $confirmBody.appendChild(strong);
      if (after) $confirmBody.appendChild(document.createTextNode(after));
    } else {
      $confirmBody.textContent = message;
    }
    $confirmOk.textContent = okLabel;
    $confirmCancel.textContent = cancelLabel;
    $confirmOk.classList.toggle("mc-btn-danger", !!destructive);

    $confirmModal.hidden = false;
    $confirmModal.removeAttribute("inert");
    // Give the OK button focus so Enter == confirm.
    setTimeout(() => $confirmOk.focus(), 0);

    return new Promise((resolve) => {
      confirmPending = {
        resolve: (value) => {
          if (!confirmPending) return;
          confirmPending = null;
          $confirmModal.hidden = true;
          $confirmModal.setAttribute("inert", "");
          $confirmOk.classList.remove("mc-btn-danger");
          resolve(value);
        },
      };
    });
  }

  $confirmModal.addEventListener("click", (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "confirm-ok") {
      confirmPending?.resolve(true);
    } else if (action === "confirm-cancel") {
      confirmPending?.resolve(false);
    }
  });

  // Esc closes (cancel); Enter on OK is handled natively by focus.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (confirmPending) {
      e.preventDefault();
      confirmPending.resolve(false);
    } else if (promptPending) {
      e.preventDefault();
      promptPending.resolve(null);
    }
  });

  // ---- Prompt dialog (in-popup replacement for window.prompt) ------------
  //
  // Returns a Promise<string|null>. Resolves to the entered string on OK
  // (after trim, if configured), or null on Cancel / backdrop / Escape.
  // Only one prompt can be live at a time.

  let promptPending = null;

  function promptDialog(opts) {
    const {
      title = "Enter a value",
      message = "",
      placeholder = "",
      initialValue = "",
      okLabel = "OK",
      cancelLabel = "Cancel",
      maxLength = 60,
      allowEmpty = false,
      trim = true,
    } = opts || {};

    if (promptPending) promptPending.resolve(null);

    $promptTitle.textContent = title;
    if (message) {
      $promptBody.textContent = message;
      $promptBody.hidden = false;
    } else {
      $promptBody.textContent = "";
      $promptBody.hidden = true;
    }
    $promptInput.value = initialValue;
    $promptInput.placeholder = placeholder;
    $promptInput.maxLength = maxLength;
    $promptOk.textContent = okLabel;
    $promptCancel.textContent = cancelLabel;

    $promptModal.hidden = false;
    $promptModal.removeAttribute("inert");
    setTimeout(() => {
      $promptInput.focus();
      $promptInput.select();
    }, 0);

    return new Promise((resolve) => {
      promptPending = {
        config: { allowEmpty, trim },
        resolve: (value) => {
          if (!promptPending) return;
          promptPending = null;
          $promptModal.hidden = true;
          $promptModal.setAttribute("inert", "");
          resolve(value);
        },
      };
    });
  }

  function submitPrompt() {
    if (!promptPending) return;
    const { allowEmpty, trim } = promptPending.config;
    let value = $promptInput.value;
    if (trim) value = value.trim();
    if (!allowEmpty && value === "") {
      // Nudge user — flash the input, keep dialog open.
      $promptInput.focus();
      $promptInput.classList.add("mc-input-error");
      setTimeout(() => $promptInput.classList.remove("mc-input-error"), 400);
      return;
    }
    promptPending.resolve(value);
  }

  $promptForm.addEventListener("submit", (e) => {
    e.preventDefault();
    submitPrompt();
  });

  $promptModal.addEventListener("click", (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "prompt-cancel") {
      promptPending?.resolve(null);
    }
    // prompt-ok is the submit button — handled via the form submit listener.
  });

  // ---- Loading helper ----------------------------------------------------

  async function withLoading(button, fn) {
    button.classList.add("mc-loading");
    button.disabled = true;
    try {
      return await fn();
    } finally {
      button.classList.remove("mc-loading");
      button.disabled = false;
    }
  }

  // ---- Rendering ---------------------------------------------------------

  function formatRelative(iso) {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "";
    const diff = Date.now() - then;
    const sec = Math.round(diff / 1000);
    if (sec < 60) return "just now";
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} min ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr} hr ago`;
    const day = Math.round(hr / 24);
    if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
    return new Date(iso).toLocaleDateString();
  }

  // Cache of the most recent carts list, keyed by id. Used by the inline
  // editor so it can re-render rows without another background round-trip.
  const cartCache = new Map();

  function isUsableThumb(url) {
    return Boolean(
      url &&
        !url.startsWith("data:") &&
        !url.includes("loadIndicators") &&
        !url.includes("transparent-pixel")
    );
  }

  // How many tiles show before the strip collapses behind a "+N more" toggle.
  const THUMB_CAP = 6;
  // Cart ids whose thumbnail strip is currently expanded past the cap.
  const expandedThumbs = new Set();

  // Build one interactive item tile. On editable carts the tile carries the
  // controls the old Edit panel used to: an X to remove, a quantity badge
  // that opens the +/- popover, and click-the-picture to move the item.
  function makeThumbTile(item, locked) {
    const tile = document.createElement("div");
    tile.className = "mc-thumb";
    tile.dataset.asin = item.asin || "";
    tile.title = item.title || item.asin || "";

    if (isUsableThumb(item.image)) {
      const img = document.createElement("img");
      img.className = "mc-thumb-img";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.src = item.image;
      img.alt = "";
      // If Amazon's CDN refuses the URL, fall back to the title placeholder.
      img.onerror = () => {
        img.remove();
        tile.classList.add("mc-thumb-noimg");
      };
      tile.appendChild(img);
    } else {
      tile.classList.add("mc-thumb-noimg");
    }

    const ph = document.createElement("span");
    ph.className = "mc-thumb-ph";
    ph.setAttribute("aria-hidden", "true");
    ph.textContent = (item.title || item.asin || "?").slice(0, 16);
    tile.appendChild(ph);

    if (locked) {
      // Read-only carts: no controls, but keep the count visible.
      const qty = document.createElement("span");
      qty.className = "mc-thumb-qty mc-thumb-qty-static";
      qty.textContent = String(item.quantity || 1);
      tile.appendChild(qty);
      return tile;
    }

    // The tile body is the "move" affordance.
    tile.dataset.action = "thumb-move";
    tile.setAttribute("role", "button");
    tile.tabIndex = 0;
    tile.setAttribute(
      "aria-label",
      `${item.title || item.asin || "Item"} — click to move to another cart`
    );

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mc-thumb-remove";
    remove.dataset.action = "thumb-remove";
    remove.title = "Remove item";
    remove.setAttribute("aria-label", `Remove ${item.title || item.asin || "item"}`);
    remove.textContent = "×";
    tile.appendChild(remove);

    const qty = document.createElement("button");
    qty.type = "button";
    qty.className = "mc-thumb-qty";
    qty.dataset.action = "thumb-qty";
    qty.title = "Change quantity";
    qty.setAttribute("aria-label", `Quantity ${item.quantity || 1}, click to change`);
    qty.textContent = String(item.quantity || 1);
    tile.appendChild(qty);

    return tile;
  }

  function renderCartThumbs(thumbs, cart) {
    if (!thumbs) return;
    thumbs.innerHTML = "";
    const items = cart.items || [];
    if (items.length === 0) return;
    const locked = cart.access === "readonly";
    const overflow = items.length > THUMB_CAP;
    const expanded = expandedThumbs.has(cart.id);
    const shown = !overflow || expanded ? items.length : THUMB_CAP;

    for (let i = 0; i < shown; i++) {
      thumbs.appendChild(makeThumbTile(items[i], locked));
    }
    if (overflow) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "mc-item-thumb-more";
      more.dataset.action = "thumb-more";
      if (expanded) {
        more.textContent = "Show less";
        more.setAttribute("aria-label", "Show fewer items");
      } else {
        more.textContent = `+${items.length - THUMB_CAP}`;
        more.setAttribute("aria-label", `Show ${items.length - THUMB_CAP} more items`);
      }
      thumbs.appendChild(more);
    }
  }

  function renderItem(cart) {
    const node = $template.content.firstElementChild.cloneNode(true);
    node.dataset.id = cart.id;

    // Lapsed-premium read-only carts: visible but action buttons disabled
    // (except Delete, which is always allowed for cleanup). See
    // docs/MONETIZATION_PLAN.md.
    const isLocked = cart.access === "readonly";
    if (isLocked) {
      node.classList.add("mc-item-locked");
      node.dataset.access = "readonly";
      // Real clickable upgrade pill, replaces the old CSS ::before label.
      // Clicking it opens the paywall in renew mode.
      const lockPill = document.createElement("button");
      lockPill.type = "button";
      lockPill.className = "mc-item-lock-pill";
      lockPill.dataset.action = "lock-upgrade";
      lockPill.title = "Renew Premium to edit this cart";
      lockPill.textContent = "Read-Only — Go Premium?";
      node.prepend(lockPill);
    }

    if (combineState.active) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "mc-select-checkbox";
      cb.setAttribute("aria-label", `Select cart "${cart.name}" to combine`);
      cb.checked = combineState.selected.includes(cart.id);
      node.classList.toggle("mc-item-selected", cb.checked);
      node.prepend(cb);
    }

    const nameBtn = node.querySelector(".mc-item-name");
    nameBtn.textContent = cart.name;
    if (isLocked) {
      // Strip rename affordance — CSS handles visuals, this kills the action.
      nameBtn.setAttribute("disabled", "");
      nameBtn.setAttribute("title", "Locked — renew Premium to rename");
      nameBtn.dataset.action = "rename-locked";
    }

    const totalQty = (cart.items || []).reduce(
      (n, it) => n + (it.quantity || 1),
      0
    );
    const itemWord = cart.items.length === 1 ? "item" : "items";
    node.querySelector(".mc-item-count").textContent =
      `${cart.items.length} ${itemWord} · ${totalQty} qty`;

    const host = (cart.host || "www.amazon.com").replace(/^www\./, "");
    node.querySelector(".mc-item-meta").textContent =
      `${host} · saved ${formatRelative(cart.savedAt)}`;

    const thumbs = node.querySelector(".mc-item-thumbs");
    renderCartThumbs(thumbs, cart);

    // Disable write actions on locked carts. CSS already grays them, but
    // setting `disabled` ensures keyboard / screen-reader users see the
    // locked state, and the delegated click handlers below skip them.
    if (isLocked) {
      const btn = node.querySelector('button[data-action="restore"]');
      if (btn) {
        btn.setAttribute("disabled", "");
        btn.setAttribute("title", "Locked — renew Premium to use this cart");
      }
    }

    return node;
  }

  /**
   * Two-group sort: editable carts A–Z first, then read-only carts A–Z.
   * Matches the picker's ordering for consistency across surfaces.
   */
  function sortCartsForDisplay(carts) {
    const cmpName = (a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), undefined, {
        sensitivity: "base",
        numeric: true,
      });
    const editable = [];
    const locked = [];
    for (const c of carts || []) {
      if (c.access === "readonly") locked.push(c);
      else editable.push(c);
    }
    editable.sort(cmpName);
    locked.sort(cmpName);
    return editable.concat(locked);
  }

  function render(carts) {
    cartCache.clear();
    carts.forEach((c) => cartCache.set(c.id, c));
    $list.innerHTML = "";
    $count.textContent = String(carts.length);
    $empty.hidden = carts.length > 0;
    const ordered = sortCartsForDisplay(carts);
    ordered.forEach((cart) => $list.appendChild(renderItem(cart)));
    renderTierStrip(carts);
    renderLapsedBanner(carts);
  }

  // ---- Tier strip + banners ---------------------------------------------

  /**
   * Render the per-popup tier indicator + usage + upgrade CTA. Hidden when
   * the popup has no carts AND user is on the free plan — keeps the empty
   * state clean for first-time users.
   */
  function renderTierStrip(carts) {
    const ent = currentEntitlement;
    const count = carts.length;
    const limit = ent.limit || 2;
    const premium = !!ent.isPremium;
    const now = Date.now();

    // Premium users see their status in the header badge instead — no strip.
    // Drive the header badge from this same renderer.
    if ($headerPremiumBadge) {
      $headerPremiumBadge.hidden = !premium;
    }

    // Hide the strip when:
    //  - user is premium (header badge covers it), OR
    //  - totally empty free-tier popup (first-run cleanliness), OR
    //  - any locked carts are present (lapsed banner is the dominant signal —
    //    "Renew" is the right CTA for an ex-premium user; "Upgrade" would
    //    be misleading), OR
    //  - user dismissed within the snooze window.
    const hasLocked = carts.some((c) => c.access === "readonly");
    if (premium || count === 0 || hasLocked || isSnoozed("tierStrip", now)) {
      $tierStrip.hidden = true;
      return;
    }
    $tierStrip.hidden = false;

    $tierBadge.textContent = "Free";
    $tierBadge.dataset.tier = "free";

    const cartWord = limit === 1 ? "cart" : "carts";
    $tierUsage.textContent = `${count} / ${limit} saved ${cartWord}`;

    $tierUpgrade.hidden = false;
  }

  /**
   * Lapsed banner: shown when a free-tier user has read-only carts visible
   * (i.e., they were premium, kept >2 carts, and the subscription lapsed).
   * Per spec, this banner is persistent and only disappears on renewal or
   * cart cleanup.
   */
  function renderLapsedBanner(carts) {
    const locked = carts.filter((c) => c.access === "readonly").length;
    const now = Date.now();
    if (
      currentEntitlement.isPremium ||
      locked === 0 ||
      isSnoozed("lapsedBanner", now)
    ) {
      $lapsedBanner.hidden = true;
      return;
    }
    $lapsedBanner.hidden = false;
    $lapsedCount.textContent = String(locked);
    $lapsedSuffix.textContent = locked === 1 ? " cart is read-only" : " carts are read-only";
  }

  // ---- Item tile helpers -------------------------------------------------

  function updateRowSummary(li, cart) {
    const totalQty = (cart.items || []).reduce((n, it) => n + (it.quantity || 1), 0);
    const itemWord = cart.items.length === 1 ? "item" : "items";
    li.querySelector(".mc-item-count").textContent =
      `${cart.items.length} ${itemWord} · ${totalQty} qty`;
  }

  async function refresh() {
    const res = await send({ type: "MC_LIST_CARTS" });
    if (!res.ok) return;
    if (res.entitlement) {
      currentEntitlement = Object.assign(currentEntitlement, res.entitlement);
    }
    render(res.carts || []);
  }

  // ---- Settings: ATC intercept toggle ------------------------------------

  async function loadInterceptSetting() {
    const res = await send({ type: "MC_GET_INTERCEPT" });
    if (res.ok) $interceptToggle.checked = !!res.enabled;
  }

  $interceptToggle.addEventListener("change", async () => {
    const enabled = $interceptToggle.checked;
    const res = await send({ type: "MC_SET_INTERCEPT", enabled });
    if (!res.ok) {
      // Revert and notify if the write failed.
      $interceptToggle.checked = !enabled;
      toast(res.error || "Could not save setting", "error");
    }
  });

  // ---- Settings: light / dark mode toggle --------------------------------

  const MOON_SVG = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M13.5 9.5a6 6 0 1 1-7-7 4.5 4.5 0 0 0 7 7z" fill="currentColor"/>
  </svg>`;

  const SUN_SVG = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle cx="8" cy="8" r="3" fill="currentColor"/>
    <line x1="8" y1="1" x2="8" y2="3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="8" y1="13" x2="8" y2="15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="1" y1="8" x2="3" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="13" y1="8" x2="15" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="3.05" y1="3.05" x2="4.46" y2="4.46" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="11.54" y1="11.54" x2="12.95" y2="12.95" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="12.95" y1="3.05" x2="11.54" y2="4.46" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="4.46" y1="11.54" x2="3.05" y2="12.95" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;

  function applyTheme(theme) {
    const html = document.documentElement;
    if (theme === "dark" || theme === "light") {
      html.dataset.theme = theme;
    } else {
      delete html.dataset.theme;
    }
    // Show the icon that lets the user switch TO the opposite mode.
    const resolvedDark =
      theme === "dark" ||
      (!theme && window.matchMedia("(prefers-color-scheme: dark)").matches);
    $themeToggle.innerHTML = resolvedDark ? SUN_SVG : MOON_SVG;
    $themeToggle.title = resolvedDark
      ? "Switch to light mode"
      : "Switch to dark mode";
    $themeToggle.setAttribute(
      "aria-label",
      resolvedDark ? "Switch to light mode" : "Switch to dark mode"
    );
  }

  async function loadThemeSetting() {
    const result = await chrome.storage.local.get("mc.settings.v1");
    const settings = result["mc.settings.v1"];
    const theme =
      settings && typeof settings.theme === "string" ? settings.theme : null;
    applyTheme(theme);
  }

  $themeToggle.addEventListener("click", async () => {
    const current = document.documentElement.dataset.theme || null;
    const resolvedDark =
      current === "dark" ||
      (!current && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const next = resolvedDark ? "light" : "dark";
    applyTheme(next);
    // Persist alongside existing settings without overwriting other keys.
    const result = await chrome.storage.local.get("mc.settings.v1");
    const settings = Object.assign({}, result["mc.settings.v1"] || {});
    settings.theme = next;
    await chrome.storage.local.set({ "mc.settings.v1": settings });
  });

  // ---- Event wiring ------------------------------------------------------

  function defaultName() {
    const d = new Date();
    const day = d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    const time = d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    return `Cart · ${day}, ${time}`;
  }

  $save.addEventListener("click", () => {
    const name = ($name.value || "").trim() || defaultName();
    withLoading($save, async () => {
      const res = await send({ type: "MC_SAVE_CURRENT", name });
      if (res.ok) {
        toast(`Saved ${res.count} item${res.count === 1 ? "" : "s"}`);
        $name.value = "";
        await refresh();
      } else if (!handleEntitlementError(res)) {
        toast(res.error || "Could not save cart", "error");
      }
    });
  });

  $clear.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Clear Amazon cart?",
      message: "Are you sure you want to clear your current Amazon cart?",
      okLabel: "Clear cart",
      destructive: true,
    });
    if (!ok) return;
    withLoading($clear, async () => {
      const res = await send({ type: "MC_CLEAR_CURRENT" });
      if (res.ok) {
        toast(
          res.alreadyEmpty
            ? "Your Amazon cart is already empty."
            : "Clearing your cart — check the Amazon tab."
        );
      } else {
        toast(res.error || "Could not clear cart", "error");
      }
    });
  });

  // ---- Combine mode ------------------------------------------------------

  const combineState = {
    active: false,
    selected: [], // up to 2 cart ids, oldest first
  };

  function setCombineMode(on) {
    combineState.active = on;
    combineState.selected = [];
    document.body.classList.toggle("mc-combine-active", on);
    $combineBar.hidden = !on;
    $combineBtn.textContent = on ? "Done" : "Merge Carts";
    $combineBtn.classList.toggle("mc-btn-active", on);
    updateCombineStatus();
    // Force a re-render so checkboxes appear/disappear and any prior
    // selection visual state resets.
    refresh();
  }

  function updateCombineStatus() {
    if (!combineState.active) return;
    const n = combineState.selected.length;
    if (n === 0) {
      $combineStatus.textContent = "Pick 2 carts to combine.";
    } else if (n === 1) {
      $combineStatus.textContent = "Pick 1 more.";
    } else {
      $combineStatus.textContent = "Ready to merge?";
    }
    $combineContinue.disabled = n !== 2;
  }

  function toggleCombineSelection(id) {
    const idx = combineState.selected.indexOf(id);
    if (idx >= 0) {
      combineState.selected.splice(idx, 1);
    } else {
      if (combineState.selected.length >= 2) {
        // Drop the oldest selection to make room for the new one.
        combineState.selected.shift();
      }
      combineState.selected.push(id);
    }
    // Update visuals without a full refresh.
    Array.from($list.querySelectorAll("li.mc-item")).forEach((li) => {
      const selected = combineState.selected.includes(li.dataset.id);
      li.classList.toggle("mc-item-selected", selected);
      const cb = li.querySelector(".mc-select-checkbox");
      if (cb) cb.checked = selected;
    });
    updateCombineStatus();
  }

  // ---- Combine modal -----------------------------------------------------

  function openCombineModal() {
    if (combineState.selected.length !== 2) return;
    const [idA, idB] = combineState.selected;
    const cartA = cartCache.get(idA);
    const cartB = cartCache.get(idB);
    if (!cartA || !cartB) {
      toast("Could not load both carts.", "error");
      return;
    }
    // Cross-region guard — fail fast before showing the modal.
    if (!hostsMatch(cartA.host, cartB.host)) {
      toast(
        `Can't merge: "${cartA.name}" is on ${cartA.host} but "${cartB.name}" is on ${cartB.host}.`,
        "error"
      );
      return;
    }

    // Populate every slot in the modal.
    $combineModal.querySelectorAll('[data-slot="a"]').forEach((el) => {
      el.textContent = cartA.name;
    });
    $combineModal.querySelectorAll('[data-slot="b"]').forEach((el) => {
      el.textContent = cartB.name;
    });
    $combineModal.dataset.cartA = idA;
    $combineModal.dataset.cartB = idB;
    $combineModal.hidden = false;
    // `inert` is the right tool here: it hides the subtree from AT and
    // also removes focusability. Toggling aria-hidden on a focused
    // ancestor trips Chrome's a11y guard (see the "Blocked aria-hidden
    // on an element because its descendant retained focus" warning).
    $combineModal.removeAttribute("inert");
  }

  function closeCombineModal() {
    // Move focus out of the modal BEFORE we mark it inert, otherwise
    // browsers still see a focused descendant inside an inert/hidden
    // subtree for one frame.
    const active = document.activeElement;
    if (active && $combineModal.contains(active)) {
      active.blur();
    }
    $combineModal.setAttribute("inert", "");
    $combineModal.hidden = true;
    delete $combineModal.dataset.cartA;
    delete $combineModal.dataset.cartB;
  }

  function hostsMatch(a, b) {
    const norm = (h) => (h || "www.amazon.com").toLowerCase().replace(/^www\./, "");
    return norm(a) === norm(b);
  }

  async function performCombine(sourceId, targetId) {
    const cartA = cartCache.get(sourceId);
    const cartB = cartCache.get(targetId);
    const res = await send({
      type: "MC_COMBINE_CARTS",
      sourceId,
      targetId,
    });
    if (!res.ok) {
      if (!handleEntitlementError(res)) {
        toast(res.error || "Could not combine carts.", "error");
      }
      return;
    }
    const bits = [];
    if (res.added) bits.push(`${res.added} item${res.added === 1 ? "" : "s"} added`);
    if (res.qtyBumped) bits.push(`${res.qtyBumped} qty bumped`);
    const detail = bits.length ? ` (${bits.join(", ")})` : "";
    toast(
      `Merged "${(cartA && cartA.name) || res.sourceName}" into "${(cartB && cartB.name) || res.targetName}"${detail}.`
    );
    closeCombineModal();
    setCombineMode(false);
    await refresh();
  }

  // ---- Move-item modal ---------------------------------------------------
  //
  // Clicking an item's thumbnail in the edit panel opens this modal, which
  // lists every other cart the item can move into (same region, editable).
  // Picking one hands the move off to the background and re-opens the source
  // cart's edit panel so the user keeps their place.

  function openMoveModal(li, asin) {
    const sourceId = li.dataset.id;
    const source = cartCache.get(sourceId);
    if (!source) return;
    const item = (source.items || []).find((it) => it.asin === asin);
    if (!item) return;

    // Candidate destinations: every other cart on the same Amazon host that
    // isn't read-only. (The background re-checks all of this; this is just
    // so we don't offer carts that would be rejected.)
    const candidates = [];
    cartCache.forEach((cart, id) => {
      if (id === sourceId) return;
      if (cart.access === "readonly") return;
      if (!hostsMatch(cart.host, source.host)) return;
      candidates.push(cart);
    });
    candidates.sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), undefined, {
        sensitivity: "base",
        numeric: true,
      })
    );

    // Populate the item header.
    if (isUsableThumb(item.image)) {
      $moveThumb.src = item.image;
      $moveThumb.style.visibility = "";
      $moveThumb.onerror = () => { $moveThumb.style.visibility = "hidden"; };
    } else {
      $moveThumb.removeAttribute("src");
      $moveThumb.style.visibility = "hidden";
    }
    $moveItemName.textContent = item.title || item.asin || "(untitled)";

    // Build the cart list.
    $moveList.innerHTML = "";
    $moveList.classList.toggle("mc-move-list-scrollable", candidates.length > 3);
    if (candidates.length === 0) {
      const empty = document.createElement("li");
      empty.className = "mc-move-empty";
      empty.textContent =
        "No other carts to move into yet.";
      $moveList.appendChild(empty);
    } else {
      candidates.forEach((cart) => {
        const li2 = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "mc-move-option";
        btn.dataset.action = "move-go";
        btn.dataset.targetId = cart.id;
        const count = (cart.items || []).length;
        const host = (cart.host || "www.amazon.com").replace(/^www\./, "");
        const name = document.createElement("span");
        name.className = "mc-move-option-name";
        name.textContent = cart.name;
        const meta = document.createElement("span");
        meta.className = "mc-move-option-meta";
        meta.textContent = `${count} item${count === 1 ? "" : "s"}${host ? ` · ${host}` : ""}`;
        btn.append(name, meta);
        li2.appendChild(btn);
        $moveList.appendChild(li2);
      });
    }

    $moveModal.dataset.sourceId = sourceId;
    $moveModal.dataset.asin = asin;
    document.body.classList.add("mc-move-modal-open");
    $moveModal.hidden = false;
    $moveModal.removeAttribute("inert");
  }

  function closeMoveModal() {
    const active = document.activeElement;
    if (active && $moveModal.contains(active)) active.blur();
    $moveModal.setAttribute("inert", "");
    $moveModal.hidden = true;
    document.body.classList.remove("mc-move-modal-open");
    $moveList.classList.remove("mc-move-list-scrollable");
    delete $moveModal.dataset.sourceId;
    delete $moveModal.dataset.asin;
  }

  async function performMove(sourceId, targetId, asin) {
    const target = cartCache.get(targetId);
    const res = await send({
      type: "MC_MOVE_ITEM_BETWEEN_CARTS",
      sourceId,
      targetId,
      asin,
    });
    if (!res.ok) {
      if (!handleEntitlementError(res)) {
        toast(res.error || "Could not move item.", "error");
      }
      return;
    }
    closeMoveModal();
    closeQtyPop();
    const where = (target && target.name) || res.targetName || "cart";
    toast(`Moved "${res.itemTitle}" to "${where}".`);
    // Refresh so both the source and destination carts reflect the move.
    await refresh();
  }

  async function createMoveDestinationAndMove() {
    const sourceId = $moveModal.dataset.sourceId;
    const asin = $moveModal.dataset.asin;
    const source = sourceId ? cartCache.get(sourceId) : null;
    if (!sourceId || !asin || !source) {
      toast("Could not create a destination for this item.", "error");
      return;
    }

    // Let the prompt modal take focus cleanly while the move modal stays as
    // the visual context behind it.
    $moveModal.setAttribute("inert", "");
    const name = await promptDialog({
      title: "Create destination cart",
      placeholder: "e.g. Birthday gifts",
      okLabel: "Create",
    });
    if (!$moveModal.hidden) $moveModal.removeAttribute("inert");
    if (name == null) return;

    await withLoading($moveCreate, async () => {
      const res = await send({
        type: "MC_CREATE_EMPTY_CART",
        name,
        host: source.host || "www.amazon.com",
      });
      if (!res.ok) {
        if (!handleEntitlementError(res)) {
          toast(res.error || "Could not create cart.", "error");
        }
        return;
      }
      const targetId = res.cart && res.cart.id;
      if (!targetId) {
        toast("Created the cart, but could not move the item.", "error");
        await refresh();
        return;
      }
      await performMove(sourceId, targetId, asin);
    });
  }

  // ---- Item tile actions -------------------------------------------------

  // Reflect a quantity change on the tile badge (and the live popover, if it
  // happens to be open for this same item).
  function updateQtyBadge(li, asin, qty) {
    const badge = li.querySelector(
      `.mc-thumb[data-asin="${CSS.escape(asin)}"] .mc-thumb-qty`
    );
    if (badge) badge.textContent = String(qty);
    if (qtyPopCtx && qtyPopCtx.cartId === li.dataset.id && qtyPopCtx.asin === asin) {
      $qtyPopVal.textContent = String(qty);
    }
  }

  async function applyQuantity(li, asin, nextQty) {
    const id = li.dataset.id;
    const cart = cartCache.get(id);
    if (!cart) return;
    const item = (cart.items || []).find((it) => it.asin === asin);
    if (!item) return;
    const clamped = Math.max(1, Math.min(99, Math.round(nextQty) || 1));
    if (clamped === item.quantity) return;
    const prev = item.quantity;
    item.quantity = clamped;
    updateRowSummary(li, cart);
    updateQtyBadge(li, asin, clamped);
    const res = await send({ type: "MC_UPDATE_ITEM_QUANTITY", id, asin, quantity: clamped });
    if (!res.ok) {
      item.quantity = prev;
      updateRowSummary(li, cart);
      updateQtyBadge(li, asin, prev);
      if (!handleEntitlementError(res)) {
        toast(res.error || "Could not update quantity", "error");
      }
    }
  }

  async function removeItem(li, asin) {
    const id = li.dataset.id;
    const cart = cartCache.get(id);
    if (!cart) return;
    const item = (cart.items || []).find((it) => it.asin === asin);
    if (!item) return;
    const itemName = item.title || asin;
    // Removing the cart's last item deletes the cart itself — confirm that
    // case only. Ordinary removals are instant (per the X-on-a-tile model).
    const isLast = (cart.items || []).length <= 1;
    if (isLast) {
      const ok = await confirmDialog({
        title: "Remove last item?",
        emphasis: {
          before: "Removing ",
          text: itemName,
          after: " empties and deletes this cart.",
        },
        okLabel: "Remove & delete",
        destructive: true,
      });
      if (!ok) return;
    }
    closeQtyPop();
    const res = await send({ type: "MC_REMOVE_ITEM_FROM_CART", id, asin });
    if (!res.ok) {
      if (!handleEntitlementError(res)) {
        toast(res.error || "Could not remove item", "error");
      }
      return;
    }
    if (res.cartDeleted) {
      toast("Cart emptied — removing from list");
      await refresh();
      return;
    }
    cart.items = cart.items.filter((it) => it.asin !== asin);
    updateRowSummary(li, cart);
    renderCartThumbs(li.querySelector(".mc-item-thumbs"), cart);
  }

  // ---- Quantity popover --------------------------------------------------
  //
  // Clicking a tile's count badge opens a small −/+ popover anchored to it.
  // It stays open across clicks so the user can tap several times; an outside
  // click or Escape closes it.

  let qtyPopCtx = null; // { cartId, asin } while open

  function openQtyPop(anchorEl, cartId, asin) {
    const cart = cartCache.get(cartId);
    const item = cart && (cart.items || []).find((it) => it.asin === asin);
    if (!item) return;
    qtyPopCtx = { cartId, asin };
    $qtyPopVal.textContent = String(item.quantity || 1);

    // Reveal first so we can measure it, then anchor above the badge (or
    // below if there's no room up top).
    $qtyPop.hidden = false;
    $qtyPop.style.left = "0px";
    $qtyPop.style.top = "0px";
    const a = anchorEl.getBoundingClientRect();
    const p = $qtyPop.getBoundingClientRect();
    let left = a.left + a.width / 2 - p.width / 2;
    let top = a.top - p.height - 6;
    if (top < 4) top = a.bottom + 6;
    left = Math.max(4, Math.min(left, window.innerWidth - p.width - 4));
    $qtyPop.style.left = `${left}px`;
    $qtyPop.style.top = `${top}px`;
  }

  function closeQtyPop() {
    if (!qtyPopCtx && $qtyPop.hidden) return;
    $qtyPop.hidden = true;
    qtyPopCtx = null;
  }

  $qtyPop.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn || !qtyPopCtx) return;
    const { cartId, asin } = qtyPopCtx;
    const li = $list.querySelector(`li.mc-item[data-id="${CSS.escape(cartId)}"]`);
    const cart = cartCache.get(cartId);
    const item = cart && (cart.items || []).find((it) => it.asin === asin);
    if (!li || !item) return;
    const cur = item.quantity || 1;
    const next = btn.dataset.action === "qty-pop-inc" ? cur + 1 : cur - 1;
    applyQuantity(li, asin, next);
  });

  // Outside-click closes the popover. Capture phase so it settles before the
  // $list handler that may be (re)opening it from a badge click.
  document.addEventListener(
    "click",
    (e) => {
      if ($qtyPop.hidden) return;
      if ($qtyPop.contains(e.target)) return;
      // A click on a count badge re-opens/repositions; let that handler run.
      if (e.target.closest('[data-action="thumb-qty"]')) return;
      closeQtyPop();
    },
    true
  );

  // ---- Tile interactions (remove / quantity / move / expand) -------------

  $list.addEventListener("click", (e) => {
    // Combine mode swallows clicks on a row as selection toggles. We
    // intentionally ignore item controls while picking carts.
    if (combineState.active) {
      const li = e.target.closest("li.mc-item");
      if (!li) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      toggleCombineSelection(li.dataset.id);
      return;
    }

    const hit = e.target.closest(".mc-item-thumbs [data-action]");
    if (!hit) return;
    const li = hit.closest("li.mc-item");
    if (!li) return;
    const action = hit.dataset.action;

    if (action === "thumb-more") {
      const id = li.dataset.id;
      if (expandedThumbs.has(id)) expandedThumbs.delete(id);
      else expandedThumbs.add(id);
      const cart = cartCache.get(id);
      if (cart) renderCartThumbs(li.querySelector(".mc-item-thumbs"), cart);
      return;
    }

    const tile = hit.closest(".mc-thumb");
    const asin = tile ? tile.dataset.asin : hit.dataset.asin;
    if (action === "thumb-remove") {
      removeItem(li, asin);
    } else if (action === "thumb-qty") {
      openQtyPop(hit, li.dataset.id, asin);
    } else if (action === "thumb-move") {
      openMoveModal(li, asin);
    }
  });

  // Keyboard activation for the move tile (role="button"). Only the tile
  // itself activates — the inner X / quantity buttons handle their own keys.
  $list.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tile = e.target;
    if (!(tile.classList && tile.classList.contains("mc-thumb"))) return;
    if (tile.dataset.action !== "thumb-move") return;
    e.preventDefault();
    const li = tile.closest("li.mc-item");
    if (li) openMoveModal(li, tile.dataset.asin);
  });

  // Delegated handler for per-cart actions.
  $list.addEventListener("click", async (e) => {
    // Item-tile controls are handled by the dedicated listener above; skip
    // here so we don't double-fire on their data-action buttons.
    if (e.target.closest(".mc-item-thumbs")) return;
    const button = e.target.closest("button[data-action]");
    if (!button) return;
    const li = button.closest("li.mc-item");
    if (!li) return;
    const id = li.dataset.id;
    const action = button.dataset.action;

    // Read-only carts: clicking the upgrade pill opens the paywall in
    // renew mode. Same destination as the lapsed banner's Renew button.
    if (action === "lock-upgrade") {
      openPaywall("renew");
      return;
    }

    if (action === "restore") {
      const cartName =
        li.querySelector(".mc-item-name").textContent.trim() || "this";
      const ok = await confirmDialog({
        title: "Switch to this cart?",
        message: `This will replace your current Amazon cart with the contents of "${cartName}".`,
        okLabel: "Switch",
      });
      if (!ok) return;

      withLoading(button, async () => {
        const res = await send({ type: "MC_RESTORE_CART", id });
        if (res.ok) {
          const total = res.total || 0;
          toast(
            `Switching carts — loading ${total} item${total === 1 ? "" : "s"}. If Amazon shows an upsell, choose an option there to continue.`
          );
        } else if (!handleEntitlementError(res)) {
          toast(res.error || "Could not switch carts", "error");
        }
      });
    } else if (action === "rename") {
      const current = li.querySelector(".mc-item-name").textContent;
      const next = await promptDialog({
        title: "Rename cart",
        placeholder: "Cart name",
        initialValue: current,
        okLabel: "Rename",
      });
      if (next == null) return;
      if (next === current) return;
      withLoading(button, async () => {
        const res = await send({
          type: "MC_RENAME_CART",
          id,
          name: next,
        });
        if (res.ok) {
          await refresh();
        } else if (!handleEntitlementError(res)) {
          toast(res.error || "Could not rename", "error");
        }
      });
    } else if (action === "delete") {
      const current = li.querySelector(".mc-item-name").textContent;
      const ok = await confirmDialog({
        title: "Delete saved cart?",
        message: `"${current}" will be permanently removed.`,
        okLabel: "Delete",
        destructive: true,
      });
      if (!ok) return;
      withLoading(button, async () => {
        const res = await send({ type: "MC_DELETE_CART", id });
        if (res.ok) {
          toast("Deleted");
          await refresh();
        } else {
          toast(res.error || "Could not delete", "error");
        }
      });
    }
  });

  // ---- Combine bar / modal wiring ----------------------------------------

  $createNew.addEventListener("click", async () => {
    // If the user is mid-Merge selection, exit it first so the new cart
    // doesn't pop up wearing a checkbox.
    if (combineState.active) setCombineMode(false);

    const name = await promptDialog({
      title: "Create a new cart",
      placeholder: "e.g. Birthday gifts",
      okLabel: "Create",
    });
    if (name == null) return; // user cancelled
    withLoading($createNew, async () => {
      const res = await send({ type: "MC_CREATE_EMPTY_CART", name });
      if (res.ok) {
        toast(`Created "${name}".`);
        await refresh();
      } else if (!handleEntitlementError(res)) {
        toast(res.error || "Could not create cart.", "error");
      }
    });
  });

  $combineBtn.addEventListener("click", () => {
    setCombineMode(!combineState.active);
  });

  $combineCancel.addEventListener("click", () => {
    setCombineMode(false);
  });

  $combineContinue.addEventListener("click", () => {
    openCombineModal();
  });

  $combineModal.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "modal-cancel") {
      closeCombineModal();
      return;
    }
    if (action === "combine-go") {
      const direction = btn.dataset.direction;
      const idA = $combineModal.dataset.cartA;
      const idB = $combineModal.dataset.cartB;
      // "a-to-b" = source A goes INTO target B (A is consumed)
      const sourceId = direction === "a-to-b" ? idA : idB;
      const targetId = direction === "a-to-b" ? idB : idA;
      performCombine(sourceId, targetId);
    }
  });

  $moveModal.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "move-cancel") {
      closeMoveModal();
      return;
    }
    if (action === "move-create") {
      createMoveDestinationAndMove();
      return;
    }
    if (action === "move-go") {
      const sourceId = $moveModal.dataset.sourceId;
      const asin = $moveModal.dataset.asin;
      const targetId = btn.dataset.targetId;
      if (sourceId && targetId && asin) performMove(sourceId, targetId, asin);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$qtyPop.hidden) {
      closeQtyPop();
      return;
    }
    if (!$paywallModal.hidden) {
      closePaywall();
      return;
    }
    if (!$moveModal.hidden) {
      closeMoveModal();
      return;
    }
    if (!$combineModal.hidden) {
      closeCombineModal();
    }
  });

  // ---- Debug panel -------------------------------------------------------

  $diagnose.addEventListener("click", () => {
    $debugOutput.textContent = "Running diagnostics — navigating to cart page…";
    withLoading($diagnose, async () => {
      const res = await send({ type: "MC_DIAGNOSE_CART" });
      if (res.ok && res.report) {
        const r = res.report;
          const lines = [
            `URL: ${r.url}`,
            `sawCartSurface: ${r.sawCartSurface}`,
            `ewcPresent: ${r.ewcPresent}`,
            `ewcTotalQuantity: ${r.ewcTotalQuantity}`,
            `remainingCount: ${r.remainingCount}`,
            ``,
          `--- Scopes found (${r.scopesFound.length}) ---`,
          ...r.scopesFound.map(
            (s) => `  <${s.tag}> id="${s.id}" cls="${s.cls}" children=${s.children}`
          ),
          ``,
          `--- Active rows (${r.activeRowsFound}) ---`,
          ...r.rows.map(
            (row) =>
              `  ASIN=${row.asin} itemtype=${row.itemtype} cls="${row.cls}" SFL=${row.isSFL} deleted=${row.isDeleted}\n` +
              `    deleteFound=${row.deleteFound} ${formatDebugControl(row.delete)}`
          ),
          ``,
          `--- All data-asin elements on page (${r.allAsinRows.length}) ---`,
          ...r.allAsinRows.map(
            (row) =>
              `  ASIN=${row.asin} itemtype=${row.itemtype} inScopes=${row.inScopes} SFL=${row.isSFL} deleted=${row.isDeleted}`
          ),
        ];
        $debugOutput.textContent = lines.join("\n");
      } else {
        $debugOutput.textContent = `Error: ${(res && res.error) || "No response"}`;
      }
    });
  });

  // ---- Debug: entitlement controls --------------------------------------
  //
  // DEVELOPER-ONLY, and stripped from production builds. The preset buttons
  // below forge an entitlement straight into chrome.storage.local, which is a
  // premium bypass — so scripts/build-zip.sh deletes everything between the
  // debug-entitlement strip markers (here and in popup.html) when packaging
  // the Chrome Web Store zip. Keep all entitlement-mutating code inside those
  // markers. The dev unlock only hides this from normal users; it is NOT a
  // security boundary, since anyone can read the source.

  const DEV_FLAG_KEY = "mc.dev.v1";
  const ENT_KEY = "mc.entitlement.v1";

  /* MC_DEBUG_ENT_START */
  const DAY_MS = 86400000;

  function entPresets(now) {
    return {
      premium: {
        tier: "premium",
        premiumUntil: now + 365 * DAY_MS,
        autoRenew: true,
        source: "dev",
        lastChecked: now,
      },
      "premium-warn": {
        // Premium, 5 days from expiry, auto-renew off → triggers warning paths.
        tier: "premium",
        premiumUntil: now + 5 * DAY_MS,
        autoRenew: false,
        source: "dev",
        lastChecked: now,
      },
      lapsed: {
        // Was premium, expired yesterday → top-N editable, rest read-only.
        tier: "premium",
        premiumUntil: now - 1 * DAY_MS,
        autoRenew: false,
        source: "dev",
        lastChecked: now,
      },
      free: {
        tier: "free",
        premiumUntil: null,
        autoRenew: false,
        source: null,
        lastChecked: now,
      },
    };
  }
  /* MC_DEBUG_ENT_END */

  function formatEntForDisplay(ent) {
    if (!ent) return "(none)";
    const lifetime = ent.tier === "premium" && ent.premiumUntil == null;
    const until = lifetime
      ? "lifetime"
      : ent.premiumUntil
      ? new Date(ent.premiumUntil).toISOString().slice(0, 10)
      : "—";
    const now = Date.now();
    const expired = ent.premiumUntil != null && ent.premiumUntil < now;
    const status =
      ent.tier === "premium" && !expired
        ? "active"
        : ent.tier === "premium" && expired
        ? "LAPSED"
        : "free";
    return [
      `tier:        ${ent.tier || "free"} (${status})`,
      `premiumUntil:${until}`,
      `autoRenew:   ${ent.autoRenew ? "yes" : "no"}`,
      `source:      ${ent.source || "—"}`,
    ].join("\n");
  }

  async function refreshDebugEntDisplay() {
    if (!$debugEntState) return;
    try {
      const got = await chrome.storage.local.get(ENT_KEY);
      $debugEntState.textContent = formatEntForDisplay(got[ENT_KEY]);
    } catch (e) {
      $debugEntState.textContent = `error: ${e.message}`;
    }
  }

  async function setDebugPanelVisible(visible) {
    if (!$debugPanel) return;
    $debugPanel.hidden = !visible;
    if (visible) $debugPanel.open = true;
    devModeEnabled = !!visible;
    try {
      await chrome.storage.local.set({ [DEV_FLAG_KEY]: !!visible });
    } catch (_) {}
    if (visible) refreshDebugEntDisplay();
  }

  async function loadDebugPanelVisibility() {
    try {
      const got = await chrome.storage.local.get(DEV_FLAG_KEY);
      const on = got[DEV_FLAG_KEY] === true;
      devModeEnabled = on;
      if (on && $debugPanel) {
        $debugPanel.hidden = false;
        refreshDebugEntDisplay();
      }
    } catch (_) {}
  }

  // Ctrl+Alt+D toggles the debug panel + persists. (Chrome eats Cmd+Shift+D
  // on Mac for "Bookmark all tabs", so we avoid that combo.)
  // Production users never trigger this — gated on devModeEnabled, which is
  // only true if `mc.dev.v1` was already set in chrome.storage.local.
  document.addEventListener("keydown", (e) => {
    if (!devModeEnabled) return;
    const isToggle =
      (e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === "d";
    if (!isToggle) return;
    e.preventDefault();
    const isHidden = !$debugPanel || $debugPanel.hidden;
    setDebugPanelVisible(isHidden);
  });

  // Backup affordance: click the tagline 5 times within 2s to toggle.
  // Same dev-mode gate as the keyboard shortcut.
  (function attachTaglineUnlock() {
    const tagline = document.querySelector(".mc-tag");
    if (!tagline) return;
    let clicks = 0;
    let firstAt = 0;
    tagline.style.cursor = "default";
    tagline.addEventListener("click", () => {
      if (!devModeEnabled) return;
      const now = Date.now();
      if (now - firstAt > 2000) {
        clicks = 0;
        firstAt = now;
      }
      clicks += 1;
      if (clicks >= 5) {
        clicks = 0;
        const isHidden = !$debugPanel || $debugPanel.hidden;
        setDebugPanelVisible(isHidden);
        toast(isHidden ? "Debug menu on" : "Debug menu off", "ok");
      }
    });
  })();

  /* MC_DEBUG_ENT_START */
  // Button delegation inside the debug entitlement section. (Stripped from
  // production builds along with the buttons in popup.html.)
  if ($debugPanel) {
    $debugPanel.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-debug-ent]");
      if (!btn) return;
      const action = btn.dataset.debugEnt;
      const now = Date.now();
      if (action === "reset-dismiss") {
        try {
          await chrome.storage.local.remove(DISMISS_KEY);
          uiDismissed = { tierStrip: null, lapsedBanner: null };
          toast("Dismissed flags cleared", "ok");
          await refresh();
        } catch (err) {
          toast(`Reset failed: ${err.message}`, "error");
        }
        return;
      }
      const presets = entPresets(now);
      const next = presets[action];
      if (!next) return;
      try {
        await chrome.storage.local.set({ [ENT_KEY]: next });
        // Reset dismissed UI on entitlement state change so banners come back.
        uiDismissed = { tierStrip: null, lapsedBanner: null };
        await chrome.storage.local.set({
          [DISMISS_KEY]: uiDismissed,
        });
        await refreshDebugEntDisplay();
        await refresh();
        toast(`Entitlement → ${action}`, "ok");
      } catch (err) {
        toast(`Failed: ${err.message}`, "error");
      }
    });
  }
  /* MC_DEBUG_ENT_END */

  // Assemble a paste-able diagnostic report: extension version + state
  // snapshot + the cross-context log ring (SW, content scripts, popup). The
  // ring only fills while Developer mode is on, so the support flow is: turn on
  // Developer mode → reproduce the issue → click Copy diagnostic logs.
  async function buildDiagnosticReport() {
    const lines = [];
    let version = "";
    try { version = chrome.runtime.getManifest().version; } catch (_) {}
    lines.push("Styx Multi-Cart — diagnostic report");
    lines.push("Generated: " + new Date().toISOString());
    lines.push("Version: " + version);
    lines.push("Surface: " + (document.documentElement.dataset.surface || "popup"));
    lines.push("User agent: " + navigator.userAgent);
    try {
      const got = await chrome.storage.local.get([
        ENT_KEY,
        "mc.settings.v1",
        "mc.carts.v1",
        DEV_FLAG_KEY,
      ]);
      lines.push("Dev mode: " + (got[DEV_FLAG_KEY] === true));
      lines.push("Entitlement: " + JSON.stringify(got[ENT_KEY] || null));
      lines.push("Settings: " + JSON.stringify(got["mc.settings.v1"] || null));
      const carts = got["mc.carts.v1"];
      const list =
        carts && Array.isArray(carts.carts)
          ? carts.carts
          : Array.isArray(carts)
          ? carts
          : [];
      lines.push("Saved carts: " + list.length);
    } catch (e) {
      lines.push("State snapshot error: " + (e && e.message));
    }
    let entries = [];
    try {
      const resp = await chrome.runtime.sendMessage({ type: "MC_LOG_GET" });
      if (resp && Array.isArray(resp.entries)) entries = resp.entries;
    } catch (e) {
      lines.push("Log fetch error: " + (e && e.message));
    }
    lines.push("");
    lines.push(`--- logs (${entries.length}) ---`);
    for (const en of entries) {
      let t = "";
      try { t = new Date(en.ts).toISOString().slice(11, 23); } catch (_) {}
      lines.push(`${t} [${en.ctx}/${en.level}] ${en.msg}`);
    }
    if (!entries.length) {
      lines.push(
        "(no logs captured yet — keep Developer mode on, reproduce the issue, then copy again)"
      );
    }
    return lines.join("\n");
  }

  if ($copyLogs) {
    $copyLogs.addEventListener("click", async () => {
      try {
        const report = await buildDiagnosticReport();
        await navigator.clipboard.writeText(report);
        toast("Diagnostic logs copied", "ok");
      } catch (e) {
        toast("Copy failed: " + (e && e.message), "error");
      }
    });
  }

  // Keep display in sync if entitlement is mutated externally (e.g. SW console).
  if (chrome.storage && chrome.storage.onChanged) {
    let cartsRefreshTimer = null;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes["mc.carts.v1"]) {
        clearTimeout(cartsRefreshTimer);
        cartsRefreshTimer = setTimeout(() => {
          refresh();
        }, 50);
      }
      if (changes[ENT_KEY] && $debugPanel && !$debugPanel.hidden) {
        refreshDebugEntDisplay();
      }
    });
  }

  function formatDebugControl(control) {
    if (!control) return "";
    return (
      `tag=${control.tag} name=${control.name} value=${control.value} ` +
      `label=${control.label} action=${control.action} selector=${control.selector} ` +
      `disabled=${control.disabled}\n` +
      `    html=${control.html}`
    );
  }

  // Submit name on Enter.
  $name.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $save.click();
    }
  });

  // ---- Paywall modal -----------------------------------------------------
  //
  // Two open triggers:
  //   - "limit"   → gate refused a save (FREE_LIMIT_REACHED)
  //   - "cta"     → user clicked an Upgrade button
  //   - "renew"   → user clicked the Renew button on the lapsed banner
  // Different trigger → different headline copy. The plan card itself is
  // identical across triggers.
  //
  // Phase 3 will replace the stub with an ExtensionPay.openPaymentPage() call.

  function openPaywall(trigger) {
    if (trigger === "limit") {
      $paywallTitle.textContent = "You've used both free carts";
      $paywallSub.textContent =
        "Upgrade to Premium to save more — your existing carts stay exactly as they are.";
    } else if (trigger === "renew") {
      $paywallTitle.textContent = "Welcome back";
      $paywallSub.textContent =
        "Renew Premium to unlock your read-only carts. Everything you saved is still here, waiting.";
    } else {
      $paywallTitle.textContent = "Upgrade to Premium";
      $paywallSub.textContent =
        "Save more of how you actually shop — gift lists, restocks, occasions, side-by-side comparisons.";
    }
    // ExtensionPay is wired; each plan button deep-links its own checkout.
    $paywallStub.hidden = true;
    resetPaywallButtons();

    $paywallModal.hidden = false;
    $paywallModal.removeAttribute("inert");
    // Move focus to the close button so screen readers announce the modal.
    const closeBtn = $paywallModal.querySelector('[data-action="paywall-close"]');
    if (closeBtn) closeBtn.focus();
  }

  function closePaywall() {
    const active = document.activeElement;
    if (active && $paywallModal.contains(active)) active.blur();
    $paywallModal.setAttribute("inert", "");
    $paywallModal.hidden = true;
  }

  // Both plan buttons share one paywall handler; the chosen plan is read from
  // each button's data-plan ("annual" | "lifetime") and deep-links that plan's
  // ExtPay checkout. Cache the button refs + their original label markup so we
  // can show a per-button "Opening…" state and restore it on error.
  const $paywallPlanBtns = Array.from(
    $paywallModal.querySelectorAll(".mc-paywall-plan-btn"),
  );
  const paywallBtnOriginalHtml = new Map(
    $paywallPlanBtns.map((b) => [b, b.innerHTML]),
  );

  function resetPaywallButtons() {
    for (const b of $paywallPlanBtns) {
      b.disabled = false;
      b.innerHTML = paywallBtnOriginalHtml.get(b);
    }
  }

  $paywallModal.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "paywall-close") {
      closePaywall();
    } else if (action === "paywall-upgrade") {
      // Open the ExtensionPay-hosted Stripe checkout for the chosen plan in a
      // new tab. The popup closes by Chrome anyway when focus moves; we also
      // call closePaywall so reopening later starts fresh. extpay.onPaid fires
      // in background.js when the user completes checkout and refreshes the
      // entitlement automatically. Disable BOTH buttons during the call so a
      // double-tap can't open two checkout tabs.
      const plan = btn.dataset.plan || null;
      for (const b of $paywallPlanBtns) b.disabled = true;
      btn.textContent = "Opening checkout…";
      const res = await send({ type: "MC_OPEN_PAYMENT_PAGE", plan });
      if (!res || !res.ok) {
        resetPaywallButtons();
        toast((res && res.error) || "Couldn't open checkout.", "err");
        return;
      }
      closePaywall();
      resetPaywallButtons();
    }
  });

  // ---- Promo code redemption (inside the paywall modal) -------------------
  // Friends-and-family / trial path that grants 90 days of Premium without
  // payment. See background.js → redeemPromoCode for the validation logic;
  // shipped bundle only contains SHA-256 hashes of valid codes.
  const $promoForm = document.getElementById("mc-promo-form");
  const $promoInput = document.getElementById("mc-promo-input");
  const $promoSubmit = document.getElementById("mc-promo-submit");
  const $promoMsg = document.getElementById("mc-promo-msg");

  function setPromoMsg(text, kind) {
    if (!$promoMsg) return;
    $promoMsg.textContent = text || "";
    $promoMsg.classList.toggle("is-ok", kind === "ok");
    $promoMsg.classList.toggle("is-err", kind === "err");
  }

  if ($promoForm) {
    $promoForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = ($promoInput.value || "").trim();
      if (!code) {
        setPromoMsg("Enter a code.", "err");
        return;
      }
      $promoSubmit.disabled = true;
      setPromoMsg("Checking…");
      const res = await send({ type: "MC_REDEEM_PROMO", code });
      $promoSubmit.disabled = false;
      if (!res || !res.ok) {
        setPromoMsg(
          (res && res.error) || "Something went wrong. Try again.",
          "err",
        );
        return;
      }
      // Success — clear the field, surface a toast, refresh entitlement-driven
      // UI, and close the paywall after a beat so the user reads the message.
      $promoInput.value = "";
      setPromoMsg("Premium unlocked for 90 days!", "ok");
      toast("Premium unlocked — enjoy!", "ok");
      try {
        await refresh();
      } catch (_) {}
      setTimeout(() => {
        closePaywall();
        setPromoMsg("");
      }, 1200);
    });
  }

  $tierUpgrade.addEventListener("click", () => openPaywall("cta"));
  $lapsedRenew.addEventListener("click", () => openPaywall("renew"));

  // ---- Settings modal ------------------------------------------------------
  // Gear icon in the header opens this. Developer mode is intentionally hidden
  // from normal users; typing the unlock code while Settings is open reveals
  // the switch. setDebugPanelVisible() handles the storage side-effects.
  const $settingsToggle = document.getElementById("mc-settings-toggle");
  const $settingsModal = document.getElementById("mc-settings-modal");
  const $settingsDevSection = document.getElementById("mc-settings-dev-section");
  const $devModeToggle = document.getElementById("mc-devmode-toggle");
  const $settingsVersion = document.getElementById("mc-settings-version");
  const DEV_UNLOCK_CODE = "STYXDEV";
  let settingsUnlockBuffer = "";

  function setSettingsDevSectionVisible(visible) {
    if (!$settingsDevSection) return;
    $settingsDevSection.hidden = !visible;
  }

  function openSettings() {
    if (!$settingsModal) return;
    // Reflect current state in case it was changed elsewhere (Ctrl+Alt+D,
    // tagline unlock, another popup instance).
    if ($devModeToggle) $devModeToggle.checked = !!devModeEnabled;
    setSettingsDevSectionVisible(devModeEnabled);
    settingsUnlockBuffer = "";
    // Populate version from manifest.
    if ($settingsVersion) {
      try {
        const v = chrome.runtime.getManifest().version;
        $settingsVersion.textContent = `Styx Multi-Cart v${v}`;
      } catch (_) {
        $settingsVersion.textContent = "";
      }
    }
    $settingsModal.hidden = false;
    $settingsModal.removeAttribute("inert");
    const closeBtn = $settingsModal.querySelector('[data-action="settings-close"]');
    if (closeBtn) closeBtn.focus();
  }

  function closeSettings() {
    if (!$settingsModal) return;
    const active = document.activeElement;
    if (active && $settingsModal.contains(active)) active.blur();
    $settingsModal.setAttribute("inert", "");
    $settingsModal.hidden = true;
    if (!devModeEnabled) setSettingsDevSectionVisible(false);
    settingsUnlockBuffer = "";
  }

  if ($settingsToggle) {
    $settingsToggle.addEventListener("click", openSettings);
  }

  if ($settingsModal) {
    $settingsModal.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      if (btn.dataset.action === "settings-close") closeSettings();
    });
  }

  if ($devModeToggle) {
    $devModeToggle.addEventListener("change", async () => {
      const want = !!$devModeToggle.checked;
      await setDebugPanelVisible(want);
      setSettingsDevSectionVisible(want);
      // The toast confirms the side-effect since the debug panel itself is
      // below the fold of a 600px popup and easy to miss appearing.
      toast(want ? "Developer mode on" : "Developer mode off", "ok");
    });
  }

  // Close on Escape, matching the rest of the modal patterns in the popup.
  // While Settings is open, typing STYXDEV reveals the Developer switch.
  document.addEventListener("keydown", (e) => {
    const settingsOpen = $settingsModal && !$settingsModal.hidden;
    if (e.key === "Escape") {
      if (settingsOpen) closeSettings();
      return;
    }
    if (!settingsOpen || devModeEnabled) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (typeof e.key !== "string" || e.key.length !== 1) return;
    const ch = e.key.toUpperCase();
    if (!/^[A-Z0-9]$/.test(ch)) return;
    settingsUnlockBuffer = (settingsUnlockBuffer + ch).slice(-DEV_UNLOCK_CODE.length);
    if (settingsUnlockBuffer === DEV_UNLOCK_CODE) {
      setSettingsDevSectionVisible(true);
      if ($devModeToggle) $devModeToggle.focus();
      toast("Developer options unlocked", "ok");
    }
  });

  // ---- Dismissal persistence -----------------------------------------------

  async function loadDismissed() {
    const result = await chrome.storage.local.get(DISMISS_KEY);
    const stored = result[DISMISS_KEY];
    if (stored && typeof stored === "object") {
      // Migrate legacy boolean shape → timestamp shape on read.
      const migrated = { tierStrip: null, lapsedBanner: null };
      const now = Date.now();
      for (const k of ["tierStrip", "lapsedBanner"]) {
        const v = stored[k];
        if (typeof v === "number") migrated[k] = v;
        else if (v === true) migrated[k] = now;
        else migrated[k] = null;
      }
      uiDismissed = migrated;
    }
  }

  async function snoozeDismissal(key) {
    uiDismissed[key] = Date.now();
    await chrome.storage.local.set({ [DISMISS_KEY]: uiDismissed });
  }

  // Belt-and-suspenders dismiss handling. We bind:
  //  (a) direct listeners on each × button at script-load time, AND
  //  (b) a delegated handler on document (in case the strip/banner is
  //      re-rendered by some future code path that swaps the node).
  // The dismiss function is idempotent — running both is harmless.
  async function dismissSurface(which) {
    if (which === "tierStrip") $tierStrip.hidden = true;
    if (which === "lapsedBanner") $lapsedBanner.hidden = true;
    await snoozeDismissal(which);
  }

  function bindDirectDismiss() {
    const tierBtn = $tierStrip.querySelector(
      "[data-action='dismiss-tier-strip']"
    );
    const lapsedBtn = $lapsedBanner.querySelector(
      "[data-action='dismiss-lapsed-banner']"
    );
    if (tierBtn) {
      tierBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dismissSurface("tierStrip");
      });
    }
    if (lapsedBtn) {
      lapsedBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dismissSurface("lapsedBanner");
      });
    }
  }
  bindDirectDismiss();

  // Delegated fallback: catches clicks even if the original × button was
  // somehow detached and re-inserted (e.g. a future innerHTML swap).
  document.addEventListener("click", (e) => {
    const tierX = e.target.closest("[data-action='dismiss-tier-strip']");
    if (tierX) {
      e.preventDefault();
      e.stopPropagation();
      dismissSurface("tierStrip");
      return;
    }
    const lapsedX = e.target.closest("[data-action='dismiss-lapsed-banner']");
    if (lapsedX) {
      e.preventDefault();
      e.stopPropagation();
      dismissSurface("lapsedBanner");
    }
  });

  /**
   * Centralized handler for the gate response codes returned by background.
   * Returns true if a paywall / locked-cart treatment was applied (so the
   * caller knows it doesn't need to fall back to a generic toast).
   */
  function handleEntitlementError(res) {
    if (!res || res.ok) return false;
    if (res.code === "FREE_LIMIT_REACHED") {
      openPaywall("limit");
      return true;
    }
    if (res.code === "PREMIUM_LIMIT_REACHED") {
      toast(
        res.error ||
          `You've reached the 20-cart limit. Delete or merge carts to free up space.`,
        "error"
      );
      return true;
    }
    if (res.code === "CART_LOCKED") {
      toast(
        res.error ||
          "This cart is locked — renew Premium or delete others to free a slot.",
        "error"
      );
      return true;
    }
    return false;
  }

  // ---- Boot --------------------------------------------------------------

  async function boot() {
    loadThemeSetting();
    await loadDismissed();
    loadDebugPanelVisibility();
    refresh();
    loadInterceptSetting();
    // Fire-and-forget: ask the background to re-sync entitlement from
    // ExtensionPay. If the user just returned from a successful checkout,
    // the onPaid listener has usually already updated storage before we
    // got here, but this catches edge cases (slow network, tab closed
    // mid-callback). When it returns, re-render entitlement-driven UI.
    send({ type: "MC_REFRESH_ENTITLEMENT" }).then((res) => {
      if (res && res.ok) refresh();
    });
  }

  document.addEventListener("DOMContentLoaded", boot);
  // In case the popup script runs after DOMContentLoaded already fired:
  if (document.readyState !== "loading") {
    boot();
  }
})();
