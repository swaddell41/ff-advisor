// Toolbar click: on a draft page, (re)show the in-page overlay; anywhere
// else, open the side panel version of the assistant.
const DRAFT_URL = /sleeper\.com\/draft\/|espn\.com\/.*draft/;

chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.url && DRAFT_URL.test(tab.url)) {
    // Overlay content script listens for this and un-hides itself.
    chrome.storage.local.set({ overlayShowRequest: Date.now() });
  } else if (tab && tab.id != null) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(console.error);
  }
});

// Network proxy for content scripts. Their fetches run under the PAGE's
// origin and are blocked by the site's Content-Security-Policy (Sleeper and
// ESPN both restrict connect-src). The service worker fetches under the
// extension origin with host_permissions — immune to page CSP and CORS.
const ALLOWED = [
  'https://api.sleeper.app/',
  'https://ff-advisor-sam-waddells-projects.vercel.app/',
];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'ffa-fetch') return false;
  const url = String(msg.url || '');
  if (!ALLOWED.some((p) => url.startsWith(p))) {
    sendResponse({ ok: false, error: 'url not allowed' });
    return false;
  }
  fetch(url)
    .then(async (r) => sendResponse({ ok: r.ok, status: r.status, json: await r.json() }))
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true; // async response
});
