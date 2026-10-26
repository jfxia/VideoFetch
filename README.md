# VideoFetch

English · [简体中文](README.zh-CN.md)

A Manifest V3 extension for Edge and Chrome. It downloads the media a page is already playing: HLS playlists, live streams, plain MP4 files, and media that reaches the player only as a `blob:` URL.

<img src="docs/screenshot-1-sources-en.png" width="720" alt="Video source list with a quality picker">

## Features

- **Source discovery**: four channels feed the list: response headers read through `webRequest`, hooks on the page's `fetch` and `XHR`, manifests carried in JSON API responses, and Resource Timing as a last resort. A site that hides its player from one channel usually appears in another.
- **Parallel download**: HLS segments are fetched eight at a time and delivered in playback order. TS segments are remuxed to fMP4 with mux.js; fMP4 segments are concatenated directly. Plain files are fetched in 4 MB chunks when the server accepts `Range`.
- **Audio**: renditions declared through `EXT-X-MEDIA` are downloaded separately and merged back onto the video timeline. Where a site serves video and audio as two files, the paired HLS playlist is fetched to obtain the audio. MSE players that append to two `SourceBuffer`s are recorded on both tracks and joined afterwards. Feeds that label an AAC stream as HE-AAC while giving the extension rate as equal to the core rate are corrected to the codec the bitstream actually carries: the samples hold no SBR data, and a player following the label would decode them on a path the data does not support.
- **Pause and resume**: pausing stops new requests immediately and aborts those in flight after 400 ms; downloaded segments and the cursor are retained. Resuming continues from the cursor. *Save* writes the progress so far to a second file (`clip (40%).mp4`) and leaves the task active.
- **Opening the result**: a finished download or a saved snapshot opens with the system default program straight from its task card. If the file has since been moved, the button falls back to locating it in the download list.
- **Live streams**: a playlist without `#EXT-X-ENDLIST` is treated as live and polled at its target duration. Recording ends when the user stops it.
- **Encryption and edge cases**: AES-128 segment keys are fetched and applied, `EXT-X-BYTERANGE` is honoured, servers that ignore `Range` are handled by trimming locally, and CDNs that require a `Referer` receive a session DNR rule verified with a one-byte range request before the download starts.
- **Save location**: the browser download folder with an optional subfolder, or any folder selected once on the settings page. Files of the same name are numbered `(2)` rather than overwritten.
- **Interface language**: English by default, Chinese when the browser language is Chinese. Either can be pinned in settings.

<img src="docs/screenshot-2-tasks-zh.png" width="720" alt="Download tasks, one running and one paused with a saved snapshot">

## Install

### Loading the unpacked build

1. Run `python _dev/build.py`, or unpack a release archive
2. Open `edge://extensions/` (Chrome: `chrome://extensions/`)
3. Enable **Developer mode**
4. Choose **Load unpacked** and select `dist/`
5. Reload the page to be downloaded; content scripts run only at page load

### Store

The listing is prepared but not published yet. The link will be added here once it is available.

## Usage

1. Play the video briefly. The list fills as the page requests media.
2. Open the popup. Each video appears as one card; the qualities of the same video are collected into a single dropdown, highest first.
3. Select a quality and choose **Download**.
4. Switch to **Downloads** to follow progress. Every task provides pause, resume and save; live tasks provide **Stop and save** only.
5. Files are written to `Downloads/VideoFetch/` unless changed in **Settings** at the bottom right.

The **Diagnostics** panel reports whether the page hooks are installed, how many requests were inspected, and which media-like URLs were rejected. It is the first place to look when a site yields no sources.

## Build

```bash
python _dev/build.py
```

The script copies the source into `dist/`, checks that every path referenced by `manifest.json` exists, and packs `VideoFetch-<version>.zip`. `_dev/` and `_shots/` are excluded from the package.

## Tests

No test framework is used; each suite is a Node script with its own assertions. `_dev/serve.mjs` serves the fixtures with `Range` support, and `?delay=` or `?rate=` reproduces a slow link when timing behaviour has to be checked.

