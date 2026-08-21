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
