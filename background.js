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
