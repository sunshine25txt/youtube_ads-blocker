/**
 * YT Silent AdBlock — background.js
 * Blocks known ad-serving endpoints at the network level.
 * NOTE: We intentionally do NOT block YouTube's own analytics/tracking
 * (e.g. youtube.com/api/stats) to avoid triggering the ad-blocker detector.
 */

chrome.runtime.onInstalled.addListener(() => {
  console.log('[YT Silent AdBlock] Installed and active.');
});
