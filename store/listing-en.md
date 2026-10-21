# Microsoft Edge Add-ons — English listing

Every field below matches what the Partner Center form asks for. Length limits are noted; the strings are already inside them.

## Name (45 characters max)

```
VideoFetch — Video Downloader
```

## Short description (132 characters max)

```
Save HLS, live and MP4 video a page is playing. Parallel downloads, pause and resume, one clean file.
```

Count: 108 characters.

## Detailed description (10,000 characters max)

```
VideoFetch watches the media requests a page is already making and hands you the stream behind the player: HLS playlists, live feeds, plain MP4, even players that only expose a blob URL.

Downloading is the part most extensions skip. VideoFetch pulls eight segments at a time, keeps them in order, and merges them into a single MP4 you can play anywhere. Separate audio tracks are fetched and put back with the video, so split streams no longer come out silent.

WHAT IT HANDLES
• HLS (m3u8) — reads the master playlist, offers each quality, defaults to the highest
• Live streams — records while it plays, you decide when to stop
• Plain MP4, WEBM and audio — 4 MB ranged chunks when the server allows it
• AES-128 encrypted segments — key fetched and decrypted on the fly
• Separate audio renditions and dual-track MSE players — audio is merged back in
• Referer rules for CDNs that refuse a request without one

PAUSE, RESUME, SAVE
Pause takes effect as soon as you click it: no new segments, in-flight requests are cut after 400 ms, and the segment cursor stays where it was. Resume continues from that cursor. "Save" writes what you have so far to a second file named like "clip (40%).mp4" and leaves the task running, so you can keep going.

WHERE FILES GO
The browser download folder (with an optional subfolder), or any folder you pick once from the settings page. Nothing is uploaded anywhere; the whole pipeline runs on your machine.

LANGUAGE
English by default. If your browser is set to Chinese, the interface, the task labels and the error messages switch to Chinese. You can pin either one in settings.

GOOD TO KNOW
• DRM (Widevine, FairPlay, SAMPLE-AES) is not supported and reports an error instead of failing silently.
• TS streams encoded with HEVC or AC3 are saved as .ts; the remuxer only handles H.264 with AAC or MP3.
• Blob recording captures what has played, up to roughly 400 MB.
• Live streams have to be stopped by hand. Pausing a live stream means the missed part is gone.
• Pause state lives in the extension's background page: reloading the extension loses it.
• Some sites sign segments with short-lived tokens; resuming after a long pause may fail.
• Only download what you have the right to keep.
```

## Search terms (7 max, 30 characters each)

```
hls downloader
m3u8 downloader
video downloader
live stream recorder
mp4 downloader
save web video
video saver
```

## Category

```
Productivity
```

## Support and links

| Field | Value |
|---|---|
| Support contact | https://github.com/jfxia/VideoFetch/issues |
| Website | https://github.com/jfxia/VideoFetch |
| Privacy policy | https://github.com/jfxia/VideoFetch/blob/main/store/privacy-policy.md |
| Mature content | No |
| In-app purchases | No |

## Screenshots (1280×800, upload in this order)

1. `screenshot-1-sources-en.png` — the source list with quality picker
2. `screenshot-2-tasks-zh.png` — download tasks, one running, one paused with a snapshot
3. `screenshot-3-settings-en.png` — where files go and interface language

## Promotional tiles

| Size | File |
|---|---|
| 300×300 (store logo) | `icon-300.png` |
| 440×280 (small tile) | `promo-small-440x280.png` |
| 1400×560 (large tile) | `promo-large-1400x560.png` |

## Package

`VideoFetch-<version>.zip` from the repository root. `_dev/` and `_shots/` are excluded by `_dev/build.py`.
