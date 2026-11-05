/* Copy button for the note shown to phone visitors. */
(function () {
  "use strict";

  const button = document.getElementById("copy-link");
  const status = document.getElementById("copy-link-status");
  if (!button || !status) return;

  const url = "https://allballbearings.github.io/styx-multi-cart/";

  button.addEventListener("click", async function () {
    try {
      await navigator.clipboard.writeText(url);
      button.textContent = "Copied";
    } catch (err) {
      // In-app browsers can block clipboard access, so the address stays selectable.
      status.textContent = "Press and hold to copy: " + url;
    }
  });
})();
