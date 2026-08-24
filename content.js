// Image Saver — content script.
// Runs on-demand in a page while the per-tab "active" flag is on.
//
// When active:
//  - As the mouse moves, we find the element under the cursor, walk UP through
//    its ancestors (~12 levels) looking for an image (<img> at any depth, or a
//    CSS background-image), and only when the cursor is INSIDE that image's
//    rendered rectangle do we consider it "the image under the cursor".
//  - The popover is NOT shown while the mouse is moving. It appears only after
//    the pointer has been at rest over that image for DWELL_MS. Once shown it
//    is anchored where it appeared and never follows the cursor. Moving onto a
//    DIFFERENT image dismisses it and restarts the same dwell cycle there.
//  - Pressing "d" downloads the image currently shown in the popover, and "c"
//    copies it to the clipboard. Both hotkeys stand down whenever focus is in
//    an editable field, so they never eat a keystroke meant for a text box.
//  - The download is delegated to the background service worker.
//
// NOTE: this file may be injected twice in the same page — once automatically
// by the manifest (content_scripts) and once on-demand from the background via
// chrome.scripting when the toolbar icon is clicked (so it works even on pages
// that were open before the extension was installed/reloaded). Everything is
// therefore idempotent: a second copy reuses the existing overlay instead of
// creating a duplicate.

