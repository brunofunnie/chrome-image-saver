// Image Saver — content script.
// Runs in every page but is only "active" while the per-tab flag is on.
//
// When active:
//  - On mouseover we resolve the element's single most prominent image and
//    show a floating thumbnail popover with a download button.
//  - The download is delegated to the background service worker.

(() => {
  "use strict";

  let active = false;

  // ---------- Persistent, minimal DOM injection once ----------
  // Create a single fixed-position overlay we reuse across hovers.
  const host = document.createElement("div");
  host.id = "__imageSaverHost__";
  const style = document.createElement("style");
  style.textContent = `
    #__imageSaverHost__ { all: initial; position: fixed; z-index: 2147483647;
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
  document.documentElement.appendChild(host);
  host.innerHTML = `
    <div class="is-pop" style="display:none">
      <div class="is-imgwrap"><img class="is-img" alt=""></div>
      <div class="is-name"></div>
      <div class="is-err" style="display:none">Couldn't download this image</div>
      <button class="is-btn">Download</button>
    </div>`;

  const pop = host.querySelector(".is-pop");
  const imgEl = host.querySelector(".is-img");
  const nameEl = host.querySelector(".is-name");
  const errEl = host.querySelector(".is-err");
  const btn = host.querySelector(".is-btn");

  let currentUrl = null;
  let hideTimer = null;

  // ---------- Active-mode messaging ----------
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "set-active") {
      setActive(!!msg.active);
    }
  });

  // The content script doesn't know its own tab id, so it asks the background
  // for the persisted state on load.
  chrome.runtime.sendMessage({ type: "get-state" }, (resp) => {
    setActive(resp && resp.active ? true : false);
  });

  function setActive(on) {
    active = on;
    if (!on) hide();
  }

  // ---------- Image resolution ----------
  // Small penalty: only treat genuinely usable source URLs as images.
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
    if (element.tagName === "IMG") best = element;

    const imgs = element.querySelectorAll ? element.querySelectorAll("img") : [];
    for (const img of imgs) {
      if (img === element) continue;
      const area = imgNaturalSize(img);
      // Trackers are tiny or zero; skip obvious 1x1 pixel rats.
      if (area > 0 && area < 4) continue;
      const cur = img.currentSrc || img.src;
      if (!isUsable(cur)) continue;
      if (!best || area > imgNaturalSize(best)) best = img;
    }
    if (!best) return null;

    const src = best.currentSrc || best.src;
    return isUsable(src) ? src : null;
  }

  // Resolve a CSS background image from computed style (direct + pseudos).
  function findBackgroundImage(el) {
    const cs = getComputedStyle(el);
    const urls = extractUrls(cs.backgroundImage);
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
    if (byImg) return byImg;
    return findBackgroundImage(el);
  }

  // ---------- Popover ----------
  function placePopover(target) {
    const r = target.getBoundingClientRect();
    const gap = 10;
    // Try to put it above the element; move below if it wouldn't fit.
    let left = r.left + window.scrollX;
    let top = r.top + window.scrollY;
    let above = true;

    const w = 168;
    const estimatedH = 200;
    const vh = window.innerHeight;
    if (r.top - estimatedH - gap < 0 && r.bottom + estimatedH + gap <= vh) {
      above = false;
    }

    const viewLeft = left + w;
    if (viewLeft > window.innerWidth - gap) {
      left = window.innerWidth - gap - w;
    }
    if (left < gap) left = gap;

    top = above ? r.top - estimatedH - gap : r.bottom + gap;
    if (top < gap) top = gap;
    if (top + estimatedH > vh - gap) top = vh - gap - estimatedH;

    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }

  function show(target, url, name) {
    imgEl.src = url;
    nameEl.textContent = name;
    errEl.style.display = "none";
    btn.disabled = false;
    currentUrl = url;
    pop.style.display = "block";
    placePopover(target);
  }

  function hide() {
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
    if (!currentUrl) return;
    const filename = filenameFromUrl(currentUrl);
    btn.disabled = true;
    chrome.runtime.sendMessage(
      { type: "download", url: currentUrl, filename },
      (resp) => {
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
      if (!active) return;
      const el = e.target;
      if (!(el instanceof Element)) return;
      const url = resolveImage(el);
      if (!url) {
        scheduleHide(120);
        return;
      }
      clearTimeout(hideTimer);
      show(el, url, filenameFromUrl(url));
    },
    true
  );

  document.addEventListener("mouseout", () => {
    if (!active) return;
    scheduleHide(120);
  });

  window.addEventListener("scroll", () => {
    if (active) hide();
  }, { passive: true, capture: true });

  // Keep popover from following the mouse onto unrelated elements repeatedly.
  host.addEventListener("mouseleave", () => scheduleHide(120));
})();