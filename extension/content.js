// Runs on sleeper.com/draft/* — extract the draft id from the URL and stash
// it so the side panel auto-connects. Sleeper draft URLs look like:
//   https://sleeper.com/draft/nfl/<draft_id>
(function () {
  const m = window.location.pathname.match(/\/draft\/\w+\/(\d+)/);
  if (m) {
    try {
      chrome.storage.local.set({ draftId: m[1], draftIdSetAt: Date.now() });
    } catch (_) { /* orphaned after extension reload — refresh the tab */ }
  }
})();
