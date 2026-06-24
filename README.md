# HomePod A/V Sync

Use an **Apple HomePod (or any AirPlay speaker)** as a speaker for your **Windows
PC**, and keep **web video in sync** with it.

AirPlay audio plays ~2.5 s behind real time and that delay can't be removed, so a
companion browser extension **delays the on-screen video by the same amount** to
match the sound. Works on YouTube, Plex, anime sites, and most HTML5 players.

> **Platform:** the audio side is **Windows-only** (uses WASAPI/DirectShow capture
> and Windows process control). The browser extension targets **Firefox / Zen**
> (and works in Chromium/Edge). DRM-protected video (Netflix, etc.) can't be
> delayed - the browser blocks frame capture.

There are two halves:

| Half | What it does |
|------|--------------|
| **Audio streamer** (Python) | Captures a Windows audio device and streams it to the HomePod over AirPlay (via [pyatv](https://pyatv.dev) + ffmpeg). A small local HTTP server lets the extension start/stop it and scan for HomePods. |
| **Browser extension** | Delays the page's video to match the audio, syncs subtitles, and gives you a popup to connect/disconnect, pick the HomePod, tune the delay, and disable per-site. |

You can use the extension's video-delay on its own, but the HomePod connect/scan
buttons need the local server running.

## Project layout

```
homepod-av-sync/
├─ extension/         Browser extension (load this in Firefox/Zen/Edge)
│  ├─ manifest.json   background.js  content.js  popup.html  popup.js
│  └─ icons/          icon.svg (adaptive) + icon-white.svg
├─ server/            Windows audio side (Python)
│  ├─ homepod_server.py        Local control server (scan/start/stop)
│  ├─ homepod_stream.py        Captures audio -> streams to HomePod
│  ├─ atvremote_lowlatency.py  Low-latency pyatv wrapper
│  ├─ requirements.txt
│  └─ Start-*.bat / Tune-Latency.bat   Manual launchers
├─ Install.bat / Uninstall.bat   One-click setup (-> setup.ps1 / uninstall.ps1)
├─ build-extension.ps1           Zips the extension for signing/distribution
└─ README.md  LICENSE
```

---

## Prerequisites

- **Windows 10/11**
- **Python 3.9+** on PATH (`python --version`)
- **ffmpeg** on PATH (`ffmpeg -version`) - `winget install ffmpeg` or https://ffmpeg.org
- **A HomePod / AirPlay speaker** on the same network
- **A virtual audio device** to route what you want to the HomePod. Either:
  - **Elgato Wave Link** (capture its *Stream Mix*), or
  - **[VB-Audio Virtual Cable](https://vb-audio.com/Cable/)** (capture *CABLE Output*)
- **Firefox or Zen** (or Chromium/Edge)

## Setup

1. **Double-click `Install.bat`.** It checks Python/ffmpeg, installs the Python
   deps, and registers the control server to auto-start (hidden) at every login.
   Runs in your user session - a real Windows Service can't reach audio devices
   (they're per-session). No admin needed. Remove any time with `Uninstall.bat`.

   *Prefer manual?* `pip install -r server/requirements.txt`, then run
   `server\Start-HomePodServer.bat` (visible window) when you want it.

2. **Install the extension** (see [Installing the extension](#installing-the-extension)).
3. **Pick your HomePod**: open the popup -> **Scan** -> click your device.
4. **Pick the audio source**: open the popup -> **Audio** -> click the capture
   device to stream (e.g. the Wave Link *Stream Mix* or
   *CABLE Output (VB-Audio Virtual Cable)*). Both choices persist in
   `server/homepod_config.json`.

## Installing the extension

The source lives in **`extension/`** (`manifest.json` at its root).

- **Temporary (quickest, dev):** Firefox/Zen -> `about:debugging#/runtime/this-firefox`
  -> **Load Temporary Add-on** -> select `extension/manifest.json`.
  *Removed when the browser restarts.*
- **Permanent on Edge/Chromium:** `edge://extensions` -> Developer mode ->
  **Load unpacked** -> select the `extension` folder. Stays installed.
- **Permanent on Firefox/Zen (signed):** Firefox only runs signed add-ons
  permanently. Sign it for self-distribution (free):
  ```powershell
  npm install -g web-ext
  web-ext sign --source-dir extension --channel unlisted `
    --api-key <JWT_ISSUER> --api-secret <JWT_SECRET>
  ```
  Get API credentials at <https://addons.mozilla.org/developers/addon/api/key/>.
  This produces a signed `.xpi` (attach it to a GitHub Release); install it via
  `about:addons` -> gear -> **Install Add-on From File**.

`build-extension.ps1` zips the extension into `dist/` for uploading/signing.

## Using it

Open the toolbar popup:
- **Delay** + tune buttons - adjust until lips match the HomePod.
- **Sync** - turn the video delay on/off.
- **HomePod** - connect/disconnect the audio stream (needs the server).
- **Device** + **Scan** - find and select which HomePod to use.
- **Audio** - list and select which capture device to stream from.
- **Disable here / Enable here** - blacklist the current site (per-host, live).

The streamer also has standalone scripts in `server/`:
`Start-HomePodStream.bat` (stream without the extension) and `Tune-Latency.bat`
(find your lowest stable latency).

## How sync works (and its limits)

- The extension captures each video frame into a ~2.5 s ring buffer and draws it
  back delayed onto an overlay canvas; the real `<video>` stays hidden but keeps
  playing so its audio reaches the HomePod live.
- Subtitles are delayed too (textTracks, Plex/libjass DOM, and jassub/Octopus
  canvas subs are all handled).
- **Won't work on:** DRM-protected media (Netflix/Disney+, some Plex titles) -
  the browser returns black frames. **YouTube ambient mode** also breaks capture,
  so the extension auto-disables it while syncing.
- Latency is inherent to AirPlay (~2.5 s); fine for music, and matched for video.

## Configuration

- **Capture quality/FPS:** `CFG.maxWidth` (1920) and `CFG.maxCaptureFps` (60) at
  the top of `extension/content.js`. Higher = sharper/smoother but more RAM
  (~1.3 GB at 1080p60). Drop to 1280/30 for ~280 MB.
- **Server port / token:** `server/homepod_server.py` (`PORT`, `TOKEN`) must
  match `SERVER`/`TOKEN` in `extension/background.js`. The token only stops other
  local pages from poking the localhost server; change it if you like.
- **Latency / device / bitrate:** top of `server/homepod_stream.py` (or CLI
  flags; `python server\homepod_stream.py --help`).

## Troubleshooting

- **Popup says "server off" / scan fails:** the control server isn't running -
  run `Install.bat` (or `server\Start-HomePodServer.bat`). Verify at
  `http://127.0.0.1:17645/status`.
- **Video is black on a site:** DRM-protected media (can't capture) - use
  **Disable here**. On YouTube, ambient mode is handled automatically.
- **No audio on HomePod:** check the capture device
  (`python server\homepod_stream.py --list`) and that audio is actually routed
  to it (Wave Link Stream Mix / VB-Cable), or pick it in the popup's **Audio** list.
- **Lag:** lower `CFG.maxWidth`/`maxCaptureFps`.

## License & credits

MIT - see `LICENSE`. Uses pyatv (MIT) and ffmpeg (LGPL/GPL).

Toolbar icon: "HomePod" by **James Henry** from the [Noun Project](https://thenounproject.com)
(noun-homepod-1600397), adapted to the toolbar theme via `context-fill`.
