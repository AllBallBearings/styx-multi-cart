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
  const $modeQuick = document.getElementById("mc-mode-quick");
  const $modeReliable = document.getElementById("mc-mode-reliable");

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

  function renderItem(cart) {
    const node = $template.content.firstElementChild.cloneNode(true);
    node.dataset.id = cart.id;

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
      if (!it.image || it.image.startsWith("data:") || it.image.includes("loadIndicators") || it.image.includes("transparent-pixel")) continue;
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
    $list.innerHTML = "";
    $count.textContent = String(carts.length);
    $empty.hidden = carts.length > 0;
    carts.forEach((cart) => $list.appendChild(renderItem(cart)));
  }

  async function refresh() {
    const res = await send({ type: "MC_LIST_CARTS" });
    if (res.ok) render(res.carts || []);
  }

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

  // Delegated handler for per-cart actions.
  $list.addEventListener("click", (e) => {
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

  // ---- Restore mode toggle -----------------------------------------------

  function paintRestoreMode(mode) {
    const m = mode === "reliable" ? "reliable" : "quick";
    $modeQuick.setAttribute("aria-pressed", String(m === "quick"));
    $modeReliable.setAttribute("aria-pressed", String(m === "reliable"));
  }

  async function loadRestoreMode() {
    const res = await send({ type: "MC_GET_RESTORE_MODE" });
    paintRestoreMode((res && res.mode) || "quick");
  }

  async function setRestoreMode(mode) {
    paintRestoreMode(mode);
    await send({ type: "MC_SET_RESTORE_MODE", mode });
  }

  $modeQuick.addEventListener("click", () => setRestoreMode("quick"));
  $modeReliable.addEventListener("click", () => setRestoreMode("reliable"));

  // ---- Boot --------------------------------------------------------------

  document.addEventListener("DOMContentLoaded", () => {
    refresh();
    loadRestoreMode();
  });
  // In case the popup script runs after DOMContentLoaded already fired:
  if (document.readyState !== "loading") {
    refresh();
    loadRestoreMode();
  }
})();
