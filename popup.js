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
  const $newCart = document.getElementById("mc-new-cart");
  const $saveAndClear = document.getElementById("mc-save-and-clear");
  const $clear = document.getElementById("mc-clear");
  const $list = document.getElementById("mc-list");
  const $count = document.getElementById("mc-list-count");
  const $empty = document.getElementById("mc-empty");
  const $toast = document.getElementById("mc-toast");
  const $template = document.getElementById("mc-item-template");

  // ---- Messaging ---------------------------------------------------------

  /** Wraps chrome.runtime.sendMessage with a Promise + nicer error shape. */
  function send(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
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
      // Some saved items (especially from older saves before the lazy-load
      // fix) won't have a usable image URL. Skip those rather than render
      // a permanent spinner.
      if (!it.image || it.image.startsWith("data:")) continue;
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
        toast(`Saved ${res.saved}, cleared ${res.removed}`);
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
        "Remove all items from your Amazon cart? This will delete them from your active cart on Amazon."
      )
    ) {
      return;
    }
    withLoading($clear, async () => {
      const res = await send({ type: "MC_CLEAR_CURRENT" });
      if (res.ok) {
        toast(`Cleared ${res.removed} item${res.removed === 1 ? "" : "s"}`);
      } else {
        toast(res.error || "Could not clear cart", "error");
      }
    });
  });

  // "New cart": confirm → clear active Amazon cart → focus the name input
  // so the user can title the next cart, or just go shop.
  $newCart.addEventListener("click", () => {
    if (!confirm("Are you sure you want to clear out the Amazon Cart?")) {
      return;
    }
    withLoading($newCart, async () => {
      const res = await send({ type: "MC_CLEAR_CURRENT" });
      if (res.ok) {
        const word = res.removed === 1 ? "item" : "items";
        toast(
          res.removed > 0
            ? `Cleared ${res.removed} ${word}. Name your new cart, or just keep shopping.`
            : "Cart was already empty. Name your new cart, or just keep shopping."
        );
        $name.value = "";
        $name.focus();
      } else {
        toast(res.error || "Could not start a new cart", "error");
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
      withLoading(button, async () => {
        const res = await send({ type: "MC_RESTORE_CART", id });
        if (res.ok) {
          const total = res.total || 0;
          toast(
            `Restoring ${total} item${total === 1 ? "" : "s"} — give it ~${Math.max(1, Math.round((total * 4) / 60))} min. Your cart will open when done.`
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

  // Submit name on Enter.
  $name.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $save.click();
    }
  });

  // ---- Boot --------------------------------------------------------------

  document.addEventListener("DOMContentLoaded", refresh);
  // In case the popup script runs after DOMContentLoaded already fired:
  if (document.readyState !== "loading") refresh();
})();
