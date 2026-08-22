# Image Saver — Chrome Extension Design

Date: 2026-08-22

## Purpose

A Chrome extension that lets the user hover over elements containing an image
while in "active" mode and download that image with one click. Clicking the
toolbar icon toggles active mode; while active, hovering an element that
contains an image pops a thumbnail popover with a download button.

## Decisions (confirmed with user)

1. **Download flow**: Clicking download saves the image **immediately** to the
   browser's default Downloads folder. No per-download prompt.
2. **Popover scope**: One thumbnail per element — the element's single most
   prominent image (its own `<img>`, or the widest/largest descendant `<img>`).
3. **Image detection**: Detect `<img>` tags **and** CSS `background-image`
   elements, plus `<picture>/<source srcset>` variants.

## Architecture

Manifest V3 extension composed of:

- **Content script** — injected into every page. Always present but only active
  while a per-tab "active" flag is on. Owns hover detection and the popover UI.
- **Service worker (background)** — listens for a `download` message and calls
  `chrome.downloads.download(...)`. Downloads must happen here because the page
  cannot programmatically download cross-origin images.

### Activation

- Clicking the toolbar icon toggles active mode for the current tab.
- State is stored in `chrome.storage.session` (per-session) so a mode set
  persists while the tab is open; the background sets a badge/text "ON" on the
  icon when active and clears it otherwise.
- Mode is per-tab; other tabs are unaffected.

### Hover detection (content script)

- While active, the script listens for `mouseover`/`mouseout` at the document
  level (capture phase) so dynamic content is covered, and uses a small debounce
  to avoid flashing popovers on fast mouse passes.
- For the hovered element it resolves its single prominent image by priority:
  1. Element's own `<img>` / `<picture>`.
  2. Largest visible descendant `<img>` (by rendered area: width × height).
  3. CSS `background-image` (computed style), falling back to pseudo
     elements `::before`/`::after`.
  4. Otherwise, no image → no popover.
- `srcset` / `picture > source` are resolved to the best applicable source via
  the browser's intrinsic image selection (naturalWidth / currentSrc).

### Popover

- A small floating thumbnail with a download button, rendered as a fixed,
  high-z-index overlay so it never disrupts page flow and follows the hovered
  element's bounding rect on the cursor side.
- Shows the resolved thumbnail and derives a filename from the URL.
- Auto-dismisses on mouseout, scroll, or a short timeout.

### Download (service worker)

- Popover download button sends `{ type: 'download', url, filename }`.
- Background receives it and calls `chrome.downloads.download({ url, filename })`.
- On failure (blocked/CORS/network), it replies with an error status so the
  popover can show a brief "Couldn't download" state.

## Files

- `manifest.json` — MV3, permissions: `activeTab`, `storage`, `downloads`.
- `content.js` — hover detection + popover UI + prominent-image resolution.
- `background.js` — service worker; toggles state on click, handles downloads.
- `icons/` — 16/48/128 PNG icons.
- `README.md` — how to load unpacked + usage.

## Error handling

- Ignore tiny "tracking" images (e.g. 1×1) and obviously non-image payloads.
- Show an inline "Couldn't download" state in the popover on failure.
- Guard against SVG data-URIs and invalid URLs (skip download attempt).

## Testing

Manual verification against a page with: plain `<img>`, CSS background images,
`<picture>/srcset`, and a cross-origin hotlinked image. Confirm: toggle on/off
via icon, single prominent image per element, download lands in Downloads. Also verify popovers don't appear when not
active.