(() => {
  "use strict";

  let active = false;

  // ---------- Debug helpers ----------
  // Lifecycle/state events are ALWAYS logged with "[ImageSaver]". Verbose
  // per-hover detail is gated behind window.__imageSaverDebug = true (set it
  // in the page console) to keep normal pages quiet.
  const DBG = () => { try { return !!window.__imageSaverDebug; } catch (e) { return false; } };
  function log(...args) { try { if (DBG()) console.log("[ImageSaver]", ...args); } catch (e) {} }
  function line(...args) { try { console.log("[ImageSaver]", ...args); } catch (e) {} }

  line("content.js injected, url =", location.href);

  // ---------- Isolated-world-safe element check ----------
  // `e.target instanceof Element` can be unreliable between the page world and
  // the extension's isolated world, so test the DOM contract instead.
  function isElement(node) {
    return !!node && typeof node === "object" && node.nodeType === 1 &&
      typeof node.tagName === "string";
  }

  // ---------- Overlay (created once, reused by any extra copies) ----------
  // The overlay markup changes between versions of this script, and the DOM
  // survives an extension reload: a page can still be holding an overlay built
  // by an OLDER copy. Reusing it would leave the new code querying for elements
  // that aren't in it. Stamp a version and rebuild when it doesn't match.
  const OVERLAY_VERSION = "3";
  const staleHost = document.getElementById("__imageSaverHost__");
  if (staleHost && staleHost.dataset.isOverlay !== OVERLAY_VERSION) {
    line("replacing an overlay built by an older version");
    staleHost.remove();
    const staleStyle = document.getElementById("__imageSaverStyle__");
    if (staleStyle) staleStyle.remove();
  }

  const host = document.getElementById("__imageSaverHost__") || (() => {
    const el = document.createElement("div");
    el.id = "__imageSaverHost__";
    el.dataset.isOverlay = OVERLAY_VERSION;
    const style = document.createElement("style");
    style.id = "__imageSaverStyle__";
    style.textContent = `
      #__imageSaverHost__ { all: initial; position: fixed; top: 0; left: 0;
        width: 0; height: 0; z-index: 2147483647;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        pointer-events: none; }
      #__imageSaverHost__ .is-pop { position: absolute; pointer-events: auto;
        background: #1f2937; color: #f9fafb; border: 1px solid #374151;
        border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.35);
        padding: 8px; width: 184px; }
      #__imageSaverHost__ .is-imgwrap { position: relative; margin-bottom: 6px; }
      #__imageSaverHost__ .is-img { display: block; max-width: 100%; max-height: 120px;
        height: auto; margin: 0 auto; border-radius: 6px; background: #111827; }
      #__imageSaverHost__ .is-actions { display: flex; gap: 6px; }
      #__imageSaverHost__ .is-btn { display: flex; align-items: center;
        justify-content: center; gap: 5px; flex: 1 1 0; min-width: 0; padding: 7px 6px;
        border: 0; border-radius: 7px; cursor: pointer; font-size: 12px;
        font-weight: 600; color: #fff; background: #16a34a; transition: background .12s; }
      #__imageSaverHost__ .is-btn:hover { background: #15803d; }
      #__imageSaverHost__ .is-btn:disabled { cursor: default; background: #4b5563; }
      #__imageSaverHost__ .is-copy { background: #374151; flex: 0 1 auto; }
      #__imageSaverHost__ .is-copy:hover { background: #4b5563; }
      #__imageSaverHost__ .is-kbd { display: inline-block; min-width: 14px;
        padding: 1px 4px; border-radius: 4px; background: rgba(0,0,0,.28);
        border: 1px solid rgba(255,255,255,.25); font-size: 10px;
        line-height: 14px; font-weight: 700; }
      #__imageSaverHost__ .is-name { font-size: 11px; color: #d1d5db;
        text-align: center; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; margin-bottom: 2px; }
      #__imageSaverHost__ .is-dims { font-size: 10px; color: #9ca3af;
        text-align: center; font-variant-numeric: tabular-nums;
        margin-bottom: 6px; }
      #__imageSaverHost__ .is-status { font-size: 11px; color: #9ca3af;
        text-align: center; margin-bottom: 4px; }
      #__imageSaverHost__ .is-status-ok { color: #4ade80; }
      #__imageSaverHost__ .is-status-err { color: #f87171; }
      #__imageSaverHost__ .is-toast { position: fixed; top: 12px; left: 50%;
        transform: translateX(-50%); z-index: 2147483647; color: #fff;
        padding: 8px 16px; border-radius: 8px;
        font: 600 13px system-ui, sans-serif;
        box-shadow: 0 4px 12px rgba(0,0,0,.35); pointer-events: none; }
    `;
    document.documentElement.appendChild(style);
    document.documentElement.appendChild(el);
    el.innerHTML = `
      <div class="is-pop" style="display:none">
        <div class="is-imgwrap"><img class="is-img" alt=""></div>
        <div class="is-name"></div>
        <div class="is-dims" style="display:none"></div>
        <div class="is-status" style="display:none"></div>
        <div class="is-actions">
          <button class="is-btn is-download">Download <span class="is-kbd">D</span></button>
          <button class="is-btn is-copy">Copy <span class="is-kbd">C</span></button>
        </div>
      </div>
      <div class="is-toast" style="display:none"></div>`;
    return el;
  })();

  const pop = host.querySelector(".is-pop");
  const imgEl = host.querySelector(".is-img");
  const nameEl = host.querySelector(".is-name");
  const dimsEl = host.querySelector(".is-dims");
  const statusEl = host.querySelector(".is-status");
  const btn = host.querySelector(".is-download");
  const copyBtn = host.querySelector(".is-copy");

  let currentUrl = null;
  let hideTimer = null;
  let gotBroadcast = false; // once the background pushes set-active, trust it over the initial get-state

  // ---------- Dwell state ----------
  // The popover only appears once the pointer has been at rest over the same
  // image for DWELL_MS. `pendingHit` is the image the cursor is currently over
  // but that hasn't earned a popover yet; pendingX/pendingY are the cursor
  // coordinates of the last mousemove, i.e. where the pointer came to rest.
  const DWELL_MS = 200;
  let dwellTimer = null;
  let pendingHit = null;
  let pendingX = 0;
  let pendingY = 0;

  // Small on-page toast so toggling gives instant visual feedback (no console
  // needed). Self-dismisses.
  let toastTimer = null;
  function showToast(text, color) {
    const t = host.querySelector(".is-toast");
    if (!t) return;
    t.textContent = text;
    t.style.background = color || "#16a34a";
    t.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.display = "none"; }, 1600);
  }

  // True when `node` is one of our own overlay elements. We must never treat
  // our own thumbnail image, button, etc. as a page image to hover.
  function isInsideHost(node) {
    return !!(node && node.nodeType === 1 && host.contains(node));
  }

  // ---------- Active-mode messaging ----------
  chrome.runtime.onMessage.addListener((msg) => {
    log("runtime.onMessage", msg);
    if (msg && msg.type === "set-active") {
      gotBroadcast = true;
      setActive(!!msg.active);
    }
  });

  // The content script doesn't know its own tab id, so it asks the background
  // for the persisted state on load. Ignored if a broadcast has already landed.
  chrome.runtime.sendMessage({ type: "get-state" }, (resp) => {
    log("get-state response", resp);
    if (!gotBroadcast) setActive(resp && resp.active ? true : false);
  });

  function setActive(on) {
    if (active === on) return;
    active = on;
    line("hover mode " + (on ? "ON" : "OFF"));
    showToast(on ? "Image Saver ON — hover an image" : "Image Saver OFF", on ? "#16a34a" : "#dc2626");
    if (!on) { cancelDwell(); hide(); }
  }

  // ---------- Image resolution ----------
  function isUsable(url) {
    if (!url || typeof url !== "string") return false;
    if (url.startsWith("data:")) {
      return /^data:image\//i.test(url);
    }
    if (/^(https?:|blob:)/i.test(url)) return true;
    return false;
  }

  function imgNaturalSize(img) {
    const w = img.naturalWidth || 0;
    const h = img.naturalHeight || 0;
    return w * h;
  }

  // Best candidate <img> for an element: its own img, else the largest
  // descendant img (excluding tracking 1x1s and data swatches).
  // Returns { url, element } where element is the actual <img> node.
  function findBestImg(element) {
    let best = null;
    if (element.tagName === "IMG" && !isInsideHost(element)) best = element;

    const imgs = element.querySelectorAll ? element.querySelectorAll("img") : [];
    log("findBestImg: element", element.tagName, "has", imgs.length, "img descendant(s)");
    for (const img of imgs) {
      if (img === element || isInsideHost(img)) continue;
      const area = imgNaturalSize(img);
      // Trackers are tiny or zero; skip obvious 1:1 pixel rats.
      if (area > 0 && area < 4) continue;
      const cur = img.currentSrc || img.src;
      if (!isUsable(cur)) continue;
      if (!best || area > imgNaturalSize(best)) best = img;
    }
    if (!best) return null;

    const src = best.currentSrc || best.src;
    if (!isUsable(src)) return null;
    return { url: src, element: best };
  }

  // CSS background image (direct + pseudos). Returns { url, element }.
  function findBackgroundImage(el) {
    // Ignore site-level backgrounds on <html>/<body>: they'd match everywhere.
    if (el === document.documentElement || el === document.body) return null;
    const cs = getComputedStyle(el);
    const urls = extractUrls(cs.backgroundImage);
    if (urls.length) return { url: urls[urls.length - 1], element: el };
    for (const p of ["::before", "::after"]) {
      const u = extractUrls(getComputedStyle(el, p).backgroundImage);
      if (u.length) return { url: u[u.length - 1], element: el };
    }
    return null;
  }

  function extractUrls(bgValue) {
    if (!bgValue || bgValue === "none") return [];
    const out = [];
    const re = /url\(\s*["']?([^"')]+)["']?\s*\)/g;
    let m;
    while ((m = re.exec(bgValue)) !== null) {
      if (isUsable(m[1])) out.push(m[1]);
    }
    return out;
  }

  // Resolve one image ({url,element}) for an element, or null.
  function resolveImage(el) {
    const byImg = findBestImg(el);
    if (byImg) return byImg;
    return findBackgroundImage(el);
  }

  // The <img> or bg element's rendered box (in viewport coordinates).
  function rectOf(imgOrEl) {
    try {
      const r = imgOrEl.getBoundingClientRect();
      return r;
    } catch (e) { return null; }
  }

  // Does a rect (viewport coords) contain point (x,y), padded by `pad` px?
  function rectContains(r, x, y, pad) {
    if (!r) return false;
    const p = pad || 0;
    return x >= r.left - p && x <= r.right + p && y >= r.top - p && y <= r.bottom + p;
  }

  // Walk up from the element under the cursor (max MAX_DEPTH levels) looking for
  // an image that visually covers the cursor. Returns {url, element} or null.
  const MAX_DEPTH = 12;
  function findImageAtPoint(x, y, under) {
    let el = under;
    for (let depth = 0; el && depth < MAX_DEPTH; depth++, el = el.parentElement) {
      if (!isElement(el) || isInsideHost(el)) continue;
      const hit = resolveImage(el);
      if (!hit) continue;
      const r = rectOf(hit.element);
      if (rectContains(r, x, y, 6)) {
        log("findImageAtPoint: hit at depth", depth, "on", el.tagName, "->", hit.url, "rect", r && (r.left + "," + r.top + " " + r.width + "x" + r.height));
        return hit;
      }
      log("findImageAtPoint: found image on", el.tagName, "but cursor outside its rect", r && (r.left + "," + r.top + " " + r.width + "x" + r.height));
    }
    return null;
  }

  // ---------- Popover ----------
  // The overlay is `position: fixed`, so we use VIEWPORT coordinates only.
  function placePopoverAt(x, y) {
    const gap = 8;
    const pw = 184 + 16; // content width + padding
    const ph = 202;      // estimated height
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x + 16;
    let top = y + 16;
    if (left + pw > vw - gap) left = x - pw - gap;
    if (top + ph > vh - gap) top = y - ph - gap;
    left = Math.max(gap, Math.min(left, vw - gap - pw));
    top = Math.max(gap, Math.min(top, vh - gap - ph));
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }

  // One status line under the thumbnail, used for both failures and the
  // short-lived "copied" confirmations. Passing no text clears it.
  let statusTimer = null;
  function setStatus(text, kind, holdMs) {
    clearTimeout(statusTimer);
    if (!text) {
      statusEl.style.display = "none";
      statusEl.textContent = "";
      return;
    }
    statusEl.textContent = text;
    statusEl.className = "is-status" + (kind ? " is-status-" + kind : "");
    statusEl.style.display = "block";
    if (holdMs) statusTimer = setTimeout(() => setStatus(null), holdMs);
  }

  // The image's intrinsic resolution, shown under the filename. For an <img>
  // that has already decoded we can read it straight off the element; for a CSS
  // background (or an <img> still loading) there is nothing to read yet, so we
  // fall back to the preview thumbnail's own load event further down.
  function setDims(w, h) {
    if (!w || !h) {
      dimsEl.style.display = "none";
      dimsEl.textContent = "";
      return;
    }
    dimsEl.textContent = w + " \u00d7 " + h;
    dimsEl.style.display = "block";
  }

  function naturalSizeOf(element) {
    if (!isElement(element) || element.tagName !== "IMG") return null;
    const w = element.naturalWidth || 0;
    const h = element.naturalHeight || 0;
    return w && h ? { w, h } : null;
  }

  // The preview <img> loads the same URL as the image being offered, so its
  // natural size is the answer for every case the element itself can't give us.
  imgEl.addEventListener("load", () => {
    if (!currentUrl) return;
    setDims(imgEl.naturalWidth, imgEl.naturalHeight);
  });
  imgEl.addEventListener("error", () => setDims(0, 0));

  function showPopover(hit, x, y) {
    if (currentUrl === hit.url && pop.style.display === "block") {
      // Same image already showing: keep the anchor exactly where it first
      // appeared. If the popover chased the cursor, it would keep running away
      // from the pointer and the Download button would be impossible to click.
      return;
    }
    line("show popover: url =", hit.url);
    imgEl.src = hit.url;
    nameEl.textContent = filenameFromUrl(hit.url);
    // Show the size immediately when the page's own <img> already knows it,
    // so the line doesn't pop in a moment later.
    const natural = naturalSizeOf(hit.element);
    setDims(natural && natural.w, natural && natural.h);
    setStatus(null);
    btn.disabled = false;
    copyBtn.disabled = false;
    currentUrl = hit.url;
    pop.style.display = "block";
    // Anchor once, right next to the cursor at the moment the popover appears.
    placePopoverAt(x, y);
  }

  // Arm (or re-arm) the dwell timer for `hit` at the current cursor position.
  // Every mousemove pushes the deadline back, so the popover can only appear
  // once the pointer actually stops.
  function armDwell(hit, x, y) {
    pendingHit = hit;
    pendingX = x;
    pendingY = y;
    clearTimeout(dwellTimer);
    dwellTimer = setTimeout(() => {
      dwellTimer = null;
      if (!active || !pendingHit) return;
      showPopover(pendingHit, pendingX, pendingY);
    }, DWELL_MS);
  }

  function cancelDwell() {
    clearTimeout(dwellTimer);
    dwellTimer = null;
    pendingHit = null;
  }

  function hide() {
    log("hide popover");
    cancelDwell();
    pop.style.display = "none";
    imgEl.removeAttribute("src");
    setDims(0, 0);
    currentUrl = null;
    btn.disabled = false;
    copyBtn.disabled = false;
    setStatus(null);
  }

  function scheduleHide(ms) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, ms);
  }

  function filenameFromUrl(url) {
    try {
      const u = new URL(url);
      const last = u.pathname.split("/").filter(Boolean).pop();
      const clean = last ? decodeURIComponent(last) : "image";
      const safe = clean.replace(/[^a-zA-Z0-9._-]+/g, "_");
      return safe || "image";
    } catch (e) {
      return "image";
    }
  }

  // ---------- Download ----------
  // Guard state lives on the host element (not in this closure) so that a
  // second injected copy of this script shares it: both copies see the same
  // click/keydown and would otherwise run the action twice for one user
  // gesture. Keyed by action so a copy doesn't suppress a following download.
  const DEDUPE_MS = 500;
  function alreadyRequested(action, url) {
    const last = host.__isLastAction;
    const now = Date.now();
    if (last && last.action === action && last.url === url && now - last.at < DEDUPE_MS) {
      return true;
    }
    host.__isLastAction = { action, url, at: now };
    return false;
  }

  function requestDownload() {
    log("download requested, currentUrl =", currentUrl);
    if (!currentUrl) return;
    if (pop.style.display !== "block") return;
    if (alreadyRequested("download", currentUrl)) {
      log("duplicate download suppressed for", currentUrl);
      return;
    }
    const filename = filenameFromUrl(currentUrl);
    btn.disabled = true;
    chrome.runtime.sendMessage(
      { type: "download", url: currentUrl, filename },
      (resp) => {
        log("download response", resp, "lastError", chrome.runtime.lastError && chrome.runtime.lastError.message);
        const err = chrome.runtime.lastError;
        btn.disabled = false;
        if (!resp || !resp.ok || err) {
          setStatus("Couldn't download this image", "err");
        } else {
          setStatus("Saved", "ok", 1600);
        }
      }
    );
  }

  btn.addEventListener("click", requestDownload);

  // ---------- Copy ----------
  // Putting the actual image on the clipboard needs the image BYTES. We can only
  // read those when the page's own origin is allowed to: same-origin images, or
  // cross-origin ones whose host sends CORS headers. The extension holds no host
  // permissions by design, so there is no privileged fetch to fall back on —
  // when the bytes are unreadable we copy the image URL as text instead and say
  // which one happened, rather than failing silently.
  //
  // Chrome's clipboard only accepts image/png, so anything else is re-encoded
  // through a canvas. The canvas is fed from the fetched blob, not from the
  // page's <img>, so it is never tainted.
  async function toPngBlob(blob) {
    if (blob.type === "image/png") return blob;
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      return await canvas.convertToBlob({ type: "image/png" });
    } finally {
      bitmap.close();
    }
  }

  async function imageAsPng(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("http " + resp.status);
    return toPngBlob(await resp.blob());
  }

  async function requestCopy() {
    log("copy requested, currentUrl =", currentUrl);
    if (!currentUrl) return;
    if (pop.style.display !== "block") return;
    if (alreadyRequested("copy", currentUrl)) {
      log("duplicate copy suppressed for", currentUrl);
      return;
    }
    const url = currentUrl;
    copyBtn.disabled = true;
    try {
      if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
        throw new Error("clipboard api unavailable");
      }
      // ClipboardItem is handed the PENDING promise on purpose: awaiting the
      // fetch first would spend the user activation before write() is called.
      const png = imageAsPng(url);
      png.catch(() => {}); // the ClipboardItem owns the real rejection
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      setStatus("Image copied", "ok", 1600);
    } catch (e) {
      log("image copy failed, falling back to the url:", e && e.message);
      try {
        await navigator.clipboard.writeText(url);
        setStatus("Link copied", "ok", 1600);
      } catch (e2) {
        log("url copy failed:", e2 && e2.message);
        setStatus("Couldn't copy this image", "err");
      }
    } finally {
      copyBtn.disabled = false;
    }
  }

  copyBtn.addEventListener("click", requestCopy);

  // ---------- Hotkeys ----------
  // "d" downloads and "c" copies whatever the popover is currently showing.
  //
  // Both stand down completely while focus is in an editable field, so typing
  // "d" into a search box never triggers a download. Modified keystrokes are
  // left alone too, so Ctrl/Cmd+D still bookmarks and Ctrl/Cmd+C still copies
  // the page selection.
  const EDITABLE_ROLES = ["textbox", "searchbox", "combobox", "spinbutton"];

  function isTypingTarget(node) {
    if (!isElement(node)) return false;
    if (node.isContentEditable) return true;
    // isContentEditable is the right check, but it isn't universally present.
    // Fall back to the attribute, which is explicitly "false" when editing is
    // turned off for a subtree.
    const editable = node.getAttribute && node.getAttribute("contenteditable");
    if (editable !== null && editable !== undefined && editable !== "false") return true;
    const tag = node.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    // Widgets that behave like a text field without being one.
    const role = node.getAttribute && node.getAttribute("role");
    return !!role && EDITABLE_ROLES.indexOf(role.toLowerCase()) !== -1;
  }

  // document.activeElement reports the shadow HOST, not the field inside it, so
  // descend through open shadow roots to find what is really focused.
  function deepActiveElement() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
    }
    return el;
  }

  function focusIsEditable(e) {
    return isTypingTarget(e.target) || isTypingTarget(deepActiveElement());
  }

  document.addEventListener("keydown", (e) => {
    if (!active) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const isDownload = e.key === "d" || e.key === "D";
    const isCopy = e.key === "c" || e.key === "C";
    if (!isDownload && !isCopy) return;
    if (focusIsEditable(e)) {
      log("hotkey ignored: focus is in an editable field");
      return;
    }
    if (pop.style.display !== "block" || !currentUrl) return;
    e.preventDefault();
    e.stopPropagation();
    if (isDownload) {
      line("hotkey 'd' -> download", currentUrl);
      requestDownload();
    } else {
      line("hotkey 'c' -> copy", currentUrl);
      requestCopy();
    }
  }, true);

  // ---------- Pointer wiring ----------
  // Single source of truth: the cursor position. This is far more stable than
  // mouseover/mouseout (which re-target on every child change and flicker on
  // layered sites like Instagram).
  document.addEventListener("mousemove", (e) => {
    if (!active) return;
    const x = e.clientX, y = e.clientY;
    let under = null;
    try { under = document.elementFromPoint(x, y); } catch (err) { under = null; }
    // Cursor over our own popover (e.g. heading for the Download button):
    // keep showing the current image and cancel any pending hide — the user is
    // interacting with the popover right now.
    if (under && isInsideHost(under)) {
      clearTimeout(hideTimer);
      return;
    }

    const hit = findImageAtPoint(x, y, under);
    if (!hit) {
      // Not over any image: drop a pending dwell and let the popover expire.
      cancelDwell();
      scheduleHide(350); // grace period to avoid flicker while traveling
      return;
    }

    clearTimeout(hideTimer);

    // Already showing this exact image: leave it anchored where it appeared.
    if (currentUrl === hit.url && pop.style.display === "block") {
      cancelDwell();
      return;
    }

    // A different image than the one on screen: dismiss the old popover right
    // away so it stops covering the page, then restart the dwell cycle here.
    if (pop.style.display === "block") hide();

    // Still moving -> push the deadline back. The popover appears only once
    // the pointer has been at rest over this image for DWELL_MS.
    armDwell(hit, x, y);
  }, { passive: true });

  // If the pointer leaves the document entirely, hide soon.
  document.addEventListener("mouseleave", () => {
    if (!active) return;
    cancelDwell();
    scheduleHide(400);
  });

  window.addEventListener("scroll", () => {
    if (!active) return;
    cancelDwell();
    hide();
  }, { passive: true, capture: true });
})();