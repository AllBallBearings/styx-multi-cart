/* Click-to-enlarge previews for the marketing-page screenshots. */
(function () {
  "use strict";

  const dialog = document.getElementById("image-lightbox");
  const image = document.getElementById("image-lightbox-image");
  const closeButton = dialog && dialog.querySelector(".image-lightbox-close");
  const triggers = document.querySelectorAll("[data-lightbox-src]");
  if (!dialog || !image || !closeButton || !triggers.length) return;

  let lastTrigger = null;

  function closePreview() {
    if (dialog.open && typeof dialog.close === "function") {
      dialog.close();
    } else {
      dialog.removeAttribute("open");
    }
  }

  function openPreview(trigger) {
    const src = trigger.getAttribute("data-lightbox-src");
    if (!src) return;
    lastTrigger = trigger;
    image.src = src;
    image.alt = trigger.getAttribute("data-lightbox-alt") || "";

    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
    closeButton.focus();
  }

  triggers.forEach((trigger) => {
    trigger.addEventListener("click", () => openPreview(trigger));
  });

  closeButton.addEventListener("click", closePreview);

  // Clicking the dimmed area outside the preview closes it; clicking the
  // screenshot itself does not.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closePreview();
  });

  dialog.addEventListener("close", () => {
    image.removeAttribute("src");
    if (lastTrigger) {
      const trigger = lastTrigger;
      lastTrigger = null;
      window.requestAnimationFrame(() => trigger.focus());
    }
  });
})();