```bash
node _dev/serve.mjs 8898        # fixtures at http://127.0.0.1:8898/player.html

node _dev/test-e2e.mjs          #  38  playlist parsing, remuxing, decryption
node _dev/test-engine.mjs       #  62  full engine runs against a mocked chrome API
node _dev/test-merge.mjs        #  41  fMP4 audio merging
node _dev/test-popup.mjs        #  77  source list, quality picker, task buttons, English UI
node _dev/test-settings.mjs     #  82  subfolder normalisation, settings, i18n, folder writing
node _dev/test-sniff.mjs        #  11  background sniffing and attribution
node _dev/test-inject.mjs       #   8  page hooks in a VM sandbox
node _dev/test-referer.mjs      #  23  referer decisions against a fake fetch
node _dev/test-pause.mjs        #  82  pause, resume, snapshot saving on slow fixtures
```

424 checks in total. The fixtures are real media generated with ffmpeg, plus one CMAF set taken from a live HLS feed to cover the split-audio path.

## How it works

| Piece | Role |
|---|---|
| `background/service-worker.js` | Sniffs requests, owns the per-tab list and the task table, routes messages, drives the offscreen document |
| `content/inject.js` | MAIN world. Hooks `fetch`, `XHR`, `createObjectURL` and `MediaSource` |
| `content/content.js` | ISOLATED world. Forwards events, carries recorded bytes back to the extension |
| `offscreen/engine.js` | The download engine: concurrency, live polling, decryption, remuxing, writing files |
| `lib/m3u8.js`, `lib/remux.js`, `lib/mp4time.js` | Playlist parsing, TS to fMP4 assembly, timestamp normalisation and `moov` duration patching |
| `lib/store.js` | Segment staging, OPFS first with an in-memory fallback |
| `lib/settings.js`, `lib/fsdir.js`, `lib/i18n.js` | Save location, folder handles, both language tables |

Three implementation decisions are worth recording:

- **Downloads run in an offscreen document**: a service worker is recycled and has no DOM, so it cannot create the Blob URL that `chrome.downloads` requires.
- **Timestamps are preserved, then shifted**: `setBaseMediaDecodeTime` in mux.js 6.3 has no effect on this path because segment timestamps overlap, so the remuxer keeps the original PTS and `lib/mp4time.js` shifts `tfdt` afterwards.
- **Blob sources are captured at `SourceBuffer`**: whatever the player does, media data passes through `appendBuffer`, which is the only hook independent of site internals.

## Known limits

- **DRM is not supported**: Widevine, FairPlay and `SAMPLE-AES` streams return an error.
- **HEVC and AC3 in TS** are saved as `.ts`, as mux.js handles H.264 with AAC or MP3 only.
- **Blob recording captures only what has played**, up to roughly 400 MB, and cannot be paused.
- **Live streams must be stopped manually**; a paused live recording loses the part that was not captured.
- **Live audio renditions are not merged** at present, so a live recording may end up silent.
- **Pause state is held in the background context**: reloading the extension discards the cursor and the task has to start over.
- **Discovery requires a page load**: after installing or reloading the extension, refresh the tab. Privileged pages such as `chrome://` and the extension stores are not supported.
- **A custom folder requires one gesture**: the picker opens only from the settings page. If the permission lapses, downloads fall back to the browser folder and the task reports where the file was actually saved.
- **Saving produces a snapshot, not a completed file**: each save copies the progress so far and occupies temporary space in OPFS.
- **Ranged resume depends on the server**: files that ignore `Range` restart from zero, and an MP4 with `moov` at the end cannot play after truncation.

## Screenshots

The two images above live in `docs/`. They are rendered, not drawn: `_dev/make-store-art.py` captures the real popup pages at 2× and composes them onto a 1280×800 canvas. The same script also produces the Edge Add-ons listing material — icon, promotional tiles, listing copy, privacy policy — into `store/`, which stays on the machine and is not committed.

## Licence

MIT, see [LICENSE](LICENSE). The bundled `vendor/mux.min.js` is Apache-2.0, © Video.js contributors.
