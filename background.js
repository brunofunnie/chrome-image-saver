// Image Saver — service worker (MV3).
// Responsibilities:
//  1. Toggle per-tab "active" hover mode when the toolbar icon is clicked.
//  2. Reflect mode in the icon badge.
//  3. Perform downloads when the content script asks (downloads are not allowed
//     from the page for cross-origin images, so they happen here).

const STORAGE_KEY = "imageSaverActive";

// Broadcast a message to all frames of a tab.
async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    // Frame may not exist yet (e.g. page loading). Ignore.
  }
}

// Toggle the active flag and persist it per-tab in session storage so it
// survives background-worker restarts while the tab stays open.
async function setActive(tabId, active) {
  const store = await chrome.storage.session.get(STORAGE_KEY) || {};
  const map = store[STORAGE_KEY] || {};
  if (active) map[tabId] = true;
  else delete map[tabId];
  await chrome.storage.session.set({ [STORAGE_KEY]: map });

  await chrome.action.setBadgeText({ tabId, text: active ? "ON" : "" });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#16a34a" });

  await sendToTab(tabId, { type: "set-active", active });
}

chrome.action.onClicked.addListener(async (tab) => {
  const store = await chrome.storage.session.get(STORAGE_KEY) || {};
  const map = store[STORAGE_KEY] || {};
  const wasActive = !!map[tab.id];
  await setActive(tab.id, !wasActive);
});

// Handle download requests and state queries from content scripts.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "get-state") {
    const tabId = sender.tab && sender.tab.id;
    chrome.storage.session.get(STORAGE_KEY).then((store) => {
      const map = (store && store[STORAGE_KEY]) || {};
      sendResponse({ active: !!map[tabId] });
    }).catch(() => sendResponse({ active: false }));
    return true;
  }

  if (msg && msg.type === "download") {
    const { url, filename } = msg;
    if (!url || /^(about|javascript):/i.test(url)) {
      sendResponse({ ok: false, error: "invalid-url" });
      return false;
    }
    chrome.downloads
      .download({ url, filename, conflictAction: "uniquify" })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the message channel open for async response
  }
  return false;
});

// Sync the badge when the worker (re)starts.
chrome.runtime.onStartup.addListener(syncAllBadges);
chrome.runtime.onInstalled.addListener(syncAllBadges);

async function syncAllBadges() {
  const store = await chrome.storage.session.get(STORAGE_KEY) || {};
  const map = store[STORAGE_KEY] || {};
  for (const tabIdStr of Object.keys(map)) {
    const tabId = Number(tabIdStr);
    try {
      await chrome.action.setBadgeText({ tabId, text: "ON" });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#16a34a" });
    } catch (e) {
      // Tab no longer exists; clean up.
      await chrome.storage.session.set({ [STORAGE_KEY]: without(map, tabIdStr) });
    }
  }
}

function without(obj, key) {
  const next = { ...obj };
  delete next[key];
  return next;
}