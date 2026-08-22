# Image Saver

A Chrome (Manifest V3) extension that lets you hover over an element on any page
and download the image inside it in one click.

## How it works

1. Click the Image Saver toolbar icon to toggle **hover mode** ON (the icon gets
   an "ON" badge). Click again to turn it off. Mode is per-tab, active only in
   the tab you clicked from.
2. While ON, hover over an element that contains an image (an `<img>`, a CSS
   `background-image`, or a `<picture>/srcset`). A floating thumbnail with a
   **Download** button appears.
3. Click **Download** — the image saves straight to your default Downloads
   folder, named from its URL.

> The toolbar click injects the content script on demand (no manifest
> auto-inject), so the extension works on pages that were already open — you
> don't need to reload the page. When you toggle, a small **green/red toast**
> ("Image Saver ON/OFF") appears at the top of the page as instant confirmation
> the script is live in that tab.

## Loading the extension (unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked** and select this folder (`image-saver`).
4. Pin the icon if you like: click the puzzle piece in the toolbar → pin 📌.

## Files

- `manifest.json` — MV3 config; permissions `activeTab`, `storage`, `downloads`,
  `scripting`.
- `content.js` — hover detection, image resolution, popover UI.
- `background.js` — service worker: toggles mode, updates badge, downloads.
- `generate-icons.js` — script that produced `icons/icon{16,48,128}.png`.
- `icons/` — toolbar/icons.
- `test.html` — a local page to try the extension against.
- `test-content.js`, `test-background.js` — jsdom tests for the hover logic and
  the service worker. Run with `npm install` then `npm test`.

## Development tests

```sh
npm install     # installs jsdom (dev-only)
npm test        # runs the content-script + background test suites
npm run icons   # regenerates icons/ PNGs

## Manual test

Chrome does **not** run content scripts on `file://` pages unless you enable
"Allow access to file URLs" for the extension. So **don't test by double-clicking
`test.html`** — it will appear to do nothing.

Test against any image-rich HTTPS page instead, e.g. Unsplash or Wikipedia, or
serve the local page over HTTP:

```sh
python3 -m http.server 8123
# then open http://localhost:8123/test.html in Chrome
```

**After editing any extension file, reload the extension**: open
`chrome://extensions` and click the refresh icon on the Image Saver card, then
reload the page you're testing. Otherwise Chrome keeps the old code cached and
your fixes won't show up.

Steps: open your test page, click the Image Saver icon — a green **"Image Saver
ON"** toast appears at the top of the page — then hover an element that contains
an image, and click **Download**. (No toast on a restricted page like
`chrome://` — the extension can't run there.)

## Debugging

The content script logs lifecycle + state events with `[ImageSaver]` always, and
fine-grained hover details only when verbose debug is enabled:

1. Open the page where images aren't popuping.
2. Open DevTools (F12) → **Console**.
3. Type `window.__imageSaverDebug = true` and press Enter. (If the page source
   reloads, e.g. a SPA nav, re-set it.)
4. Toggle the extension ON — you should see `[ImageSaver] hover mode ON` in the
   **page console** (this one, not the service worker console).
5. Now hover the image. Look for `[ImageSaver]` lines:
   - `mouseover on IMG <img...>` → the hover event fires.
   - `resolveImage: <img> result for ... -> <url>` → a usable image was found.
   - `show popover: url = ...` → the popover was told to appear.
   - If you see `mouseover ignored (inactive)` then `active` is false in the
     page (toggle isn't syncing).
   - If you see `no image found for ...` then no image URL was resolved.

The service worker also logs via `chrome://extensions` → Service Workers (a
`service-worker` console). Paste the `[ImageSaver]` lines here if it's still not
working.

## Notes / limitations

- One prominent image per element (its own `<img>` or the largest descendant).
- Tiny 1×1 "tracking" images are ignored.
- Some sites block hotlinking or cross-origin images; the download may fail and
  the popover shows "Couldn't download this image".