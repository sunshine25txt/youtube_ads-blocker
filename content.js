/**
 * YT Silent AdBlock — lean runtime
 * 1. Injects a page-world patch at document_start to strip ad payloads
 *    before YouTube can schedule them.
 * 2. Keeps a lightweight DOM fallback for the rare cases where ad UI still
 *    appears after navigation or player state changes.
 */

(function () {
  "use strict";

  if (window.__YT_SILENT_ADBLOCK_ACTIVE__) {
    return;
  }
  window.__YT_SILENT_ADBLOCK_ACTIVE__ = true;

  const STYLE_ID = "yt-silent-adblock-css";
  const PAGE_SCRIPT_ID = "yt-silent-adblock-page-script";

  const HIDE_SELECTORS = [
    ".ytp-ad-module",
    ".ytp-ad-player-overlay",
    ".ytp-ad-overlay-container",
    ".ytp-ad-text-overlay",
    ".ytp-ad-image-overlay",
    ".ytp-ad-overlay-close-button",
    ".ytp-ad-progress",
    ".ytp-ad-progress-list",
    ".ytp-ad-preview-container",
    ".ytp-ad-preview-text",
    ".ytp-ad-button-icon",
    ".ytp-ad-simple-ad-badge",
    "#player-ads",
    "#masthead-ad",
    "ytd-display-ad-renderer",
    "ytd-ad-slot-renderer",
    "ytd-in-feed-ad-layout-renderer",
    "ytd-promoted-sparkles-web-renderer",
    "ytd-promoted-video-renderer",
    "ytd-search-pyv-renderer",
    "ytd-banner-promo-renderer",
    "ytd-video-masthead-ad-renderer",
    "ytd-action-companion-ad-renderer",
    "ytd-companion-slot-renderer",
    "ytd-carousel-ad-renderer",
    "yt-mealbar-promo-renderer",
  ];

  const STYLE_TEXT = `
    .ytp-ad-module,
    .ytp-ad-player-overlay,
    .ytp-ad-overlay-container,
    .ytp-ad-text-overlay,
    .ytp-ad-image-overlay,
    .ytp-ad-overlay-close-button,
    .ytp-ad-progress,
    .ytp-ad-progress-list,
    .ytp-ad-preview-container,
    .ytp-ad-preview-text,
    .ytp-ad-button-icon,
    .ytp-ad-simple-ad-badge,
    #player-ads,
    #masthead-ad,
    ytd-display-ad-renderer,
    ytd-ad-slot-renderer,
    ytd-in-feed-ad-layout-renderer,
    ytd-promoted-sparkles-web-renderer,
    ytd-promoted-video-renderer,
    ytd-search-pyv-renderer,
    ytd-banner-promo-renderer,
    ytd-video-masthead-ad-renderer,
    ytd-action-companion-ad-renderer,
    ytd-companion-slot-renderer,
    ytd-carousel-ad-renderer,
    yt-mealbar-promo-renderer {
      display: none !important;
    }
  `;

  function installStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    (document.head || document.documentElement).appendChild(style);
  }

  function injectPagePatch() {
    if (document.getElementById(PAGE_SCRIPT_ID)) {
      return;
    }

    const script = document.createElement("script");
    script.id = PAGE_SCRIPT_ID;
    script.src = chrome.runtime.getURL("page-patch.js");
    script.onload = function () {
      script.remove();
    };
    (document.documentElement || document.head).appendChild(script);
  }

  function skipActiveAd() {
    const player =
      document.getElementById("movie_player") ||
      document.querySelector(".html5-video-player");
    const video = document.getElementsByTagName("video")[0];

    if (!player || !video || !player.classList.contains("ad-showing")) {
      return;
    }

    const skipButton = player.querySelector(
      ".ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern, [class*='skip-button']",
    );
    if (skipButton) {
      skipButton.click();
    }

    try {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = Math.max(0, video.duration - 0.05);
      }
    } catch (_) {}

    try {
      if (!video.__ytSilentAdblockMuted__) {
        video.__ytSilentAdblockMuted__ = video.muted ? "already-muted" : "force";
      }
      if (!video.muted) {
        video.muted = true;
      }
    } catch (_) {}

    try {
      if (video.__ytSilentAdblockRate__ == null) {
        video.__ytSilentAdblockRate__ = video.playbackRate;
      }
      video.playbackRate = 16;
    } catch (_) {}
  }

  function restoreVideoState() {
    const player =
      document.getElementById("movie_player") ||
      document.querySelector(".html5-video-player");
    const video = document.getElementsByTagName("video")[0];

    if (!video || (player && player.classList.contains("ad-showing"))) {
      return;
    }

    if (video.__ytSilentAdblockRate__ != null) {
      try {
        video.playbackRate = video.__ytSilentAdblockRate__;
      } catch (_) {}
      video.__ytSilentAdblockRate__ = null;
    }

    if (
      video.__ytSilentAdblockMuted__ === "force" &&
      video.muted &&
      !document.hidden
    ) {
      try {
        video.muted = false;
      } catch (_) {}
    }
    video.__ytSilentAdblockMuted__ = null;
  }

  const HIDE_SELECTORS_JOINED = HIDE_SELECTORS.join(", ");
  const DIALOG_SELECTORS = "tp-yt-paper-dialog, ytd-enforcement-message-view-model, .yt-playability-error-supported-renderers";

  function removeAdElements() {
    const elements = document.querySelectorAll(HIDE_SELECTORS_JOINED);
    for (let i = 0; i < elements.length; i++) {
      try {
        elements[i].remove();
      } catch (_) {}
    }

    const dialogues = document.querySelectorAll(DIALOG_SELECTORS);
    let removedDialogue = false;
    for (let i = 0; i < dialogues.length; i++) {
      const element = dialogues[i];
      const text = (element.innerText || "").toLowerCase();
      if (text.includes("ad blocker") || text.includes("disable your ad") || text.includes("adblocker")) {
        try {
          element.remove();
          removedDialogue = true;
        } catch (_) {}
      }
    }

    if (removedDialogue) {
      const video = document.getElementsByTagName("video")[0];
      if (video && video.paused) {
        try {
          video.play();
        } catch (_) {}
      }
    }
  }

  let scheduled = false;
  function runOptimizedPass() {
    scheduled = false;
    installStyle();
    removeAdElements();
    skipActiveAd();
    restoreVideoState();
  }

  function schedulePass() {
    if (scheduled) {
      return;
    }
    scheduled = true;
    requestAnimationFrame(runOptimizedPass);
  }

  function init() {
    installStyle();
    injectPagePatch();
    runOptimizedPass();

    const observer = new MutationObserver(schedulePass);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    window.addEventListener("yt-navigate-start", schedulePass, true);
    window.addEventListener("yt-navigate-finish", schedulePass, true);
    window.addEventListener("popstate", schedulePass, true);

    setInterval(() => {
      const player =
        document.getElementById("movie_player") ||
        document.querySelector(".html5-video-player");
      const video = document.getElementsByTagName("video")[0];
      const hasTemporaryState =
        !!video &&
        (video.__ytSilentAdblockRate__ != null ||
          video.__ytSilentAdblockMuted__ != null);

      if (
        (player && player.classList.contains("ad-showing")) ||
        hasTemporaryState
      ) {
        runOptimizedPass();
      }
    }, 250);
  }

  init();
})();
