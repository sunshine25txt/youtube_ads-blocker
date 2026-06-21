/**
 * YT Silent AdBlock — background.js (Service Worker)
 *
 * MV3 service workers are non-persistent: they spin up on events and go idle
 * after ~30s of inactivity. All state must be re-derivable on wake.
 *
 * Responsibilities:
 *  1. Log installation for debugging.
 *  2. Provide a message listener so content scripts can verify the extension
 *     context is still valid (prevents "Extension context invalidated" errors).
 *  3. Optionally log DNR rule matches during development.
 */

chrome.runtime.onInstalled.addListener((details) => {
  console.log(
    `[YT Silent AdBlock] ${details.reason === "install" ? "Installed" : "Updated"} — v2.1`
  );
});

/**
 * Content scripts can send a "ping" to verify the service worker is alive
 * before calling chrome.runtime.getURL(). If this listener doesn't respond,
 * the content script knows the extension context is invalidated.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "ping") {
    sendResponse({ alive: true });
    return true;
  }
});

/**
 * DEV ONLY: Uncomment to log which DNR rules are firing.
 * Requires "declarativeNetRequestFeedback" permission.
 *
 * chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
 *   console.log("[DNR Match]", info.request.url, "→ rule", info.rule.ruleId);
 * });
 */

/* ─── Dynamic Config Updater ─── */
// This auto-updates the DNR rules and JSON Strip Keys from a remote repository
const CONFIG_URL = "https://raw.githubusercontent.com/cse-adi/yt-adblocker-v2/main/remote-config.json";

chrome.runtime.onInstalled.addListener((details) => {
  // Fetch updates every 12 hours
  chrome.alarms.create("fetchConfig", { periodInMinutes: 720 });
  fetchAndApplyConfig();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "fetchConfig") {
    fetchAndApplyConfig();
  }
});

async function fetchAndApplyConfig() {
  try {
    const response = await fetch(CONFIG_URL + "?t=" + Date.now());
    if (!response.ok) return;
    
    const config = await response.json();
    
    // 1. Update Dynamic Rules (Network Level)
    if (config.rules && Array.isArray(config.rules)) {
      const oldRules = await chrome.declarativeNetRequest.getDynamicRules();
      const oldRuleIds = oldRules.map(r => r.id);
      
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: oldRuleIds,
        addRules: config.rules
      });
      console.log(`[YT Silent AdBlock] Updated ${config.rules.length} dynamic DNR rules.`);
    }

    // 2. Update Strip Keys (Payload Modification)
    if (config.stripKeys && Array.isArray(config.stripKeys)) {
      await chrome.storage.local.set({ dynamicStripKeys: config.stripKeys });
      console.log(`[YT Silent AdBlock] Updated ${config.stripKeys.length} dynamic STRIP_KEYS.`);
    }
  } catch (err) {
    console.log("[YT Silent AdBlock] Failed to fetch remote config:", err.message);
  }
}
