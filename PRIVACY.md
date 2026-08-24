# Privacy Policy — Image Saver

**Effective date:** 23 August 2026
**Applies to:** the Image Saver Chrome extension (all versions)

## Summary

Image Saver does not collect, store, transmit, or sell any personal data.

It makes no network requests of its own. It contains no analytics, no telemetry,
no advertising, no tracking, no accounts, and no remote code. Nothing about you,
the pages you visit, or the images you save is ever sent anywhere.

## What the extension does with data

Everything below happens locally, inside your browser, on your machine.

### Page content

When you switch Image Saver on for a tab, it reads that page's DOM in order to
work out which image is under your cursor: the element at the pointer, its
ancestors, their `<img>` sources and their CSS `background-image` values.

This reading happens only:

- in a tab where you have explicitly clicked the toolbar icon to turn the
  extension on, and
- while that tab is switched on.

The information is used immediately to decide what to show in the preview card
and is held only in the page's memory. It is not recorded, not accumulated, and
not transmitted. It is discarded when you switch the extension off, navigate
away, or close the tab.

The extension does not request access to any website. It relies on Chrome's
`activeTab` permission, which grants access to a single tab only at the moment
you click the extension's icon on that tab. This is why installing Image Saver
does not produce a "read and change your data on all websites" prompt.

### Images you download

When you click **Download** or press **D**, the extension passes the image's URL
to Chrome's own download mechanism (`chrome.downloads`), which fetches the image
and saves it to your Downloads folder.

Two consequences worth stating plainly:

- **The website hosting the image sees that request.** Your browser fetches the
  image from its origin server exactly as it would if you clicked a normal
  download link, so that server sees the same information it would ordinarily
  see (your IP address, your user agent, and so on). The extension neither adds
  to nor conceals this.
- **Chrome records the download in its own download history**, as it does for
  any file you save. That history belongs to your browser, not to this
  extension.

The extension itself keeps no list, log, or record of what you have downloaded.

### Settings

The only thing the extension stores is a per-tab on/off flag, kept in
`chrome.storage.session`. It exists so hover mode survives a background
service-worker restart while the tab stays open.

This flag is a boolean per tab id. It contains no URLs, no page content, and
nothing about you. Chrome clears session storage when the browser closes, and
the flag is removed as soon as you switch the extension off.

The extension does not use `chrome.storage.sync`, so nothing is synced to your
Google account or to your other devices.

## What the extension does not do

- It does not collect personally identifiable information.
- It does not collect health, financial, authentication, or location data.
- It does not collect your personal communications.
- It does not record your browsing history, the URLs you visit, or your search
  terms.
- It does not track your activity across websites.
- It does not send data to the developer or to any third party.
- It does not sell or transfer data to anyone, for any purpose.
- It does not load or execute remotely hosted code.
- It does not use cookies or any advertising identifier.

## Permissions and why they exist

| Permission | Why it is needed |
| --- | --- |
| `activeTab` | Temporary access to the one tab whose icon you clicked, so the extension can find the image under your cursor. Used deliberately instead of host permissions, so the extension has no standing access to any site. |
| `scripting` | To inject the extension's script into that tab when you click the icon. This is what lets it work on tabs that were already open before you installed or updated it, without a page reload. |
| `downloads` | To save the image. Called only in direct response to you clicking Download or pressing D. |
| `storage` | To hold the per-tab on/off flag described above, in session storage. |

## Children

Image Saver is a general-purpose utility. It collects no data from anyone,
including children.

## Third parties

There are none. The extension has no back end, no SDKs, no bundled third-party
libraries, and no service providers. Its only dependency is a development-time
test library (`jsdom`), which is not shipped in the published extension.

## Changes to this policy

If the extension's behaviour ever changes in a way that affects this policy,
this file will be updated and the effective date above revised. The full history
of changes is public in the repository's commit log.

## Source code

Image Saver is open source. You can verify every statement in this policy by
reading the code:

https://github.com/brunofunnie/chrome-image-saver

## Contact

Questions about this policy, or about the extension's handling of data, can be
raised as an issue:

https://github.com/brunofunnie/chrome-image-saver/issues
