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
// content.js only shows the popover once the pointer has been at rest for
// DWELL_MS (200). Tests wait a bit longer than that.
const DWELL_WAIT = 300;

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
// jsdom doesn't decode images, so naturalWidth/naturalHeight are always 0.
function setNatural(el, w, h) {
  Object.defineProperty(el, "naturalWidth", { configurable: true, value: w });
  Object.defineProperty(el, "naturalHeight", { configurable: true, value: h });
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
setNatural(main, 1200, 800);
setNatural(small, 64, 64);
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
const btn = host && host.querySelector(".is-download");
const copyBtn = host && host.querySelector(".is-copy");
const statusEl = host && host.querySelector(".is-status");
const dimsEl = host && host.querySelector(".is-dims");
const isVisible = () => pop && pop.style.display === "block";
function pressKey(key, target) {
  const ev = new window.KeyboardEvent("keydown", {
    key, bubbles: true, cancelable: true,
  });
  (target || document).dispatchEvent(ev);
  return ev;
}

(async () => {
  assert(!!host, "content script injected #__imageSaverHost__ overlay");
  assert(!!pop && !!btn && !!copyBtn, "popover + Download/Copy buttons exist in the overlay");

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
  assert(!isVisible(), "popover does NOT appear immediately on hover");
  // Keep moving over the same image: the dwell deadline keeps getting pushed
  // back, so the popover must stay hidden while the pointer is in motion.
  for (let i = 0; i < 4; i++) { move(150 + i, 60); await sleep(60); }
  assert(!isVisible(), "popover stays hidden while the mouse keeps moving");
  // Now stop.
  await sleep(DWELL_WAIT);
  assert(isVisible(), "popover appears after the pointer rests over the image");
  assert(popImg.getAttribute("src") === "https://example.com/photo1.jpg",
    "thumbnail src matches the image under the cursor");
  assert(nameEl.textContent === "photo1.jpg", "filename derived: photo1.jpg");
  assert(dimsEl.textContent === "1200 \u00d7 800",
    "intrinsic resolution shown under the filename (1200 x 800)");
  assert(dimsEl.style.display === "block", "resolution line is visible");
  assert(!btn.disabled, "Download button enabled");
  const pos1 = pop.style.left + "/" + pop.style.top;
  // Move within the image: popover stays anchored (does NOT chase the cursor,
  // otherwise the Download button would be impossible to click).
  move(30, 30);
  await sleep(10);
  assert(isVisible(), "popover stays visible while cursor stays over the same image");
  assert(pop.style.left + "/" + pop.style.top === pos1,
    "popover position is stable (anchored) while over the same image");

  // --- Cursor BELOW the image, still inside the same card ---------------
  pointTarget = label;
  move(150, 200);
  await sleep(500); // wait out the 350ms grace period
  assert(!isVisible(), "no popover when cursor is below the image (sibling, not over it)");

  // --- Small image ------------------------------------------------------
  pointTarget = small;
  move(350, 30);
  await sleep(DWELL_WAIT);
  assert(isVisible(), "popover shows for the small standalone image");
  assert(popImg.getAttribute("src") === "https://example.com/thumb.gif",
    "small image src used: thumb.gif");
  assert(dimsEl.textContent === "64 \u00d7 64",
    "resolution follows the newly shown image (64 x 64)");

  // --- Non-image element -------------------------------------------------
  pointTarget = text;
  move(360, 120);
  await sleep(500); // wait out the 350ms grace period
  assert(!isVisible(), "no popover on an element with no image");
  assert(dimsEl.style.display === "none", "resolution line cleared when the popover hides");

  // --- Deeper-level walk: a child of a container whose parent contains ---
  // an image COVERING the cursor still resolves it (walk-up).
  // (label#label is a child of card1, but its rect is outside main's rect, so
  //  no popover. To test true deeper cover, point at a child INSIDE main.)
  setRect(text, rect(10, 10, 90, 90)); // text overlapping main's area
  pointTarget = text;
  move(50, 50);
  await sleep(DWELL_WAIT);
  // main's rect covers (50,50); walking from #text -> #card1 finds main.
  assert(isVisible(), "deep nesting: cursor over an overlaid child still finds the covered image");

  // --- Switching to a DIFFERENT image restarts the cycle ----------------
  // The old popover must be dismissed at once (so it stops covering the page)
  // and the new one must wait for the pointer to come to rest again.
  const prevSrc = popImg.getAttribute("src");
  pointTarget = small;
  move(350, 30);
  await sleep(10);
  assert(!isVisible(), "moving onto another image hides the previous popover immediately");
  await sleep(DWELL_WAIT);
  assert(isVisible(), "popover reappears for the new image after the pointer rests");
  assert(popImg.getAttribute("src") === "https://example.com/thumb.gif" &&
    prevSrc !== popImg.getAttribute("src"),
    "the reappeared popover shows the NEW image");
  const posSmall = pop.style.left + "/" + pop.style.top;
  move(352, 32);
  await sleep(DWELL_WAIT);
  assert(pop.style.left + "/" + pop.style.top === posSmall,
    "the new popover is anchored too (stops following the mouse)");

  // Back to the big image so the remaining tests use a stable target.
  pointTarget = text;
  move(50, 50);
  await sleep(DWELL_WAIT);
  assert(isVisible() && popImg.getAttribute("src") === "https://example.com/photo1.jpg",
    "switched back to the first image");

  // --- Moving ONTO the popover keeps it (doesn't hide) ------------------
  // Now that popover visible, point at the popover's button.
  pointTarget = btn;
  move(Number(pop.style.left.replace("px", "")) + 10, Number(pop.style.top.replace("px", "")) + 10);
  await sleep(10);
  assert(isVisible(), "moving onto the popover keeps it visible");

  // --- Click Download ----------------------------------------------------
  let downloadMsg = null;
  let downloadCount = 0;
  chrome.runtime.sendMessage = (msg, cb) => { downloadMsg = msg; downloadCount++; cb({ ok: true }); };
  btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert(downloadMsg && downloadMsg.type === "download",
    "clicking Download sends a download message");
  assert(downloadMsg.url === "https://example.com/photo1.jpg",
    "download message carries the shown image url");

  // A second click for the same url within the dedupe window is suppressed, so
  // two injected copies of content.js can't double-download one user action.
  const afterFirst = downloadCount;
  btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert(downloadCount === afterFirst, "repeat click for the same url is deduped");

  // --- 'd' hotkey --------------------------------------------------------
  await sleep(600); // past the 500ms dedupe window
  downloadMsg = null;
  const ev = pressKey("d");
  assert(downloadMsg && downloadMsg.type === "download" &&
    downloadMsg.url === "https://example.com/photo1.jpg",
    "pressing 'd' downloads the image shown in the popover");
  assert(ev.defaultPrevented, "'d' hotkey prevents the page default");

  // Modified keystrokes belong to the browser/page (Ctrl+D = bookmark).
  await sleep(600);
  downloadMsg = null;
  document.dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "d", ctrlKey: true, bubbles: true, cancelable: true,
  }));
  assert(!downloadMsg, "Ctrl+D is ignored by the hotkey");

  // Typing in a field must never trigger a download.
  downloadMsg = null;
  const input = document.createElement("input");
  document.body.appendChild(input);
  input.focus();
  pressKey("d", input);
  assert(!downloadMsg, "'d' typed into an <input> is ignored");
  input.remove();

  // --- Copy: image bytes readable -> the bitmap goes on the clipboard ---
  // navigator.clipboard / ClipboardItem / fetch don't exist in jsdom, so stub
  // them and assert on what the code hands to write().
  let written = null, writtenText = null, fetchCalls = 0;
  let fetchImpl = () => Promise.resolve({
    ok: true, blob: () => Promise.resolve({ type: "image/png" }),
  });
  window.fetch = (u) => { fetchCalls++; return fetchImpl(u); };
  window.ClipboardItem = function (items) { this.items = items; };
  window.navigator.clipboard = {
    // The real write() resolves the promise it is handed, so a failed fetch
    // must surface as a rejected write() — otherwise the URL fallback would
    // never be exercised.
    write: async (items) => {
      await Promise.all(Object.values(items[0].items));
      written = items;
    },
    writeText: async (t) => { writtenText = t; },
  };

  written = writtenText = null;
  await sleep(600); // past the dedupe window
  pressKey("c");
  await sleep(50);
  assert(!!written && written.length === 1, "pressing 'c' writes to the clipboard");
  assert(!!written[0].items["image/png"], "'c' puts the image on the clipboard as image/png");
  assert(!writtenText, "'c' does not fall back to text when the bytes are readable");
  assert(statusEl.textContent === "Image copied", "status confirms the image was copied");

  // --- Copy: bytes unreadable (CORS) -> falls back to copying the URL ----
  written = writtenText = null;
  fetchImpl = () => Promise.reject(new Error("CORS"));
  await sleep(600);
  pressKey("c");
  await sleep(50);
  assert(writtenText === "https://example.com/photo1.jpg",
    "when the image bytes can't be read, 'c' copies the URL instead");
  assert(statusEl.textContent === "Link copied", "status says the link was copied");

  // --- Copy button click works too --------------------------------------
  writtenText = null;
  await sleep(600);
  copyBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(50);
  assert(writtenText === "https://example.com/photo1.jpg", "clicking Copy copies as well");

  // --- Ctrl/Cmd+C must stay with the browser ----------------------------
  written = writtenText = null;
  await sleep(600);
  document.dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "c", ctrlKey: true, bubbles: true, cancelable: true,
  }));
  await sleep(20);
  assert(!written && !writtenText, "Ctrl+C is left to the browser");

  // --- Focused fields disable BOTH hotkeys ------------------------------
  const cases = [
    ["input", (el) => { el.type = "text"; }],
    ["textarea", () => {}],
    ["select", () => {}],
    ["div", (el) => { el.setAttribute("contenteditable", "true"); }],
    ["div", (el) => { el.setAttribute("role", "textbox"); el.tabIndex = 0; }],
    ["div", (el) => { el.setAttribute("role", "searchbox"); el.tabIndex = 0; }],
  ];
  for (const [tag, prep] of cases) {
    const el = document.createElement(tag);
    prep(el);
    document.body.appendChild(el);
    el.focus();
    const label = tag + (el.getAttribute("role") ? "[role=" + el.getAttribute("role") + "]" :
      el.getAttribute("contenteditable") ? "[contenteditable]" : "");
    downloadMsg = null; written = writtenText = null;
    await sleep(600);
    const dEv = pressKey("d", el);
    const cEv = pressKey("c", el);
    await sleep(30);
    assert(!downloadMsg && !written && !writtenText,
      "focus in " + label + " disables both hotkeys");
    assert(!dEv.defaultPrevented && !cEv.defaultPrevented,
      "focus in " + label + " leaves the keystroke to the page");
    el.remove();
  }

  // --- Travel far from images -> popover hides after grace --------------
  pointTarget = nogroup;
  move(380, 90);
  await sleep(600); // > 350ms grace
  assert(!isVisible(), "popover hidden after moving away from images");

  // With nothing shown, the hotkey is a no-op.
  await sleep(600);
  downloadMsg = null;
  pressKey("d");
  assert(!downloadMsg, "'d' does nothing while no popover is shown");

  // --- OFF mode ---------------------------------------------------------
  pointTarget = main;
  broadcast({ type: "set-active", active: false });
  move(100, 40);
  await sleep(DWELL_WAIT);
  assert(!isVisible(), "no popover while mode is OFF");
  downloadMsg = null;
  pressKey("d");
  assert(!downloadMsg, "'d' does nothing while mode is OFF");

  // --- Dual injection idempotent ----------------------------------------
  new window.Function("chrome", "window", "document", "Element", "getComputedStyle",
    contentSrc)(chrome, window, document, window.Element, window.getComputedStyle);
  const hostCount = document.querySelectorAll("#__imageSaverHost__").length;
  assert(hostCount === 1, "second injection reuses the overlay (host count " + hostCount + ")");
  assert(host.querySelectorAll(".is-download").length === 1, "only one Download button");
  assert(host.querySelectorAll(".is-copy").length === 1, "only one Copy button");

  console.log(failed === 0 ? "\nALL TESTS PASSED" : `\n${failed} TEST(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();