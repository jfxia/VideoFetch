# Microsoft Edge Add-ons — English listing

Each field below corresponds to an entry in the Partner Center form, already within its length limit and ready to paste.

## Name (45 characters max)

```
VideoFetch — Video Downloader
```

## Short description (132 characters max)

```
Save HLS, live and MP4 streams a page is playing. Parallel segment download, pause and resume, merged into a single file.
```

Count: 121 characters.

## Detailed description (10,000 characters max)

```
VideoFetch downloads the media a page is currently playing. The extension observes the media requests the page itself makes and identifies the stream addresses the player uses: HLS playlists, live streams, plain MP4 files, and media handed to MSE players only through a blob URL. Downloading and remuxing take place locally in the extension; no proxy server is involved.

1. SUPPORTED MEDIA

1.1 HLS (m3u8): the master playlist is parsed and every declared variant is listed with its resolution and bitrate, the highest being selected by default. EXT-X-BYTERANGE segments and AES-128 encrypted segments are supported.

1.2 Live streams: a playlist without ENDLIST is recorded segment by segment; the user decides when recording ends.

1.3 Plain files: MP4, WEBM and audio URLs. When the server accepts Range requests the file is fetched in 4 MB chunks in parallel; otherwise it falls back to a single streamed request.

1.4 Streams with separate audio: an audio rendition declared through EXT-X-MEDIA is downloaded separately and merged back onto the video timeline. For MSE players that use two SourceBuffers, both tracks are recorded and joined afterwards.

1.5 Hotlink-protected resources: for CDNs that validate Referer, the extension attaches the originating site to its own download requests, and verifies the rule with a short range request before relying on it.

2. DOWNLOAD AND REMUX

Segments are fetched concurrently and delivered in playlist order, then joined locally. MPEG-TS segments are converted to fMP4 and assembled together with fMP4 segments into a single MP4 file whose timeline starts at zero, playable in standard players.

3. PAUSE AND RESUME

Pausing stops new requests immediately and aborts in-flight requests after 400 ms; downloaded segments and the current cursor are retained. Resuming continues from the cursor, and completed segments are not fetched again. The playlist and keys are read again on resume, so a change of variant or key does not shift the output.

4. SAVING FILES

A finished download is written to the browser download folder, optionally into a subfolder. A folder elsewhere on the disk can be selected once on the settings page, after which files are written there directly; if that permission lapses, downloads fall back to the download folder and the task reports where the file was actually saved.

While a download is running, the progress so far can be written to a separate file whose name carries the completed percentage, for example "clip (40%).mp4". The task itself remains active and the remainder can be downloaded later. Existing files are not overwritten; a sequence number is appended instead.

5. INTERFACE LANGUAGE

English by default. When the browser language is Chinese, interface text, task states and error messages are shown in Chinese. Either language can be pinned on the settings page.

6. LIMITATIONS

6.1 DRM-protected content (Widevine, FairPlay, SAMPLE-AES) is not supported and returns an error.

6.2 Remuxing supports H.264 video with AAC or MP3 audio; TS streams encoded with HEVC or AC3 are saved as .ts without conversion.

6.3 Blob recording captures data while the media plays, with a limit of roughly 400 MB per task.

6.4 Live tasks must be stopped manually; segments produced while paused cannot be recovered.

6.5 Pause state is kept in the extension's background context and is lost when the extension is reloaded.

6.6 Some sites use short-lived signed segment URLs, so a long pause may cause resumption to fail.

6.7 Download only content you have the right to keep.
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
3. `screenshot-3-settings-en.png` — save location and interface language

## Promotional tiles

| Size | File |
|---|---|
| 300×300 (store logo) | `icon-300.png` |
| 440×280 (small tile) | `promo-small-440x280.png` |
| 1400×560 (large tile) | `promo-large-1400x560.png` |

## Package

`VideoFetch-<version>.zip` from the repository root. `_dev/` and `_shots/` are excluded by `_dev/build.py`.
