/**
 * popup.js — drives the extension popup.
 *
 * All real work happens in the background service worker;
 * this file just renders state and forwards button clicks.
 */

(function () {
  "use strict";

  // ---- DOM refs ----------------------------------------------------------

  const $name = document.getElementById("mc-name");
  const $save = document.getElementById("mc-save");
  const $saveAndClear = document.getElementById("mc-save-and-clear");
  const $clear = document.getElementById("mc-clear");
  const $list = document.getElementById("mc-list");
  const $count = document.getElementById("mc-list-count");
  const $empty = document.getElementById("mc-empty");
  const $toast = document.getElementById("mc-toast");
  const $template = document.getElementById("mc-item-template");
  const $diagnose = document.getElementById("mc-diagnose");
  const $debugOutput = document.getElementById("mc-debug-output");
  const $combineBtn = document.getElementById("mc-combine");
  const $combineBar = document.getElementById("mc-combine-bar");
  const $combineStatus = document.getElementById("mc-combine-status");
  const $combineContinue = document.getElementById("mc-combine-continue");
  const $combineCancel = document.getElementById("mc-combine-cancel");
  const $combineModal = document.getElementById("mc-combine-modal");
  const $interceptToggle = document.getElementById("mc-intercept-toggle");
  const $createNew = document.getElementById("mc-create-new");
  const $themeToggle = document.getElementById("mc-theme-toggle");

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

  function renderItem(cart) {
    const node = $template.content.firstElementChild.cloneNode(true);
    node.dataset.id = cart.id;

    if (combineState.active) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "mc-select-checkbox";
      cb.setAttribute("aria-label", `Select cart "${cart.name}" to combine`);
      cb.checked = combineState.selected.includes(cart.id);
      node.classList.toggle("mc-item-selected", cb.checked);
      node.prepend(cb);
    }

    node.querySelector(".mc-item-name").textContent = cart.name;

    const totalQty = (cart.items || []).reduce(
      (n, it) => n + (it.quantity || 1),
      0
    );
    const itemWord = cart.items.length === 1 ? "item" : "items";
    node.querySelector(".mc-item-count").textContent =
      `${cart.items.length} ${itemWord} · ${totalQty} qty`;

    const host = (cart.host || "").replace(/^www\./, "");
    node.querySelector(".mc-item-meta").textContent =
      `${host} · saved ${formatRelative(cart.savedAt)}`;

    const thumbs = node.querySelector(".mc-item-thumbs");
    const showCount = Math.min(6, cart.items.length);
    for (let i = 0; i < showCount; i++) {
      const it = cart.items[i];
      if (!it) continue;
      // Skip bad image URLs: empty, data: placeholders, or Amazon's own
      // lazy-load spinner gif (loadIndicators) that gets captured before
      // IntersectionObserver has fired the real product image into place.
      if (!isUsableThumb(it.image)) continue;
      const img = document.createElement("img");
      img.className = "mc-item-thumb";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.src = it.image;
      img.alt = "";
      img.title = it.title || "";
      // If Amazon's CDN refuses the URL or it 404s, drop the element so
      // the placeholder doesn't sit there forever.
      img.onerror = () => img.remove();
      thumbs.appendChild(img);
    }
    if (cart.items.length > showCount) {
      const more = document.createElement("div");
      more.className = "mc-item-thumb-more";
      more.textContent = `+${cart.items.length - showCount}`;
      thumbs.appendChild(more);
    }

    return node;
  }

  function render(carts) {
    cartCache.clear();
    carts.forEach((c) => cartCache.set(c.id, c));
    $list.innerHTML = "";
    $count.textContent = String(carts.length);
    $empty.hidden = carts.length > 0;
    carts.forEach((cart) => $list.appendChild(renderItem(cart)));
  }

  // ---- Edit panel --------------------------------------------------------

  const $editRowTemplate = document.getElementById("mc-edit-row-template");

  function renderEditPanel(li, cart) {
    const panel = li.querySelector(".mc-item-edit");
    const list = panel.querySelector(".mc-edit-list");
    list.innerHTML = "";
    (cart.items || []).forEach((item) => {
      const row = $editRowTemplate.content.firstElementChild.cloneNode(true);
      row.dataset.asin = item.asin || "";

      const img = row.querySelector(".mc-edit-thumb");
      if (isUsableThumb(item.image)) {
        img.src = item.image;
        img.onerror = () => { img.style.visibility = "hidden"; };
      } else {
        img.style.visibility = "hidden";
      }

      row.querySelector(".mc-edit-title").textContent = item.title || "(untitled)";
      row.querySelector(".mc-edit-asin").textContent = item.asin || "";
      row.querySelector(".mc-qty-input").value = String(item.quantity || 1);

      list.appendChild(row);
    });
  }

  function setEditOpen(li, open) {
    const panel = li.querySelector(".mc-item-edit");
    const btn = li.querySelector('button[data-action="edit"]');
    panel.hidden = !open;
    li.classList.toggle("mc-item-editing", open);
    if (btn) {
      btn.textContent = open ? "Done" : "Edit";
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    }
  }

  function updateRowSummary(li, cart) {
    const totalQty = (cart.items || []).reduce((n, it) => n + (it.quantity || 1), 0);
    const itemWord = cart.items.length === 1 ? "item" : "items";
    li.querySelector(".mc-item-count").textContent =
      `${cart.items.length} ${itemWord} · ${totalQty} qty`;
  }

  async function refresh() {
    const res = await send({ type: "MC_LIST_CARTS" });
    if (res.ok) render(res.carts || []);
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
      } else {
        toast(res.error || "Could not save cart", "error");
      }
    });
  });

  $saveAndClear.addEventListener("click", () => {
    const name = ($name.value || "").trim() || defaultName();
    if (
      !confirm(
        `Save the current Amazon cart as "${name}" and then remove all items from it?`
      )
    ) {
      return;
    }
    withLoading($saveAndClear, async () => {
      const res = await send({ type: "MC_SAVE_AND_CLEAR", name });
      if (res.ok) {
        toast(`Saved ${res.saved} item${res.saved === 1 ? "" : "s"} — clearing cart in background.`);
        $name.value = "";
        await refresh();
      } else {
        toast(res.error || "Could not save & clear", "error");
      }
    });
  });

  $clear.addEventListener("click", () => {
    if (
      !confirm(
        "Are you sure you want to clear your current Amazon cart?"
      )
    ) {
      return;
    }
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
    const norm = (h) => (h || "").toLowerCase().replace(/^www\./, "");
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
      toast(res.error || "Could not combine carts.", "error");
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

  // ---- Delegated handlers for the edit panel -----------------------------

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
    const input = li.querySelector(`.mc-edit-row[data-asin="${CSS.escape(asin)}"] .mc-qty-input`);
    if (input) input.value = String(clamped);
    const res = await send({ type: "MC_UPDATE_ITEM_QUANTITY", id, asin, quantity: clamped });
    if (!res.ok) {
      item.quantity = prev;
      updateRowSummary(li, cart);
      if (input) input.value = String(prev);
      toast(res.error || "Could not update quantity", "error");
    }
  }

  async function removeItem(li, asin) {
    const id = li.dataset.id;
    const cart = cartCache.get(id);
    if (!cart) return;
    const item = (cart.items || []).find((it) => it.asin === asin);
    if (!item) return;
    if (!confirm(`Remove "${item.title || asin}" from this cart?`)) return;
    const res = await send({ type: "MC_REMOVE_ITEM_FROM_CART", id, asin });
    if (!res.ok) {
      toast(res.error || "Could not remove item", "error");
      return;
    }
    if (res.cartDeleted) {
      toast("Cart emptied — removing from list");
      await refresh();
      return;
    }
    cart.items = cart.items.filter((it) => it.asin !== asin);
    updateRowSummary(li, cart);
    renderEditPanel(li, cart);
  }

  $list.addEventListener("click", (e) => {
    // Combine mode swallows clicks on a row as selection toggles. We
    // intentionally ignore the action buttons (restore/edit/etc) while
    // in this mode — the user is picking carts, not operating on them.
    if (combineState.active) {
      const li = e.target.closest("li.mc-item");
      if (!li) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      toggleCombineSelection(li.dataset.id);
      return;
    }

    const editBtn = e.target.closest(".mc-item-edit button[data-action]");
    if (editBtn) {
      const li = editBtn.closest("li.mc-item");
      const row = editBtn.closest(".mc-edit-row");
      if (!li || !row) return;
      const asin = row.dataset.asin;
      const action = editBtn.dataset.action;
      if (action === "qty-inc" || action === "qty-dec") {
        const input = row.querySelector(".mc-qty-input");
        const current = Number(input.value) || 1;
        applyQuantity(li, asin, action === "qty-inc" ? current + 1 : current - 1);
      } else if (action === "item-remove") {
        removeItem(li, asin);
      }
      return;
    }
  });

  $list.addEventListener("change", (e) => {
    const input = e.target.closest(".mc-edit-row .mc-qty-input");
    if (!input) return;
    const li = input.closest("li.mc-item");
    const row = input.closest(".mc-edit-row");
    if (!li || !row) return;
    applyQuantity(li, row.dataset.asin, Number(input.value));
  });

  // Delegated handler for per-cart actions.
  $list.addEventListener("click", (e) => {
    // Edit-panel buttons handled by the dedicated listener above; skip here
    // so we don't double-fire.
    if (e.target.closest(".mc-item-edit")) return;
    const button = e.target.closest("button[data-action]");
    if (!button) return;
    const li = button.closest("li.mc-item");
    if (!li) return;
    const id = li.dataset.id;
    const action = button.dataset.action;

    if (action === "restore") {
      const cartName =
        li.querySelector(".mc-item-name").textContent.trim() || "this";
      if (
        !confirm(
          `Are you sure want to clear your current Amazon cart and restore the items from ${cartName} cart?`
        )
      ) {
        return;
      }

      withLoading(button, async () => {
        const res = await send({ type: "MC_RESTORE_CART", id });
        if (res.ok) {
          const total = res.total || 0;
          toast(
            `Clearing current cart, then restoring ${total} item${total === 1 ? "" : "s"}. If Amazon shows an upsell, choose an option there to continue.`
          );
        } else {
          toast(res.error || "Could not restore", "error");
        }
      });
    } else if (action === "rename") {
      const current = li.querySelector(".mc-item-name").textContent;
      const next = prompt("Rename cart:", current);
      if (next == null) return;
      const trimmed = next.trim();
      if (!trimmed || trimmed === current) return;
      withLoading(button, async () => {
        const res = await send({
          type: "MC_RENAME_CART",
          id,
          name: trimmed,
        });
        if (res.ok) {
          await refresh();
        } else {
          toast(res.error || "Could not rename", "error");
        }
      });
    } else if (action === "edit") {
      const cart = cartCache.get(id);
      if (!cart) return;
      const panel = li.querySelector(".mc-item-edit");
      const willOpen = panel.hidden;
      if (willOpen) renderEditPanel(li, cart);
      setEditOpen(li, willOpen);
    } else if (action === "delete") {
      const current = li.querySelector(".mc-item-name").textContent;
      if (!confirm(`Delete saved cart "${current}"?`)) return;
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

  $createNew.addEventListener("click", () => {
    // If the user is mid-Merge selection, exit it first so the new cart
    // doesn't pop up wearing a checkbox.
    if (combineState.active) setCombineMode(false);

    const name = prompt("Name for the new cart:");
    if (name == null) return; // user cancelled the prompt
    const trimmed = name.trim();
    if (!trimmed) {
      toast("Name cannot be empty.", "error");
      return;
    }
    withLoading($createNew, async () => {
      const res = await send({ type: "MC_CREATE_EMPTY_CART", name: trimmed });
      if (res.ok) {
        toast(`Created "${trimmed}".`);
        await refresh();
      } else {
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

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$combineModal.hidden) {
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

  // ---- Boot --------------------------------------------------------------

  document.addEventListener("DOMContentLoaded", () => {
    loadThemeSetting();
    refresh();
    loadInterceptSetting();
  });
  // In case the popup script runs after DOMContentLoaded already fired:
  if (document.readyState !== "loading") {
    loadThemeSetting();
    refresh();
    loadInterceptSetting();
  }
})();
