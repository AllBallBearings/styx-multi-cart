/**
 * status.js — drives the live operation status window.
 *
 * Polls background.js for the current operation state every 350 ms and
 * renders it with a cycling "..." animation. Closes itself 3.5 s after
 * the background reports the operation is done.
 */

(function () {
  "use strict";

  const $titleText = document.getElementById("sc-title-text");
  const $dots      = document.getElementById("sc-dots");
  const $detail    = document.getElementById("sc-detail");

  // ---- Blinking dots -------------------------------------------------------
  // Cycles independently of the poll loop so it never pauses even when
  // poll responses are slow.

  let dotCount = 0;
  const dotTimer = setInterval(() => {
    dotCount = (dotCount + 1) % 4;
    $dots.textContent = ".".repeat(dotCount);
  }, 350);

  // ---- Poll loop -----------------------------------------------------------

  let lastTitle  = "";
  let lastDetail = "";
  let isDone     = false;

  function applyStatus(res) {
    if (!res || !res.active) {
      // Operation finished — show done state then close.
      isDone = true;
      clearInterval(dotTimer);
      $dots.textContent = "";

      const doneTitle = (res && res.title) || "Done";
      if (doneTitle !== lastTitle) {
        $titleText.textContent = doneTitle;
        lastTitle = doneTitle;
      }
      $detail.textContent = (res && res.detail) || "";

      document.body.classList.add("sc-is-done");
      setTimeout(() => window.close(), 3500);
      return false; // stop polling
    }

    if (res.title !== lastTitle) {
      $titleText.textContent = res.title;
      lastTitle = res.title;
    }
    if ((res.detail || "") !== lastDetail) {
      $detail.textContent = res.detail || "";
      lastDetail = res.detail || "";
    }
    return true; // continue polling
  }

  function poll() {
    if (isDone) return;

    chrome.runtime.sendMessage({ type: "MC_GET_STATUS" }, (res) => {
      if (chrome.runtime.lastError) {
        // Service worker restarted — wait a moment and retry.
        setTimeout(poll, 1200);
        return;
      }
      if (applyStatus(res)) {
        setTimeout(poll, 350);
      }
    });
  }

  poll();
})();
