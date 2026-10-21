# Privacy policy — VideoFetch

Last updated: 2026-10-21

VideoFetch is a browser extension that downloads media files from web pages. It runs entirely on your own computer. There is no server, no account, and no analytics.

## What is collected

Nothing. The extension does not collect, transmit, sell or share any personal data, browsing history, or usage statistics.

## What stays on your device

- **Media you download.** Segments are written to a temporary store inside your browser profile and merged into the final file. Temporary data is removed when the task finishes or is cancelled.
- **Settings.** Save location, subfolder and interface language are stored in the browser's local extension storage.
- **Folder permission.** If you pick a custom folder, the directory handle is stored in the browser's IndexedDB for this extension only. It is never sent anywhere.
- **Download history.** The list of tasks shown in the popup lives in the extension's background page memory and disappears when the extension is reloaded.

## Network requests

The extension requests the same media URLs that the page itself requests, plus the segment, key and playlist URLs those files point to. Requests go directly from your browser to the site that hosts the media. No proxy, no third-party service.

## Permissions and why they are needed

| Permission | Why |
|---|---|
| `webRequest` | Read response headers to tell media responses apart from ordinary traffic |
| `downloads` | Hand the finished file to the browser's download manager |
| `storage` | Keep your save-location and language settings |
| `tabs` | Know which tab a media request belongs to |
| `offscreen` | Run the download engine in a document with a stable lifetime (Manifest V3 service workers get recycled) |
| `unlimitedStorage` | Hold large temporary segment stores |
| `declarativeNetRequest` | Add a session rule so the `Referer` header matches the page origin when a CDN requires it |
| `<all_urls>` | The extension has to work on whatever page you are watching, and fetch the media it finds |

## Third parties

None. The extension bundles [mux.js](https://github.com/videojs/mux.js) (Apache-2.0) for MPEG-TS remuxing; it is executed locally and makes no network calls.

## Children

The extension is not directed at children and collects no data from anyone.

## Changes

If this policy changes, the new version will be committed to this repository with an updated date above.

## Contact

Open an issue at https://github.com/jfxia/VideoFetch/issues
