/**
 * YT Silent AdBlock — page-patch.js
 *
 * Runs in the MAIN page world (not isolated content-script world).
 * Intercepts YouTube's API responses at the JavaScript level to strip
 * ad payloads BEFORE the player processes them. This is the most
 * effective layer because it prevents ads from ever being scheduled,
 * making detection much harder than DOM-based skip-button clicking.
 *
 * Interception points:
 *  1. window.fetch — patches /youtubei/v1/player, /next, /browse responses
 *  2. XMLHttpRequest — same endpoints via XHR fallback
 *  3. ytInitialPlayerResponse — inline <script> data on first page load
 *  4. ytInitialData — inline page data containing feed ads
 *
 * The sanitizer strips ad-related keys from YouTube's JSON responses,
 * making the player believe no ads were scheduled for the video.
 */

(function () {
  "use strict";

  /* ─── Guard: silent return instead of throwing (avoids console noise) ─── */
  if (window.__YT_SILENT_ADBLOCK_PAGE_ACTIVE__) return;
  window.__YT_SILENT_ADBLOCK_PAGE_ACTIVE__ = true;

  /**
   * Keys to DELETE entirely from response objects.
   * These are leaf-level ad configuration properties that YouTube's
   * player reads to schedule ad breaks, overlays, and companions.
   *
   * Updated for 2025-2026 YouTube player API changes.
   */
  const STRIP_KEYS = new Set([
    "adBreakHeartbeatParams",
    "ad3Module",
    "adSafetyReason",
    "adLoggingData",
    "adVideoId",
    "adTag",
    "adParams",
    "adClientParams",
    "adSegments",
    "cueRanges",
    "linearAds",
    "instreamVideoAdRenderer",
    "playerLegacyDesktopYpcTrailerRenderer",
    "tvfilmOfferModuleRenderer",
    /* 2025-2026 additions */
    "adBreakServiceRenderer",
    "playerAdBreakBeforeStartMs",
    "adInfoRenderer",
    "adLayoutMetadata",
    "adBreakParams",
    "adFeedbackRenderer",
  ]);

  // Merge dynamically fetched keys if they were injected by the content script
  if (window.__YT_DYNAMIC_STRIP_KEYS__ && Array.isArray(window.__YT_DYNAMIC_STRIP_KEYS__)) {
    window.__YT_DYNAMIC_STRIP_KEYS__.forEach(key => STRIP_KEYS.add(key));
  }

  /**
   * Array-type keys to EMPTY (set to []) rather than delete.
   * These must exist as empty arrays or YouTube throws runtime errors
   * when the player tries to iterate them.
   */
  const EMPTY_ARRAY_KEYS = new Set([
    "adPlacements",
    "adSlots",
    "playerAds",
  ]);

  /**
   * Combined set of all keys we care about — used for the fast regex
   * pre-check on raw response text to avoid parsing JSON unnecessarily.
   */
  const ALL_KEYS = [...STRIP_KEYS, ...EMPTY_ARRAY_KEYS];
  const AD_KEYS_REGEX = new RegExp(ALL_KEYS.join("|"));

  /* ─── Object Sanitizer ─── */

  /**
   * Recursively walks a parsed JSON object and strips ad-related keys.
   * Uses a WeakSet to handle circular references without infinite loops.
   */
  function sanitizeObject(root) {
    if (!root || typeof root !== "object") return root;

    const seen = new WeakSet();

    function walk(node) {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);

      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) walk(node[i]);
        return;
      }

      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];

        if (STRIP_KEYS.has(key)) {
          delete node[key];
          continue;
        }

        if (EMPTY_ARRAY_KEYS.has(key) && Array.isArray(node[key])) {
          node[key] = [];
          continue;
        }

        walk(node[key]);
      }
    }

    walk(root);
    return root;
  }

  /* ─── Text Sanitizer ─── */

  /**
   * Sanitizes a raw response text string by parsing as JSON, stripping
   * ad keys, and re-serializing.
   *
   * Handles YouTube's JSON security prefix `)]}'\n` which prevents
   * direct JSON.parse without stripping first.
   */
  function sanitizeText(text) {
    if (typeof text !== "string") return text;

    // Fast path: skip parsing if no ad keys are present in the raw text
    if (!AD_KEYS_REGEX.test(text)) return text;

    // YouTube prefixes some JSON responses with )]}'\n to prevent XSSI
    let prefix = "";
    let jsonText = text;
    if (text.charCodeAt(0) === 41 /* ')' */) {
      const nlIdx = text.indexOf("\n");
      if (nlIdx !== -1 && nlIdx < 10) {
        prefix = text.substring(0, nlIdx + 1);
        jsonText = text.substring(nlIdx + 1);
      }
    }

    try {
      const parsed = JSON.parse(jsonText);
      sanitizeObject(parsed);
      return prefix + JSON.stringify(parsed);
    } catch (_) {
      return text;
    }
  }

  /* ─── URL Matching ─── */

  /**
   * Returns true for YouTube API endpoints whose responses contain
   * ad scheduling data that should be sanitized.
   */
  function shouldPatchUrl(url) {
    if (typeof url !== "string") return false;
    return (
      url.includes("/youtubei/v1/player") ||
      url.includes("/youtubei/v1/next") ||
      url.includes("/youtubei/v1/browse") ||
      url.includes("/youtubei/v1/reel") ||
      url.includes("/get_video_info")
    );
  }

  /* ─── Fetch Interception ─── */

  /**
   * Creates a new Response object with sanitized body text while
   * preserving the original response's metadata (status, headers, url).
   */
  function patchResponse(response, bodyText) {
    const patched = new Response(bodyText, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });

    // Preserve read-only properties that Response constructor doesn't set
    try {
      Object.defineProperty(patched, "url", {
        configurable: true,
        value: response.url,
      });
    } catch (_) {}

    try {
      Object.defineProperty(patched, "redirected", {
        configurable: true,
        value: response.redirected,
      });
    } catch (_) {}

    try {
      Object.defineProperty(patched, "type", {
        configurable: true,
        value: response.type,
      });
    } catch (_) {}

    return patched;
  }

  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    // Extract URL from the first argument (can be string, URL, or Request)
    const request = args[0];
    const url =
      typeof request === "string"
        ? request
        : request && typeof request.url === "string"
          ? request.url
          : "";

    // Fast path: non-ad URLs bypass our interceptor entirely
    if (!shouldPatchUrl(url)) {
      return originalFetch.apply(this, args);
    }

    try {
      const response = await originalFetch.apply(this, args);
      const rawText = await response.clone().text();
      const sanitizedText = sanitizeText(rawText);

      // If nothing changed, return the original response to avoid
      // breaking any internal response state YouTube depends on
      if (sanitizedText === rawText) return response;

      return patchResponse(response, sanitizedText);
    } catch (err) {
      // Propagate the original error — don't mask network failures
      throw err;
    }
  };

  /* ─── XHR Interception ─── */

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function () {
    // Store the URL from the second argument for later use in send()
    const url = arguments[1];
    this.__ytSilentUrl__ = typeof url === "string" ? url : String(url || "");
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    if (
      !this.__ytSilentPatched__ &&
      shouldPatchUrl(this.__ytSilentUrl__)
    ) {
      this.__ytSilentPatched__ = true;

      try {
        // Override responseText getter to sanitize before YouTube reads it
        const responseTextDesc = Object.getOwnPropertyDescriptor(
          XMLHttpRequest.prototype,
          "responseText"
        );
        if (responseTextDesc && responseTextDesc.get) {
          let cached;
          let hasCached = false;

          Object.defineProperty(this, "responseText", {
            configurable: true,
            get() {
              if (this.readyState !== 4) return responseTextDesc.get.call(this);
              if (hasCached) return cached;

              const raw = responseTextDesc.get.call(this);
              cached = typeof raw === "string" ? sanitizeText(raw) : raw;
              hasCached = true;
              return cached;
            },
          });
        }

        // Override response getter for text and json response types
        const responseDesc = Object.getOwnPropertyDescriptor(
          XMLHttpRequest.prototype,
          "response"
        );
        if (responseDesc && responseDesc.get) {
          let cached;
          let hasCached = false;

          Object.defineProperty(this, "response", {
            configurable: true,
            get() {
              if (this.readyState !== 4) return responseDesc.get.call(this);
              if (hasCached) return cached;

              const raw = responseDesc.get.call(this);

              if (this.responseType === "" || this.responseType === "text") {
                cached = typeof raw === "string" ? sanitizeText(raw) : raw;
              } else if (this.responseType === "json" && raw) {
                // JSON responseType: sanitize the parsed object directly
                try {
                  cached = sanitizeObject(
                    JSON.parse(JSON.stringify(raw))
                  );
                } catch (_) {
                  cached = raw;
                }
              } else {
                cached = raw;
              }

              hasCached = true;
              return cached;
            },
          });
        }
      } catch (_) {
        // If property descriptor overrides fail, XHR responses won't be
        // sanitized — DOM-level fallbacks in content.js will still work.
      }
    }

    return originalSend.apply(this, arguments);
  };

  /* ─── Initial Page Data Interception ─── */

  /**
   * YouTube embeds ad data directly in the initial HTML via inline scripts
   * that set window.ytInitialPlayerResponse and window.ytInitialData.
   * We intercept these setters to sanitize the data before the player
   * reads it, preventing the very first ad from ever being scheduled.
   */
  let initialPlayerResponse;
  Object.defineProperty(window, "ytInitialPlayerResponse", {
    configurable: true,
    enumerable: true,
    get() {
      return initialPlayerResponse;
    },
    set(value) {
      initialPlayerResponse = sanitizeObject(value);
    },
  });

  let initialData;
  Object.defineProperty(window, "ytInitialData", {
    configurable: true,
    enumerable: true,
    get() {
      return initialData;
    },
    set(value) {
      initialData = sanitizeObject(value);
    },
  });

  /* ─── JSON.parse Hijack (Advanced Scriptlet) ─── */
  const originalParse = JSON.parse;
  JSON.parse = function() {
    const parsed = originalParse.apply(this, arguments);
    if (parsed && typeof parsed === 'object') {
      // Check for known ad-related root or nested keys
      if (parsed.adPlacements || parsed.playerAds || parsed.adBreakHeartbeatParams || parsed.adSlots) {
        return sanitizeObject(parsed);
      }
    }
    return parsed;
  };

  /* ─── Advanced Video Element Hijack ─── */
  // Intercept the native play() method to block ads at the player level instantly (Brave-style)
  const originalPlay = HTMLVideoElement.prototype.play;
  HTMLVideoElement.prototype.play = function () {
    try {
      const src = this.src || '';
      const isAdUrl = src.includes('oad=') || src.includes('ctier=A') || src.includes('/ad/');
      const isAdClass = this.closest && this.closest('.ad-showing');
      
      if (isAdUrl || isAdClass) {
        // Fast forward instantly before any frame renders
        if (Number.isFinite(this.duration) && this.duration > 0) {
          this.currentTime = this.duration - 0.1;
        }
      }
    } catch (_) {}
    return originalPlay.apply(this, arguments);
  };

  /* ─── Anti-Adblock Detection Spoofing ─── */
  // Intercept window.ytcfg.set to modify experiment flags before they take effect
  let realYtcfg = window.ytcfg;
  Object.defineProperty(window, 'ytcfg', {
    configurable: true,
    get() { return realYtcfg; },
    set(val) {
      if (val && typeof val.set === 'function') {
        const originalSet = val.set;
        val.set = function() {
          if (arguments[0] && typeof arguments[0] === 'object') {
            const flags = arguments[0].EXPERIMENT_FLAGS;
            if (flags) {
              // Neutralize common anti-adblock detection flags
              delete flags.ab_dict_fe_req;
              flags.cb_v2_use_videoplayback_ad_signals = false;
              flags.web_enable_adblock_payload_suppression = false;
              flags.adblock_metrics_payload = false;
              flags.ios_enable_adblock_messaging = false;
            }
          }
          return originalSet.apply(this, arguments);
        };
      }
      realYtcfg = val;
    }
  });

})();
