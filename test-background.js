// Test for background.js (service worker) logic using a mock chrome.
// Verifies: action-onClick toggles per-tab state, sets badge, broadcasts
// set-active, answers get-state, and performs downloads.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failed++; console.error("  ✗ FAIL: " + msg); }
}

const sessionMap = {};
const badge = {}; // tabId -> text
const broadcasts = []; // {tabId,message}
let downloadCalls = [];
const callbacks = {}; // event -> fn
let injectedTabs = []; // tabIds executeScript targeted
// Tabs that currently have a live content script. An injected script does NOT
// survive a navigation, so the fake navigation helper clears the entry.
const liveScripts = new Set();
// Tabs where executeScript is refused, standing in for a page the extension
// can't touch (chrome://) or a tab whose activeTab grant has been revoked.
const blockedTabs = new Set();

function makeChrome() {
  return {
    storage: {
      session: {
        async get(k) { return { [k]: sessionMap[k] }; },
        async set(obj) { for (const k of Object.keys(obj)) sessionMap[k] = obj[k]; },
      },
    },
    action: {
      async setBadgeText(o) { badge[o.tabId] = o.text; },
      async setBadgeBackgroundColor() {},
      onClicked: { addListener(fn) { callbacks.onClicked = fn; } },
    },
    tabs: {
      async sendMessage(tabId, m) {
        // A ping only gets an answer when a content script is actually alive
        // in that tab; otherwise the real API rejects.
        if (m && m.type === "ping") {
          if (!liveScripts.has(tabId)) throw new Error("Receiving end does not exist");
          return { pong: true };
        }
        broadcasts.push({ tabId, message: m });
        if (!liveScripts.has(tabId)) throw new Error("Receiving end does not exist");
        return true;
      },
      onUpdated: { addListener(fn) { callbacks.onUpdated = fn; } },
      onRemoved: { addListener(fn) { callbacks.onRemoved = fn; } },
    },
    scripting: {
      async executeScript(o) {
        const target = o.target || {};
        if (blockedTabs.has(target.tabId)) throw new Error("Cannot access contents of the page");
        injectedTabs.push(target.tabId);
        liveScripts.add(target.tabId);
        return [];
      },
    },
    runtime: {
      onMessage: { addListener(fn) { callbacks.onMessage = fn; } },
      onStartup: { addListener(fn) { callbacks.onStartup = fn; } },
      onInstalled: { addListener(fn) { callbacks.onInstalled = fn; } },
    },
    downloads: {
      download(o) { downloadCalls.push(o); return Promise.resolve(1); },
    },
  };
}

// A navigation destroys the injected content script AND resets the tab's
// action settings -- Chrome clears tab-specific badge text and colour on
// navigation -- and then reports status "complete" for the new document.
async function navigate(tabId, stopAfterLoading) {
  liveScripts.delete(tabId);
  delete badge[tabId];
  if (!callbacks.onUpdated) return;
  await callbacks.onUpdated(tabId, { status: "loading" }, { id: tabId });
  if (stopAfterLoading) return;
  await callbacks.onUpdated(tabId, { status: "complete" }, { id: tabId });
}

const chrome = makeChrome();
const ctx = { chrome, console, Promise, setTimeout, clearTimeout };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "background.js"), "utf8"), ctx);

