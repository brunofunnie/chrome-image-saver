# Chrome Web Store listing — Image Saver

Copy-paste source for the Web Store submission form. Every claim here is
verifiable against the code; keep them in sync when behaviour changes.

---

## Name

```
Image Saver — hover to preview & download
```

## Category

Productivity → Workflow & Planning

## Summary (short description, 132 char max)

```
Pause the cursor over any image to preview it, then save it with one click or the D key. No page reloads, no site access.
```

---

## Detailed description

```
Image Saver turns any image on a page into a one-keystroke download.

Turn it on for the tab you're in, park your cursor over an image, and a small
preview card appears with the filename and a Download button. Click it, or just
press D. The file lands in your Downloads folder.

That's the whole extension. No accounts, no cloud, no tracking, and no access to
your browsing.


── HOW IT WORKS ──────────────────────────────

1. Click the Image Saver toolbar icon. A green "ON" badge appears and the page
   confirms with a short toast.
2. Move the cursor over an image and stop moving. After a brief pause the
   preview card appears.
3. Click Download, or press D.
4. Click the toolbar icon again to turn it off.


── FEATURES ──────────────────────────────────

• Rest-to-reveal, not hover-to-reveal
  The card appears only once your pointer has actually come to a stop over an
  image (about a fifth of a second at rest). Cards never flash at you while
  you're just moving the mouse across a page.

• The card stays put
  Once it appears, it stays anchored where it appeared instead of chasing your
  cursor, so the Download button is always easy to hit.

• Move on, and it gets out of the way
  Slide onto a different image and the old card disappears at once. Stop again
  and a new card appears for the new image.

• Download with the D key
  Whatever the card is showing, D saves it. The hotkey stays out of your way: it
  is ignored while you're typing in a text box, and modified keystrokes are left
  alone, so Ctrl+D / ⌘+D still bookmarks the page.

• Thumbnail preview before you commit
  See the actual image the extension resolved, plus the filename it will use,
  before you save anything.

• Finds images that are hard to right-click
  Many sites bury images under transparent overlays, wrap them in link layers,
  or paint them as CSS backgrounds — all of which break "Save image as…".
  Image Saver searches upward from the element under your cursor through its
  ancestors and picks up:
    - <img> elements at any nesting depth
    - responsive images (<picture> and srcset), using the variant the browser
      actually chose for the current screen
    - CSS background-image, including ::before and ::after backgrounds
    - data: and blob: image URLs
  It confirms the cursor is genuinely inside the image's rendered box before
  offering it, so you get the image you're pointing at and not a stray banner
  somewhere else on the page.

• Sensible picking
  When an element holds several images, the largest one wins. 1×1 tracking
  pixels and other invisible spacers are skipped. Page-wide <body> and <html>
  backgrounds are ignored, since they'd otherwise match everywhere.

• Works on tabs that are already open
  The extension injects itself into the page at the moment you click the
  toolbar icon. Install it, or update it, and it works on the tabs you already
  have open — no reloading, no restarting the browser.

• Off by default, and per-tab
  Nothing runs anywhere until you switch it on, and switching it on affects only
  that one tab. Other tabs are untouched. The "ON" badge tells you exactly where
  it's live.

• Handles cross-origin images
  Downloads are performed by the extension itself rather than the page, so
  images served from a different domain than the site you're on save correctly.
  If a site blocks the download, the card says so instead of failing silently.

• Clean filenames
  The name is taken from the image URL and stripped of characters that don't
  belong in a filename. Same-name downloads are numbered rather than
  overwritten.

• Stays quiet
  The card hides when you scroll, when you leave the page, and shortly after you
  move away from an image.


── PRIVACY ───────────────────────────────────

Image Saver makes no network requests of its own. It has no analytics, no
telemetry, and no remote code. Nothing about the pages you visit, the images you
save, or anything else ever leaves your computer.

It does not request access to any website. There is no "read and change your
data on all sites" prompt, because the extension only ever touches a tab at the
moment you click its icon on that tab — that's what Chrome's activeTab
permission means.

The only thing it stores is a per-tab on/off flag, held in Chrome's session
storage and discarded when you close the browser.

The full source is available at:
https://github.com/brunofunnie/chrome-image-saver


── GOOD TO KNOW ──────────────────────────────

• Chrome does not allow extensions to run on its own pages (chrome://, the
  Chrome Web Store, and similar). Image Saver can't work there, and no toast
  will appear.
• For local file:// pages, enable "Allow access to file URLs" on the
  extension's details page.
• Images inside embedded frames on a page are not currently covered.
• Some sites block hotlinking or serve images that can't be re-fetched. When a
  download fails, the card tells you.
```

---

## Single purpose statement

```
Image Saver has one purpose: to let the user preview and download an image that
is displayed on the page they are currently viewing. All of its functionality —
locating the image under the cursor, showing a preview, and saving that image to
the user's Downloads folder — serves that single purpose.
```

## Permission justifications

| Permission | Justification |
| --- | --- |
| `activeTab` | Grants temporary access to the single tab whose toolbar icon the user clicked, which is required to inspect the page and find the image under the cursor. This is used in place of host permissions so the extension never has standing access to any site. |
| `scripting` | Used to inject the content script into the active tab at the moment the user clicks the toolbar icon. On-demand injection is what allows the extension to work on tabs that were already open before it was installed or updated, without requiring the user to reload the page. |
| `downloads` | The extension's core function is saving an image to the user's computer. `chrome.downloads.download` is called only in direct response to the user clicking the Download button or pressing the D key. |
| `storage` | Stores a single per-tab on/off flag in `chrome.storage.session` so hover mode survives service-worker restarts while the tab is open. Session storage is cleared when the browser closes. No user or page data is stored. |

Remote code: **No.** All code is bundled in the package; nothing is fetched or
evaluated at runtime.

## Data usage disclosures

Check **none** of the data collection categories. Then confirm all three
certifications:

- Does not sell or transfer user data to third parties outside of approved use cases
- Does not use or transfer user data for purposes unrelated to the item's single purpose
- Does not use or transfer user data to determine creditworthiness or for lending purposes

Rationale: the extension makes no network requests, contains no analytics, and
persists nothing beyond a per-tab boolean in session storage.

---

## Assets checklist

- [x] Icon 128×128 — `icons/icon128.png`
- [ ] Screenshots, 1280×800 or 640×400 (1–5 required). Suggested set:
  1. Preview card open over a photo on an image-heavy site, `D` key hint visible
  2. The green "ON" toast right after toggling the extension on
  3. Toolbar icon with the "ON" badge
  4. A CSS-background image being picked up on a site where right-click fails
- [ ] Small promo tile 440×280 (optional) — crop from `docs/image-saver-cover.png`
