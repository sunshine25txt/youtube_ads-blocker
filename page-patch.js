if (window.__YT_SILENT_ADBLOCK_PAGE_ACTIVE__) {
  throw new Error("Already initialized");
}
window.__YT_SILENT_ADBLOCK_PAGE_ACTIVE__ = true;

const STRIP_KEYS = [
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
];

const STRIP_KEYS_SET = new Set(STRIP_KEYS);

const ALL_KEYS_TO_CHECK = [
  ...STRIP_KEYS,
  "adPlacements",
  "adSlots",
  "playerAds"
];

function sanitizeObject(root) {
  if (!root || typeof root !== "object") {
    return root;
  }

  const seen = new WeakSet();

  function walk(node) {
    if (!node || typeof node !== "object" || seen.has(node)) {
      return node;
    }

    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return node;
    }

    for (const key of Object.keys(node)) {
      if (STRIP_KEYS_SET.has(key)) {
        delete node[key];
        continue;
      }

      walk(node[key]);
    }

    if (Array.isArray(node.adPlacements)) {
      node.adPlacements = [];
    }
    if (Array.isArray(node.playerAds)) {
      node.playerAds = [];
    }
    if (Array.isArray(node.adSlots)) {
      node.adSlots = [];
    }

    return node;
  }

  return walk(root);
}

const AD_KEYS_REGEX = new RegExp(ALL_KEYS_TO_CHECK.join("|"));

function sanitizeText(text) {
  if (typeof text !== "string") return text;
  
  if (!AD_KEYS_REGEX.test(text)) {
    return text;
  }

  try {
    const parsed = JSON.parse(text);
    sanitizeObject(parsed);
    return JSON.stringify(parsed);
  } catch (_) {
    return text;
  }
}

function shouldPatchUrl(url) {
  return (
    typeof url === "string" &&
    (url.includes("/youtubei/v1/player") ||
      url.includes("/youtubei/v1/next") ||
      url.includes("/youtubei/v1/browse") ||
      url.includes("/get_video_info") ||
      url.includes("/watch?v="))
  );
}

function patchResponse(response, bodyText) {
  const patched = new Response(bodyText, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });

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
  const response = await originalFetch.apply(this, args);

  try {
    const request = args[0];
    const url =
      typeof request === "string"
        ? request
        : request && typeof request.url === "string"
          ? request.url
          : "";

    if (!shouldPatchUrl(url)) {
      return response;
    }

    const rawText = await response.clone().text();
    const sanitizedText = sanitizeText(rawText);

    if (sanitizedText === rawText) {
      return response;
    }

    return patchResponse(response, sanitizedText);
  } catch (_) {
    return response;
  }
};

const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function (method, url) {
  this.__ytSilentAdblockUrl__ =
    typeof url === "string" ? url : String(url || "");
  return originalOpen.apply(this, arguments);
};

XMLHttpRequest.prototype.send = function () {
  if (!this.__ytSilentAdblockPatched__ && shouldPatchUrl(this.__ytSilentAdblockUrl__)) {
    this.__ytSilentAdblockPatched__ = true;

    let cachedResponseText;
    let cachedResponse;
    let hasCachedResponseText = false;
    let hasCachedResponse = false;

    try {
      const responseTextDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "responseText");
      if (responseTextDesc && responseTextDesc.get) {
        Object.defineProperty(this, "responseText", {
          configurable: true,
          get() {
            if (this.readyState !== 4) return responseTextDesc.get.call(this);
            if (hasCachedResponseText) return cachedResponseText;

            const originalText = responseTextDesc.get.call(this);
            if (typeof originalText === "string") {
              cachedResponseText = sanitizeText(originalText);
            } else {
              cachedResponseText = originalText;
            }
            hasCachedResponseText = true;
            return cachedResponseText;
          }
        });
      }

      const responseDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "response");
      if (responseDesc && responseDesc.get) {
        Object.defineProperty(this, "response", {
          configurable: true,
          get() {
            if (this.readyState !== 4) return responseDesc.get.call(this);
            if (hasCachedResponse) return cachedResponse;

            const originalRes = responseDesc.get.call(this);
            if (this.responseType === "" || this.responseType === "text") {
              if (typeof originalRes === "string") {
                cachedResponse = sanitizeText(originalRes);
              } else {
                cachedResponse = originalRes;
              }
            } else if (this.responseType === "json") {
              if (originalRes) {
                try {
                  const str = JSON.stringify(originalRes);
                  const sanitizedStr = sanitizeText(str);
                  if (str === sanitizedStr) {
                    cachedResponse = originalRes;
                  } else {
                    cachedResponse = JSON.parse(sanitizedStr);
                  }
                } catch (_) {
                  cachedResponse = originalRes;
                }
              } else {
                cachedResponse = originalRes;
              }
            } else {
              cachedResponse = originalRes;
            }
            hasCachedResponse = true;
            return cachedResponse;
          }
        });
      }
    } catch (_) {}
  }

  return originalSend.apply(this, arguments);
};

let initialPlayerResponse;
Object.defineProperty(window, "ytInitialPlayerResponse", {
  configurable: true,
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
  get() {
    return initialData;
  },
  set(value) {
    initialData = sanitizeObject(value);
  },
});
