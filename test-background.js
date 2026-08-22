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
        broadcasts.push({ tabId, message: m });
        return true;
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

const chrome = makeChrome();
const ctx = { chrome, console, Promise, setTimeout, clearTimeout };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "background.js"), "utf8"), ctx);

(async () => {
  const tab = { id: 101 };
  const dyingTab = { id: 102 };

  // --- Toggle ON through the icon click ---------------------------------
  await callbacks.onClicked(tab);
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

  console.log(failed === 0 ? "\nALL BACKGROUND TESTS PASSED" : `\n${failed} TEST(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();