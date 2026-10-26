# VideoFetch

English · [简体中文](README.zh-CN.md)

A Manifest V3 extension for Edge and Chrome. It downloads what a page is playing: HLS playlists, live streams, plain MP4 files, and media that reaches the player only as a `blob:` URL. Segments are assembled into one file on disk.

<img src="docs/screenshot-1-sources-en.png" width="720" alt="Video source list with a quality picker">

## Features

- **Finding the source**: Open a page that is playing video and the popup lists what it finds. The qualities of one video sit in a single dropdown, highest first. Sites load video in different ways, so several places are watched at once. A site that closes one of them is usually still visible through another.
- **One file out**: Segments are fetched eight at a time and assembled in playback order as they arrive, so the download finishes as one `.mp4` that plays as it is. No second step joins anything.
- **Keeping the sound**: Plenty of sites keep picture and sound in two files. Both are fetched and put back on one timeline, so the result is not a silent video. Live streams are the exception, noted under Known limits.
- **Correcting a wrong label**: Some sites label a plain AAC track as HE-AAC. A decoder follows that label, looks for data the samples never carried, and the sound comes out dull. The label is rewritten while the file is written. The audio itself is not touched.
- **Pause and resume**: Pause stops asking the server for more and leaves what has arrived in place. Resume carries on from there rather than starting over. When something playable is needed before the end, Save writes a copy of the current progress with the percentage in its name, and the task keeps running.
- **Opening the file**: A finished download, or a snapshot saved along the way, opens with the system default player from its task card. A file that has since been moved is found by opening the download list instead.
- **Recording live**: A playlist with no end marker is treated as live. It is polled as it grows and written as it arrives, until Stop and save is pressed. Nothing else ends a live stream.
- **Encryption and hotlink checks**: Segments behind AES-128 are decrypted locally before they are written. A CDN that answers only requests from its own pages receives the right referrer, and a one-byte request confirms the server accepts it before the download begins.
- **Where files land**: `Downloads/VideoFetch/` by default, or any folder chosen on the settings page. A name already taken gets a number instead of replacing the old file.
- **Interface language**: English by default, Chinese on a Chinese browser, and either one can be pinned in settings.

<img src="docs/screenshot-2-tasks-zh.png" width="720" alt="Download tasks, one running and one paused with a saved snapshot">

## Install

### Loading the unpacked build

1. Run `python _dev/build.py`, or unpack a release archive
2. Open `edge://extensions/` (Chrome: `chrome://extensions/`)
3. Enable **Developer mode**
4. Choose **Load unpacked** and select `dist/`
5. Reload the page to be downloaded. Content scripts run only at page load

### Store

The listing is prepared but not published yet. The link will be added here once it is available.

## Usage

1. Play the video briefly. The list fills as the page requests media.
2. Open the popup. Each video appears as one card. The qualities of the same video are collected into a single dropdown, highest first.
3. Select a quality and choose **Download**.
4. Switch to **Downloads** to follow progress. Every task provides pause, resume and save. Live tasks provide **Stop and save** only.
5. Files are written to `Downloads/VideoFetch/` unless changed in **Settings** at the bottom right.

The **Diagnostics** panel reports whether the page hooks are installed, how many requests were inspected, and which media-like URLs were rejected. It is the first place to look when a site yields no sources.

## Build

```bash
python _dev/build.py
```

The script copies the source into `dist/`, checks that every path referenced by `manifest.json` exists, and packs `VideoFetch-<version>.zip`. `_dev/` and `_shots/` are excluded from the package.

## Tests

No test framework is used. Each suite is a Node script with its own assertions. `_dev/serve.mjs` serves the fixtures with `Range` support, and `?delay=` or `?rate=` reproduces a slow link when timing behaviour has to be checked.

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

The download runs in an offscreen document. A service worker is recycled after thirty seconds of inactivity and has no DOM, so it cannot create the Blob URL that `chrome.downloads` requires.

Timestamps keep their original values for the length of the download and are shifted at the end. `setBaseMediaDecodeTime` in mux.js 6.3 has no effect on this path because segment timestamps overlap, so the remuxer carries the original PTS through and `lib/mp4time.js` moves `tfdt` back to zero once the segments are assembled.

Blob sources are captured at `SourceBuffer`. Media data reaches the player through `appendBuffer` regardless of how the site builds its player, which makes it the one hook that does not depend on site internals.

## Known limits

- **DRM is not supported**: Widevine, FairPlay and `SAMPLE-AES` streams return an error.
- **HEVC and AC3 in TS**: these are saved as `.ts`, because mux.js handles H.264 with AAC or MP3 only.
- **Blob recording captures what has played**: the buffer holds roughly 400 MB at most, and the task cannot be paused.
- **A live stream needs a manual stop**: recording runs until stopped, and pausing loses the part that was not captured.
- **Live audio renditions are not merged**: a live recording may end up silent.
- **Pause state is held in the background context**: reloading the extension discards the cursor and the task has to start over.
- **Discovery requires a page load**: after installing or reloading the extension, refresh the tab. Privileged pages such as `chrome://` and the extension stores are not supported.
- **A custom folder is chosen in settings**: the picker needs a user gesture and cannot be opened from the popup. If the permission lapses, downloads fall back to the browser folder and the task reports where the file was actually saved.
- **Saving produces a snapshot, not a completed file**: each save copies the progress so far and occupies temporary space in OPFS.
- **Ranged resume depends on the server**: files that ignore `Range` restart from zero, and an MP4 with `moov` at the end cannot play after truncation.

## Screenshots

The two images above are in `docs/`, captured from the real popup pages at 2× by `_dev/make-store-art.py` and composed onto a 1280×800 canvas. The same script writes the Edge Add-ons listing material into `store/` (icon, promotional tiles, listing copy, privacy policy), which stays on the machine and is not committed.

## Licence

MIT, see [LICENSE](LICENSE). The bundled `vendor/mux.min.js` is Apache-2.0, © Video.js contributors.
