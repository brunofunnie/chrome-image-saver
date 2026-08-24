// Image Saver — service worker (MV3).
// Responsibilities:
//  1. Toggle per-tab "active" hover mode when the toolbar icon is clicked.
//  2. Keep that per-tab state honest across reloads, navigations and tab
//     closure, so the badge never claims ON over a page where nothing runs.
//  3. Reflect mode in the icon badge.
//  4. Perform downloads when the content script asks (downloads are not allowed
//     from the page for cross-origin images, so they happen here).
//
// The state is per TAB, and lives in chrome.storage.session as a map of
// tabId -> true. Session storage survives this worker being shut down and
// restarted (which MV3 does aggressively) but is dropped when the browser
// closes, which is exactly the lifetime we want.

const STORAGE_KEY = "imageSaverActive";

// ---------------------------------------------------------------- state

async function getMap() {
  const store = (await chrome.storage.session.get(STORAGE_KEY)) || {};
  return store[STORAGE_KEY] || {};
}

async function putMap(map) {
  await chrome.storage.session.set({ [STORAGE_KEY]: map });
}

async function isActive(tabId) {
  const map = await getMap();
  return !!map[tabId];
}

// Drop a tab's entry without touching its badge (the tab may be gone).
async function forgetTab(tabId) {
  const map = await getMap();
  if (!(tabId in map)) return;
  delete map[tabId];
  await putMap(map);
  console.log("[ImageSaver:bg] forgot tab", tabId);
}

// Broadcast a message to a tab. Fails harmlessly when no content script is
// listening (page still loading, restricted page, already navigated away).
async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    // No receiver in that tab. Nothing to do.
  }
}

async function setActive(tabId, active) {
  const map = await getMap();
  if (active) map[tabId] = true;
  else delete map[tabId];
  await putMap(map);

  await chrome.action.setBadgeText({ tabId, text: active ? "ON" : "" });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#16a34a" });

  await sendToTab(tabId, { type: "set-active", active });
  console.log("[ImageSaver:bg] tab", tabId, active ? "ON" : "OFF");
}

// ---------------------------------------------------- content-script presence

// Is a content script alive in this tab right now? A script injected with
// chrome.scripting does not survive a navigation, and one left over from a
// previous version of the extension has a dead runtime, so the only reliable
// test is to ask it.
async function hasContentScript(tabId) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: "ping" });
    return !!(resp && resp.pong);
  } catch (e) {
    return false;
  }
}

// Make sure a live content script exists in the tab, injecting one only when
// there isn't. Injecting unconditionally would stack a fresh copy — and a fresh
// set of listeners — on every single toolbar click.
//
// Returns false when the extension cannot run in the tab at all: a restricted
// page (chrome://, the Web Store), or a tab whose activeTab grant has been
// revoked by a cross-origin navigation.
async function ensureContentScript(tabId) {
  if (await hasContentScript(tabId)) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    console.log("[ImageSaver:bg] injected content.js into tab", tabId);
    return true;
  } catch (e) {
    console.warn("[ImageSaver:bg] cannot inject into tab", tabId, e && e.message);
    return false;
  }
}

// ---------------------------------------------------------------- toolbar

chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab.id;

  if (await isActive(tabId)) {
    await setActive(tabId, false);
    return;
  }

  // Only claim to be ON once we know we can actually run in this tab.
  if (!(await ensureContentScript(tabId))) {
    console.warn("[ImageSaver:bg] not turning on: no access to tab", tabId);
    return;
  }
  await setActive(tabId, true);
});

// ------------------------------------------------------------ tab lifecycle

// A navigation (including a plain refresh) destroys the injected content
// script, so without this the tab would keep its ON badge over a page where
// nothing is listening — and the next click would toggle it OFF rather than
// bringing it back.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  if (!(await isActive(tabId))) return;

  if (await ensureContentScript(tabId)) {
    await sendToTab(tabId, { type: "set-active", active: true });
    console.log("[ImageSaver:bg] restored hover mode in tab", tabId);
  } else {
    // We can no longer reach this tab, so the mode cannot be honoured. Turn it
    // off rather than leave a badge that lies about what's running.
    console.log("[ImageSaver:bg] lost access to tab", tabId, "- turning off");
    await setActive(tabId, false);
  }
});

// Without this the entry outlives the tab, and a later tab that reuses the id
// would start out flagged ON with no content script behind it.
// The promise is returned rather than dropped so the cleanup is awaitable in
// tests; Chrome itself ignores a listener's return value here.
chrome.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));

// ---------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "get-state") {
    const tabId = sender.tab && sender.tab.id;
    isActive(tabId)
      .then((active) => sendResponse({ active }))
      .catch(() => sendResponse({ active: false }));
    return true;
  }

  if (msg && msg.type === "download") {
    const { url, filename } = msg;
    console.log("[ImageSaver:bg] download requested", { url, filename, tab: sender.tab && sender.tab.id });
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

// ---------------------------------------------------------------- badges

chrome.runtime.onStartup.addListener(syncAllBadges);
chrome.runtime.onInstalled.addListener(syncAllBadges);

// Re-apply badges for tabs still marked active, and drop entries whose tab has
// gone. The surviving entries are collected first and written back once: doing
// a write per dead tab from the same stale copy of the map would undo the
// previous iteration's cleanup.
async function syncAllBadges() {
  const map = await getMap();
  const alive = {};
  for (const tabIdStr of Object.keys(map)) {
    const tabId = Number(tabIdStr);
    try {
      await chrome.action.setBadgeText({ tabId, text: "ON" });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#16a34a" });
      alive[tabId] = true;
    } catch (e) {
      console.log("[ImageSaver:bg] dropping stale tab", tabId);
    }
  }
  if (Object.keys(alive).length !== Object.keys(map).length) await putMap(alive);
}