(async () => {
  const tab = { id: 101 };
  const dyingTab = { id: 102 };

  // --- Toggle ON through the icon click ---------------------------------
  await callbacks.onClicked(tab);
  assert(injectedTabs.includes(101), "clicking the icon injects content.js via chrome.scripting (tab 101)");
  assert(badge[101] === "ON", "icon badge shows ON after first click");
  assert(badge[1012] !== "ON", "badge NOT applied for the wrong tab");
  const sent = broadcasts.find((b) => b.tabId === 101);
  assert(sent && sent.message && sent.message.type === "set-active" && sent.message.active === true,
    "set-active true broadcast to tab 101");

  // --- Toggle OFF on second click ---------------------------------------
  // (no click; instead directly simulate via onClicked again)
  const b2 = broadcasts.length;
  await callbacks.onClicked(tab);
  assert(badge[101] === "" || badge[101] === null, "badge cleared on second click");
  const off = broadcasts.find((b, i) => i > 0 && b.tabId === 101);
  assert(off && off.message.active === false, "set-active false broadcast on toggle-off");

  // --- get-state reflects persisted on state ----------------------------
  // Turn back ON then query.
  await callbacks.onClicked(tab); // now ON
  let resp = null;
  const s = { active: undefined };
  // mimic content-script sender
  await new Promise((res) => {
    callbacks.onMessage({ type: "get-state" }, { tab: { id: 101 } }, (r) => { resp = r; res(); });
  });
  assert(resp && resp.active === true, "get-state reports active for an ON tab");

  // --- download message triggers chrome.downloads -----------------------
  downloadCalls = [];
  let dresp = null;
  await new Promise((res) => {
    callbacks.onMessage({ type: "download", url: "https://x/a.jpg", filename: "a.jpg" },
      { tab: { id: 101 } }, (r) => { dresp = r; res(); });
  });
  assert(downloadCalls.length === 1 && downloadCalls[0].url === "https://x/a.jpg" &&
    downloadCalls[0].filename === "a.jpg", "download routed to chrome.downloads.download");
  assert(dresp && dresp.ok === true, "download response ok");

  // --- invalid url is rejected ------------------------------------------
  downloadCalls = [];
  let iresp = null;
  await new Promise((res) => {
    callbacks.onMessage({ type: "download", url: "javascript:alert(1)", filename: "x" },
      { tab: { id: 101 } }, (r) => { iresp = r; res(); });
  });
  assert(downloadCalls.length === 0 && iresp && iresp.ok === false,
    "invalid (script:) url rejected without calling download");

  // --- Refreshing a tab keeps it working --------------------------------
  // The content script is injected, not declared in the manifest, so it does
  // not survive a reload. If nothing re-injects it, the badge keeps claiming
  // ON over a page where the extension is dead.
  const t = 201;
  injectedTabs = [];
  await callbacks.onClicked({ id: t });
  assert(badge[t] === "ON", "tab 201 is ON after the click");
  injectedTabs = [];
  await navigate(t);
  assert(injectedTabs.includes(t), "content.js is re-injected after a refresh");
  // Chrome wipes the tab's badge on navigation, so it isn't enough to restore
  // the content script -- the badge has to be put back or the toolbar claims
  // OFF while hover mode is actually running.
  assert(badge[t] === "ON", "badge is restored after a refresh");
  assert(sessionMap.imageSaverActive[t] === true, "per-tab state survives the refresh");

  // --- One click after a refresh turns it OFF, not ON -------------------
  // (i.e. the toggle is not left out of step by the reload)
  await callbacks.onClicked({ id: t });
  assert(badge[t] === "" || badge[t] === null,
    "a single click after a refresh turns the tab OFF");

  // --- Navigating somewhere we can no longer inject turns the mode off --
  const t2 = 202;
  await callbacks.onClicked({ id: t2 });
  assert(badge[t2] === "ON", "tab 202 is ON before navigating away");
  blockedTabs.add(t2); // e.g. a cross-origin navigation revoking activeTab
  await navigate(t2);
  assert(badge[t2] === "" || badge[t2] === null,
    "badge is cleared when the extension can no longer run in the tab");
  assert(!sessionMap.imageSaverActive[t2],
    "state is cleared when the extension can no longer run in the tab");

  // --- A tab that is OFF is never injected on navigation ----------------
  const t3 = 203;
  injectedTabs = [];
  await navigate(t3);
  assert(!injectedTabs.includes(t3), "navigating an OFF tab does not inject anything");

  // --- The badge doesn't blink off while the page loads ------------------
  const t7 = 209;
  await callbacks.onClicked({ id: t7 });
  injectedTabs = [];
  await navigate(t7, true); // stop at status "loading"
  assert(badge[t7] === "ON", "badge is back as soon as the new page starts loading");
  assert(!injectedTabs.includes(t7), "nothing is injected until the page is complete");

  // --- Closing a tab clears its state -----------------------------------
  // Otherwise the entry outlives the tab and a later tab reusing the id
  // inherits an ON state it never asked for.
  const t4 = 204;
  await callbacks.onClicked({ id: t4 });
  assert(sessionMap.imageSaverActive[t4] === true, "tab 204 is ON");
  await callbacks.onRemoved(t4, {});
  assert(!sessionMap.imageSaverActive[t4], "closing a tab clears its per-tab state");

  // --- State really is per tab ------------------------------------------
  const a = 205, b = 206;
  await callbacks.onClicked({ id: a });
  let aResp = null, bResp = null;
  await new Promise((res) => callbacks.onMessage({ type: "get-state" }, { tab: { id: a } }, (r) => { aResp = r; res(); }));
  await new Promise((res) => callbacks.onMessage({ type: "get-state" }, { tab: { id: b } }, (r) => { bResp = r; res(); }));
  assert(aResp && aResp.active === true, "tab 205 reports active");
  assert(bResp && bResp.active === false, "untouched tab 206 reports inactive");
  assert(badge[b] !== "ON", "untouched tab 206 has no badge");

  // --- Already-injected tab is not injected twice -----------------------
  // Every click used to inject another copy, stacking duplicate listeners.
  const t5 = 207;
  await callbacks.onClicked({ id: t5 }); // ON, injects
  await callbacks.onClicked({ id: t5 }); // OFF
  injectedTabs = [];
  await callbacks.onClicked({ id: t5 }); // ON again, script still alive
  assert(!injectedTabs.includes(t5),
    "a tab that still has a live content script is not injected again");

  // --- A page that cannot be injected must not claim to be ON -----------
  const t6 = 208;
  blockedTabs.add(t6);
  await callbacks.onClicked({ id: t6 });
  assert(badge[t6] !== "ON", "a page that can't be injected does not show an ON badge");
  assert(!sessionMap.imageSaverActive[t6], "a page that can't be injected is not recorded as ON");

  console.log(failed === 0 ? "\nALL BACKGROUND TESTS PASSED" : `\n${failed} TEST(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();