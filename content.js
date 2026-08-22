// Image Saver — content script.
// Runs in every page but is only "active" while the per-tab flag is on.
//
// When active:
//  - On mouseover we resolve the element's single most prominent image and
//    show a floating thumbnail popover with a download button.
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
        padding: 8px; width: 168px; transform: translateY(8px); }
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
    `;
    document.documentElement.appendChild(style);
    document.documentElement.appendChild(el);
    el.innerHTML = `
      <div class="is-pop" style="display:none">
        <div class="is-imgwrap"><img class="is-img" alt=""></div>
        <div class="is-name"></div>
        <div class="is-err" style="display:none">Couldn't download this image</div>
        <button class="is-btn">Download</button>
      </div>`;
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
    if (!on) hide();
  }

  // ---------- Image resolution ----------
  function isUsable(url) {
    if (!url || typeof url !== "string") return false;
    if (url.startsWith("data:")) {
      if (/^data:image\//i.test(url)) return true;
      return false;
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
  function findBestImg(element) {
    let best = null;
    if (element.tagName === "IMG" && !isInsideHost(element)) best = element;

    const imgs = element.querySelectorAll ? element.querySelectorAll("img") : [];
    log("findBestImg: element", element.tagName, "has", imgs.length, "img descendant(s)");
    for (const img of imgs) {
      if (img === element || isInsideHost(img)) continue;
      const area = imgNaturalSize(img);
      log("  candidate img src =", img.src, "current", img.currentSrc,
        "natural", img.naturalWidth + "x" + img.naturalHeight, "area", area);
      // Trackers are tiny or zero; skip obvious 1x1 pixel rats.
      if (area > 0 && area < 4) continue;
      const cur = img.currentSrc || img.src;
      if (!isUsable(cur)) continue;
      if (!best || area > imgNaturalSize(best)) best = img;
    }
    if (!best) {
      log("findBestImg: no usable <img> resolved");
      return null;
    }

    const src = best.currentSrc || best.src;
    return isUsable(src) ? src : null;
  }

  // Resolve a CSS background image from computed style (direct + pseudos).
  function findBackgroundImage(el) {
    const cs = getComputedStyle(el);
    const urls = extractUrls(cs.backgroundImage);
    log("findBackgroundImage:", el.tagName, "bg =", cs.backgroundImage, "->", urls);
    if (urls.length) return urls[urls.length - 1]; // top layer painted last
    for (const p of ["::before", "::after"]) {
      const u = extractUrls(getComputedStyle(el, p).backgroundImage);
      if (u.length) return u[u.length - 1];
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

  // Resolve the element's single prominent image (see spec priority order).
  function resolveImage(el) {
    const byImg = findBestImg(el);
    if (byImg) {
      log("resolveImage: <img> result for", el.tagName, el, "->", byImg);
      return byImg;
    }
    const bg = findBackgroundImage(el);
    if (bg) log("resolveImage: background result for", el.tagName, el, "->", bg);
    return bg;
  }

  // ---------- Popover ----------
  // The overlay (#__imageSaverHost__) is `position: fixed`, so the popover is
  // positioned in VIEWPORT coordinates — do NOT add window.scrollX/Y.
  function placePopover(target) {
    const r = target.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) {
      log("placePopover: zero-size target, skip");
      return; // hidden/collapsed
    }
    const gap = 10;
    const w = 168;
    const estimatedH = 210;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Prefer above the element; go below if that would overflow the top.
    let above = !(r.top - estimatedH - gap < 0 && r.bottom + estimatedH + gap <= vh);

    let left = r.left;
    let top = Math.max(gap, above ? r.top - estimatedH - gap : r.bottom + gap);

    left = Math.min(Math.max(gap, left), Math.max(gap, vw - gap - w));
    top = Math.min(Math.max(gap, top), Math.max(gap, vh - gap - estimatedH));

    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }

  function show(target, url, name) {
    line("show popover: url =", url, "name =", name);
    imgEl.src = url;
    nameEl.textContent = name;
    errEl.style.display = "none";
    btn.disabled = false;
    currentUrl = url;
    pop.style.display = "block";
    placePopover(target);
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
          // Flash a subtle "saved" state is optional; keep it minimal.
          errEl.style.display = "none";
        }
      }
    );
  });

  // ---------- Hover wiring ----------
  document.addEventListener(
    "mouseover",
    (e) => {
      if (!active) { log("mouseover ignored (inactive)"); return; }
      if (isInsideHost(e.target)) { log("mouseover on our overlay, ignored"); return; }
      if (!isElement(e.target)) { log("mouseover on non-Element", e.target); return; }
      const el = e.target;
      log("mouseover on", el.tagName, el);
      const url = resolveImage(el);
      if (!url) {
        log("no image found for", el.tagName, el);
        scheduleHide(150);
        return;
      }
      clearTimeout(hideTimer);
      show(el, url, filenameFromUrl(url));
    },
    true
  );

  // Don't dismiss when the pointer simply crosses from the image onto our own
  // popover (while the user reaches for the Download button).
  document.addEventListener("mouseout", (e) => {
    if (!active) return;
    const to = e.relatedTarget;
    if (isInsideHost(to)) return; // moving onto the popover: keep it visible
    scheduleHide(150);
  });

  window.addEventListener("scroll", () => {
    if (active) hide();
  }, { passive: true, capture: true });

  // If the pointer leaves the popover back onto the page, hide shortly after.
  host.addEventListener("mouseleave", () => {
    if (active) scheduleHide(150);
  });
})();