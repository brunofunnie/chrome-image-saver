// Test for content.js hover/activation logic, using jsdom.
// Loads the REAL content.js (read from disk), mocks chrome, simulates the
// background toggling "set-active", then dispatches a synthetic hover and
// asserts the popover overlay appears and gets populated.
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failed++; console.error("  ✗ FAIL: " + msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Build the page DOM ------------------------------------------------
const html = `<!DOCTYPE html><html><body>
  <h1>test</h1>
  <div id="card1" data-image="card1">
    <img src="https://example.com/photo1.jpg" width="200" height="150">
    <span class="label">a card</span>
  </div>
  <img id="plain" src="https://example.com/plain.png" width="100" height="80">
</body></html>`;

const dom = new JSDOM(html, { url: "https://example.com/page", runScripts: "outside-only" });
const { window } = dom;
const { document } = window;

// --- Mock chrome as the content script sees it --------------------------
const setActiveHandlers = [];
function broadcast(m) { setActiveHandlers.forEach((fn) => fn(m)); }
const chrome = {
  runtime: {
    id: "mockid",
    lastError: null,
    onMessage: {
      addListener(fn) { setActiveHandlers.push(fn); },
    },
    sendMessage(msg, cb) {
      if (msg && msg.type === "get-state") cb({ active: false });
      if (msg && msg.type === "download") cb({ ok: true });
    },
  },
  storage: { session: { get() { return Promise.resolve({}); } } },
};

// --- Load & run the real content.js inside the jsdom window realm -------
const contentSrc = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");
window.chrome = chrome;
window.Element = window.HTMLElement;
new window.Function("chrome", "window", "document", "Element", "getComputedStyle",
  contentSrc)(chrome, window, document, window.Element, window.getComputedStyle);

(async () => {
  // content script on load sent get-state -> active:false. Pretend the
// background broadcast set-active:true.
broadcast({ type: "set-active", active: true });

const host = document.getElementById("__imageSaverHost__");
assert(!!host, "content script injected #__imageSaverHost__ overlay");
const pop = host.querySelector(".is-pop");
const btn = host.querySelector(".is-btn");
const popImg = host.querySelector(".is-img");
const nameEl = host.querySelector(".is-name");
assert(!!pop && !!btn, "popover + button exist in the overlay");

function isVisible(el) {
  // layout in jsdom reports 'block'? We set inline style display in code.
  return pop.style.display === "block";
}

// --- Hovering a plain <img> ---------------------------------------------
const plain = document.getElementById("plain");
const initialSrc = plain.getAttribute("src");
plain.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
assert(isVisible(pop), "mouseover over <img> shows the popover");
assert(popImg.getAttribute("src") === initialSrc,
  "thumbnail src matches hovered image");
assert(nameEl.textContent === "plain.png", "filename derived: plain.png");
assert(!btn.disabled, "Download button enabled");

// --- Download button messages the background ----------------------------
let downloadMsg = null;
chrome.runtime.sendMessage = (msg, cb) => { downloadMsg = msg; cb({ ok: true }); };
btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
assert(downloadMsg && downloadMsg.type === "download" && downloadMsg.url === initialSrc,
  "Download sends {type:download, url:<image>}");
assert(downloadMsg && downloadMsg.filename === "plain.png", "filename passed");

// --- Moving onto our popover must NOT hide it ---------------------------
const out1 = new window.MouseEvent("mouseout", { bubbles: true });
Object.defineProperty(out1, "relatedTarget", { value: btn });
plain.dispatchEvent(out1);
await sleep(200);
assert(isVisible(pop), "moving onto the popover keeps it visible (no auto-hide)");

// --- Leaving back to the page hides it ----------------------------------
const out2 = new window.MouseEvent("mouseout", { bubbles: true });
Object.defineProperty(out2, "relatedTarget", { value: document.body });
plain.dispatchEvent(out2);
await sleep(200);
assert(!isVisible(pop), "moving back to the page hides the popover");

// --- Hovering a non-image element shows nothing -------------------------
document.querySelector("h1").dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
assert(!isVisible(pop), "hovering non-image element keeps the popover hidden");

// --- Mode OFF means no popover ------------------------------------------
broadcast({ type: "set-active", active: false });
plain.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
assert(!isVisible(pop), "no popover while mode is OFF");
broadcast({ type: "set-active", active: true });

// --- Hovering an element whose child is an image pops it ----------------
const card1 = document.getElementById("card1");
card1.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
assert(isVisible(pop), "hovering a container that has a child <img> pops its image");
assert(popImg.getAttribute("src") === "https://example.com/photo1.jpg",
  "child image chosen for container: " + popImg.getAttribute("src"));

// --- Dual injection (manifest + chrome.scripting) must be idempotent ------
// content.js can be injected a second time on the same page; it should reuse
// the existing overlay and not create a duplicate (so hover still works and no
// duplicate popover/buttons exist).
new window.Function("chrome", "window", "document", "Element", "getComputedStyle",
  contentSrc)(chrome, window, document, window.Element, window.getComputedStyle);
const hostCount = document.querySelectorAll("#__imageSaverHost__").length;
assert(hostCount === 1, "second injection reuses the existing overlay (host count " + hostCount + ")");
assert(host.querySelectorAll(".is-btn").length === 1, "only one Download button exists");
const card2 = document.getElementById("card1");
card2.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
assert(isVisible(pop), "hover still shows the popover after a second injection");

console.log(failed === 0 ? "\nALL TESTS PASSED" : `\n${failed} TEST(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();