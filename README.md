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

## Loading the extension (unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked** and select this folder (`image-saver`).
4. Pin the icon if you like: click the puzzle piece in the toolbar → pin 📌.

## Files

- `manifest.json` — MV3 config; permissions `activeTab`, `storage`, `downloads`.
- `content.js` — hover detection, image resolution, popover UI.
- `background.js` — service worker: toggles mode, updates badge, downloads.
- `generate-icons.js` — script that produced `icons/icon{16,48,128}.png`.
- `icons/` — toolbar/icons.
- `test.html` — a local page to try the extension against.

## Manual test

Open `test.html` (just double-click it) or any image-rich page, turn hover mode
ON, hover the image boxes, and click Download.

## Notes / limitations

- One prominent image per element (its own `<img>` or the largest descendant).
- Tiny 1×1 "tracking" images are ignored.
- Some sites block hotlinking or cross-origin images; the download may fail and
  the popover shows "Couldn't download this image".