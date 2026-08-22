// Test for content.js pointer/hover logic, using jsdom.
// Loads the REAL content.js (read from disk), mocks chrome, simulates the
// background toggling "set-active", then drives the mousemove handler with a
// stubbed document.elementFromPoint + getBoundingClientRect and asserts the
// popover appears exactly when the cursor is over an image.
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
// Layout (viewport coords):
//   [0,0 300x400] card1
//     [0,0 300x200] img#main      (a real <img>)
//     [0,200 300x200] span.label  (sibling text BELOW the image)
//   [320,0 80x80] img#small       (a small but real image)
//   [320,100 80x40] div#nogroup   (no image)
const html = `<!DOCTYPE html><html><body>
  <h1>test</h1>
  <div id="card1" style="position:absolute;left:0;top:0;width:300px;height:120px">
    <img id="main" src="https://example.com/photo1.jpg" width="300" height="120"
         style="position:absolute;left:0;top:0;width:300px;height:120px">
    <span id="label" style="position:absolute;left:0;top:120px;width:300px;height:120px">below</span>
  </div>
  <img id="small" src="https://example.com/thumb.gif" width="60" height="60"
       style="position:absolute;left:320px;top:0;width:60px;height:60px">
  <div id="nogroup" style="position:absolute;left:320px;top:100px;width:80px;height:40px">
    <span id="text">nope</span>
  </div>
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
    onMessage: { addListener(fn) { setActiveHandlers.push(fn); } },
    sendMessage(msg, cb) {
      if (msg && msg.type === "get-state") cb({ active: false });
      if (msg && msg.type === "download") cb({ ok: true });
    },
  },
  storage: { session: { get() { return Promise.resolve({}); } } },
};

// --- Stub elementFromPoint: returns whatever we point it at -------------
let pointTarget = null;
document.elementFromPoint = () => pointTarget;

// --- Stub rects --------------------------------------------------------
function rect(l, t, r, b) {
  return { left: l, top: t, right: r, bottom: b, x: l, y: t, width: r - l, height: b - t, toJSON() {} };
}
function setRect(el, r) {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => r,
  });
}
const main = document.getElementById("main");
const card1 = document.getElementById("card1");
const label = document.getElementById("label");
const small = document.getElementById("small");
const nogroup = document.getElementById("nogroup");
const text = document.getElementById("text");
setRect(main, rect(0, 0, 300, 120));
setRect(card1, rect(0, 0, 300, 120));
setRect(label, rect(0, 120, 300, 240));
setRect(small, rect(320, 0, 380, 60));
setRect(nogroup, rect(320, 100, 400, 140));
setRect(text, rect(320, 100, 400, 140));

// --- Load & run the REAL content.js ------------------------------------
const contentSrc = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");
window.chrome = chrome;
window.Element = window.HTMLElement;
new window.Function("chrome", "window", "document", "Element", "getComputedStyle",
  contentSrc)(chrome, window, document, window.Element, window.getComputedStyle);

// --- Test helpers -------------------------------------------------------
function move(x, y) {
  document.dispatchEvent(new window.MouseEvent("mousemove", {
    bubbles: true, cancelable: true, clientX: x, clientY: y,
  }));
}
const host = document.getElementById("__imageSaverHost__");
const pop = host && host.querySelector(".is-pop");
const popImg = host && host.querySelector(".is-img");
const nameEl = host && host.querySelector(".is-name");
const btn = host && host.querySelector(".is-btn");
const isVisible = () => pop && pop.style.display === "block";

(async () => {
  assert(!!host, "content script injected #__imageSaverHost__ overlay");
  assert(!!pop && !!btn, "popover + button exist in the overlay");

  // --- Inactive: nothing shows regardless of cursor ----------------------
  pointTarget = main;
  move(150, 60);
  await sleep(10);
  assert(!isVisible(), "no popover before activation");

  // --- Activate via the background broadcast ----------------------------
  broadcast({ type: "set-active", active: true });
  await sleep(10);

  // --- Cursor over the <img>: popover shows, follows the image ----------
  pointTarget = main;
  move(150, 60);
  await sleep(10);
  assert(isVisible(), "cursor over the <img> shows the popover");
  assert(popImg.getAttribute("src") === "https://example.com/photo1.jpg",
    "thumbnail src matches the image under the cursor");
  assert(nameEl.textContent === "photo1.jpg", "filename derived: photo1.jpg");
  assert(!btn.disabled, "Download button enabled");
  const pos1 = pop.style.left;
  // Move within the image -> position follows the cursor
  move(30, 30);
  await sleep(10);
  assert(isVisible() && pop.style.left !== "", "popover stays visible and repositions on cursor move");

  // --- Cursor BELOW the image, still inside the same card ---------------
  pointTarget = label;
  move(150, 200);
  await sleep(500); // wait out the 350ms grace period
  assert(!isVisible(), "no popover when cursor is below the image (sibling, not over it)");

  // --- Small image ------------------------------------------------------
  pointTarget = small;
  move(350, 30);
  await sleep(10);
  assert(isVisible(), "popover shows for the small standalone image");
  assert(popImg.getAttribute("src") === "https://example.com/thumb.gif",
    "small image src used: thumb.gif");

  // --- Non-image element -------------------------------------------------
  pointTarget = text;
  move(360, 120);
  await sleep(500); // wait out the 350ms grace period
  assert(!isVisible(), "no popover on an element with no image");

  // --- Deeper-level walk: a child of a container whose parent contains ---
  // an image COVERING the cursor still resolves it (walk-up).
  // (label#label is a child of card1, but its rect is outside main's rect, so
  //  no popover. To test true deeper cover, point at a child INSIDE main.)
  setRect(text, rect(10, 10, 90, 90)); // text overlapping main's area
  pointTarget = text;
  move(50, 50);
  await sleep(10);
  // main's rect covers (50,50); walking from #text -> #card1 finds main.
  assert(isVisible(), "deep nesting: cursor over an overlaid child still finds the covered image");

  // --- Moving ONTO the popover keeps it (doesn't hide) ------------------
  // Now that popover visible, point at the popover's button.
  pointTarget = btn;
  move(Number(pop.style.left.replace("px", "")) + 10, Number(pop.style.top.replace("px", "")) + 10);
  await sleep(10);
  assert(isVisible(), "moving onto the popover keeps it visible");

  // --- Click Download ----------------------------------------------------
  let downloadMsg = null;
  chrome.runtime.sendMessage = (msg, cb) => { downloadMsg = msg; cb({ ok: true }); };
  btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert(downloadMsg && downloadMsg.type === "download",
    "clicking Download sends a download message");

  // --- Travel far from images -> popover hides after grace --------------
  pointTarget = nogroup;
  move(380, 90);
  await sleep(600); // > 350ms grace
  assert(!isVisible(), "popover hidden after moving away from images");

  // --- OFF mode ---------------------------------------------------------
  pointTarget = main;
  broadcast({ type: "set-active", active: false });
  move(100, 40);
  await sleep(10);
  assert(!isVisible(), "no popover while mode is OFF");

  // --- Dual injection idempotent ----------------------------------------
  new window.Function("chrome", "window", "document", "Element", "getComputedStyle",
    contentSrc)(chrome, window, document, window.Element, window.getComputedStyle);
  const hostCount = document.querySelectorAll("#__imageSaverHost__").length;
  assert(hostCount === 1, "second injection reuses the overlay (host count " + hostCount + ")");
  assert(host.querySelectorAll(".is-btn").length === 1, "only one Download button");

  console.log(failed === 0 ? "\nALL TESTS PASSED" : `\n${failed} TEST(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();