// Image Saver — content script.
// Runs on-demand in a page while the per-tab "active" flag is on.
//
// When active:
//  - As the mouse moves, we find the element under the cursor, walk UP through
//    its ancestors (~12 levels) looking for an image (<img> at any depth, or a
//    CSS background-image), and only when the cursor is INSIDE that image's
//    rendered rectangle we show a floating thumbnail popover next to the mouse
//    with a download button.
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
  const host = document.getElementById("__imageSaverHost__") || (() => {
    const el = document.createElement("div");
    el.id = "__imageSaverHost__";
    const style = document.createElement("style");
    style.textContent = `
      #__imageSaverHost__ { all: initial; position: fixed; top: 0; left: 0;
        width: 0; height: 0; z-index: 2147483647;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        pointer-events: none; }
      #__imageSaverHost__ .is-pop { position: absolute; pointer-events: auto;
        background: #1f2937; color: #f9fafb; border: 1px solid #374151;
        border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.35);
        padding: 8px; width: 168px; }
      #__imageSaverHost__ .is-imgwrap { position: relative; margin-bottom: 6px; }
      #__imageSaverHost__ .is-img { display: block; max-width: 100%; max-height: 120px;
        height: auto; margin: 0 auto; border-radius: 6px; background: #111827; }
      #__imageSaverHost__ .is-btn { display: flex; align-items: center;
        justify-content: center; gap: 6px; width: 100%; padding: 7px;
        border: 0; border-radius: 7px; cursor: pointer; font-size: 12px;
        font-weight: 600; color: #fff; background: #16a34a; transition: background .12s; }
      #__imageSaverHost__ .is-btn:hover { background: #15803d; }
      #__imageSaverHost__ .is-btn:disabled { cursor: default; background: #4b5563; }
      #__imageSaverHost__ .is-name { font-size: 11px; color: #d1d5db;
        text-align: center; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; margin-bottom: 6px; }
      #__imageSaverHost__ .is-err { font-size: 11px; color: #f87171;
        text-align: center; margin-bottom: 4px; }
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
        <div class="is-err" style="display:none">Couldn't download this image</div>
        <button class="is-btn">Download</button>
      </div>
      <div class="is-toast" style="display:none"></div>`;
    return el;
  })();

  const pop = host.querySelector(".is-pop");
  const imgEl = host.querySelector(".is-img");
  const nameEl = host.querySelector(".is-name");
  const errEl = host.querySelector(".is-err");
  const btn = host.querySelector(".is-btn");

  let currentUrl = null;
  let hideTimer = null;
  let gotBroadcast = false; // once the background pushes set-active, trust it over the initial get-state

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
    if (!on) hide();
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
    const pw = 168 + 16; // content width + padding
    const ph = 188;      // estimated height
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

  function showPopover(hit, x, y) {
    if (currentUrl === hit.url && pop.style.display === "block") {
      // Same image: just follow the cursor.
      placePopoverAt(x, y);
      return;
    }
    line("show popover: url =", hit.url);
    imgEl.src = hit.url;
    nameEl.textContent = filenameFromUrl(hit.url);
    errEl.style.display = "none";
    btn.disabled = false;
    currentUrl = hit.url;
    pop.style.display = "block";
    placePopoverAt(x, y);
  }

  function hide() {
    log("hide popover");
    pop.style.display = "none";
    imgEl.removeAttribute("src");
    currentUrl = null;
    btn.disabled = false;
    errEl.style.display = "none";
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
  btn.addEventListener("click", () => {
    log("Download clicked, currentUrl =", currentUrl);
    if (!currentUrl) return;
    const filename = filenameFromUrl(currentUrl);
    btn.disabled = true;
    chrome.runtime.sendMessage(
      { type: "download", url: currentUrl, filename },
      (resp) => {
        log("download response", resp, "lastError", chrome.runtime.lastError && chrome.runtime.lastError.message);
        const err = chrome.runtime.lastError;
        btn.disabled = false;
        if (!resp || !resp.ok || err) {
          errEl.style.display = "block";
        } else {
          errEl.style.display = "none";
        }
      }
    );
  });

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
    if (hit) {
      clearTimeout(hideTimer);
      showPopover(hit, x, y);
    } else {
      scheduleHide(350); // grace period to avoid flicker while traveling
    }
  }, { passive: true });

  // If the pointer leaves the document entirely, hide soon.
  document.addEventListener("mouseleave", () => {
    if (active) scheduleHide(400);
  });

  window.addEventListener("scroll", () => {
    if (active) hide();
  }, { passive: true, capture: true });
})();