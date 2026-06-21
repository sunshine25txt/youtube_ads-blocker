/**
 * YT Silent AdBlock — content.js
 *
 * Runs in the ISOLATED content-script world at document_start.
 *
 * Architecture:
 *  1. Inject page-patch.js into the MAIN world to intercept YouTube's API
 *     responses and strip ad payloads before the player processes them.
 *  2. Install CSS to hide any residual ad UI elements (cosmetic filtering).
 *  3. Use a TARGETED MutationObserver scoped to the player container to
 *     detect the "ad-showing" class and react in <50ms.
 *  4. Handle YouTube's anti-adblock dialogs by removing them and resuming
 *     video playback.
 *
 * Performance notes:
 *  - NO setInterval polling — all detection is observer-driven.
 *  - Observer is scoped to #movie_player (not document.documentElement),
 *    reducing callback frequency by ~200x.
 *  - Observer is disconnected and re-attached on SPA navigation to prevent
 *    accumulation.
 */

(function () {
  "use strict";

  /* ─── Guard: prevent double-injection in the same isolated world ─── */
  if (window.__YT_SILENT_ADBLOCK_ACTIVE__) return;
  window.__YT_SILENT_ADBLOCK_ACTIVE__ = true;

  /* ─── Constants ─── */
  const STYLE_ID = "yt-silent-adblock-css";

  /**
   * Selectors for ad-related DOM elements to hide via CSS and remove via JS.
   * Includes 2025-2026 additions: primetime promo, engagement panel ads,
   * and the modern ad-skip button variant.
   */
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
    /* 2025-2026 additions */
    "ytd-primetime-promo-renderer",
    "ytd-engagement-panel-ad-renderer",
    "ytd-statement-banner-renderer",
    ".ytd-player-ad-overlay-renderer",
  ];

  const HIDE_SELECTORS_JOINED = HIDE_SELECTORS.join(", ");

  /**
   * CSS injected once to immediately hide ad UI before JS can remove it.
   * Using display:none ensures no layout shift from ad containers.
   */
  const STYLE_TEXT =
    HIDE_SELECTORS_JOINED + " { display: none !important; }";

  /**
   * Dialogs YouTube shows when it detects an ad blocker.
   * These pause the video — we must remove them AND resume playback.
   */
  const DIALOG_SELECTORS =
    "tp-yt-paper-dialog, ytd-enforcement-message-view-model, " +
    "ytd-popup-container .yt-playability-error-supported-renderers, " +
    ".ytd-popup-container[dialog]";

  /**
   * Skip-button selectors covering all known variants (2024-2026).
   */
  const SKIP_BUTTON_SELECTOR =
    ".ytp-ad-skip-button, .ytp-skip-ad-button, " +
    ".ytp-ad-skip-button-modern, " +
    "button.ytp-ad-skip-button-modern, " +
    "[class*='skip-button']";

  /* ─── State ─── */
  let playerObserver = null;   // MutationObserver on #movie_player class changes
  let contentObserver = null;  // MutationObserver on page content for cosmetic removal
  let styleInstalled = false;

  /* ─── Style Injection ─── */

  function installStyle() {
    if (styleInstalled) return;

    const target = document.head || document.documentElement;
    if (!target) return;

    // Check if already in DOM (e.g., from a previous injection)
    if (document.getElementById(STYLE_ID)) {
      styleInstalled = true;
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    target.appendChild(style);
    styleInstalled = true;
  }

  /* ─── Page-World Script Injection ─── */

  function injectPagePatch() {
    let scriptUrl;
    try {
      scriptUrl = chrome.runtime.getURL("page-patch.js");
    } catch (_) {
      // Extension context invalidated (e.g., extension was reloaded).
      // Page-patch cannot be injected — DOM fallbacks will still work.
      return;
    }

    // Prevent duplicate injection
    if (document.querySelector(`script[src="${scriptUrl}"]`)) return;

    const script = document.createElement("script");
    script.src = scriptUrl;
    // Remove the script tag after execution to keep DOM clean
    script.onload = () => script.remove();
    script.onerror = () => script.remove();
    (document.documentElement || document.head).appendChild(script);
  }

  /* ─── Ad Skip Logic ─── */

  /**
   * Fast-forwards and mutes the currently playing ad, then clicks skip.
   * Called synchronously from the MutationObserver callback for minimum
   * latency between "ad-showing" class appearing and skip execution.
   */
  function skipActiveAd() {
    const player = document.getElementById("movie_player");
    if (!player || !player.classList.contains("ad-showing")) return;

    const video = player.querySelector("video");
    if (!video) return;

    // Click skip button immediately if available
    const skipButton = player.querySelector(SKIP_BUTTON_SELECTOR);
    if (skipButton) {
      try { skipButton.click(); } catch (_) {}
    }

    // Jump to end of ad so it completes instantly
    try {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = Math.max(0, video.duration - 0.05);
      }
    } catch (_) {}

    // Mute ad audio — track whether we forced it so we can restore later
    try {
      if (!video.__ytSilentMuteState__) {
        video.__ytSilentMuteState__ = video.muted ? "was-muted" : "forced";
      }
      if (!video.muted) video.muted = true;
    } catch (_) {}

    // Maximize playback rate to burn through unskippable ads
    try {
      if (video.__ytSilentOriginalRate__ == null) {
        video.__ytSilentOriginalRate__ = video.playbackRate;
      }
      video.playbackRate = 16;
    } catch (_) {}
  }

  /**
   * Restores video state after an ad finishes.
   * Only called when the player no longer has the "ad-showing" class.
   */
  function restoreVideoState() {
    const player = document.getElementById("movie_player");
    const video = player && player.querySelector("video");

    if (!video) return;
    // Don't restore if an ad is still playing
    if (player.classList.contains("ad-showing")) return;

    if (video.__ytSilentOriginalRate__ != null) {
      try { video.playbackRate = video.__ytSilentOriginalRate__; } catch (_) {}
      video.__ytSilentOriginalRate__ = null;
    }

    if (video.__ytSilentMuteState__ === "forced" && video.muted) {
      try { video.muted = false; } catch (_) {}
    }
    video.__ytSilentMuteState__ = null;
  }

  /* ─── Cosmetic Ad Removal ─── */

  function removeAdElements() {
    const adElements = document.querySelectorAll(HIDE_SELECTORS_JOINED);
    for (let i = 0; i < adElements.length; i++) {
      try { adElements[i].remove(); } catch (_) {}
    }
  }

  /**
   * Detects and removes YouTube's anti-adblock enforcement dialogs.
   * If a dialog was removed, resumes video playback since YouTube pauses
   * the video when showing these dialogs.
   */
  function dismissAntiAdblockDialogs() {
    const dialogues = document.querySelectorAll(DIALOG_SELECTORS);
    let dismissed = false;

    for (let i = 0; i < dialogues.length; i++) {
      const el = dialogues[i];
      const text = (el.innerText || "").toLowerCase();
      const isAdblockDialog =
        text.includes("ad blocker") ||
        text.includes("disable your ad") ||
        text.includes("adblocker") ||
        text.includes("allow youtube ads");
      if (isAdblockDialog) {
        try { el.remove(); dismissed = true; } catch (_) {}
      }
    }

    if (dismissed) {
      // YouTube pauses the video when showing the dialog — resume it
      const video = document.querySelector("#movie_player video");
      if (video && video.paused) {
        // play() returns a Promise — must catch autoplay policy rejections
        video.play().catch(() => {});
      }
    }
  }

  /* ─── Observer Setup ─── */

  /**
   * Watches #movie_player's class attribute for "ad-showing" changes.
   * This is the fastest possible detection method — the observer fires
   * synchronously when YouTube adds/removes the class, giving us sub-50ms
   * reaction time vs 250-500ms with polling.
   */
  function setupPlayerObserver() {
    // Disconnect any previous observer to prevent accumulation on SPA nav
    if (playerObserver) {
      playerObserver.disconnect();
      playerObserver = null;
    }

    const player = document.getElementById("movie_player");
    if (!player) return;

    playerObserver = new MutationObserver(() => {
      if (player.classList.contains("ad-showing")) {
        skipActiveAd();
      } else {
        restoreVideoState();
      }
    });

    // Only watch class attribute changes on the player element itself
    playerObserver.observe(player, {
      attributes: true,
      attributeFilter: ["class"],
    });

    // If an ad is already showing when we attach, handle it immediately
    if (player.classList.contains("ad-showing")) {
      skipActiveAd();
    }
  }

  /**
   * Lightweight observer on the page content area for cosmetic ad removal
   * and anti-adblock dialog dismissal. Scoped to ytd-app (YouTube's SPA
   * root) instead of document.documentElement to avoid noise from
   * unrelated DOM mutations (e.g., DevTools, other extensions).
   *
   * Uses requestAnimationFrame batching to avoid firing on every mutation.
   */
  function setupContentObserver() {
    if (contentObserver) {
      contentObserver.disconnect();
      contentObserver = null;
    }

    const appRoot = document.querySelector("ytd-app") || document.documentElement;

    let pendingFrame = false;

    contentObserver = new MutationObserver(() => {
      if (pendingFrame) return;
      pendingFrame = true;
      requestAnimationFrame(() => {
        pendingFrame = false;
        removeAdElements();
        dismissAntiAdblockDialogs();
      });
    });

    contentObserver.observe(appRoot, {
      childList: true,
      subtree: true,
    });
  }

  /**
   * Waits for #movie_player to appear in the DOM, then attaches the
   * targeted player observer. Uses a temporary observer on document
   * body — disconnects itself once the player is found.
   */
  function waitForPlayer() {
    const player = document.getElementById("movie_player");
    if (player) {
      setupPlayerObserver();
      return;
    }

    // Player doesn't exist yet — watch for it with a temporary observer
    const waitObserver = new MutationObserver(() => {
      const p = document.getElementById("movie_player");
      if (p) {
        waitObserver.disconnect();
        setupPlayerObserver();
      }
    });

    // Observe body (or documentElement if body doesn't exist yet)
    const root = document.body || document.documentElement;
    waitObserver.observe(root, { childList: true, subtree: true });
  }

  /* ─── SPA Navigation Handling ─── */

  /**
   * YouTube is an SPA — pushState navigations don't reload content scripts.
   * We re-attach the player observer on each navigation because YouTube
   * may reconstruct the player element entirely.
   */
  function onNavigate() {
    // Small delay to let YouTube rebuild the player DOM
    setTimeout(() => {
      setupPlayerObserver();
      removeAdElements();
      dismissAntiAdblockDialogs();
    }, 100);
  }

  /* ─── Initialization ─── */

  function init() {
    installStyle();
    injectPagePatch();

    // Set up observers once the DOM is ready enough
    if (document.body) {
      waitForPlayer();
      setupContentObserver();
    } else {
      // At document_start, body may not exist yet
      document.addEventListener("DOMContentLoaded", () => {
        installStyle(); // Re-check in case <head> wasn't available earlier
        waitForPlayer();
        setupContentObserver();
      }, { once: true });
    }

    // Re-attach player observer on SPA navigations
    window.addEventListener("yt-navigate-finish", onNavigate, true);
    window.addEventListener("yt-page-data-updated", onNavigate, true);

    // Initial cosmetic pass
    removeAdElements();
    dismissAntiAdblockDialogs();
  }

  init();
})();
