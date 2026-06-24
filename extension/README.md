# HomePod A/V Sync

A browser extension that makes web video watchable while the audio plays on the
HomePod. The HomePod's AirPlay audio is ~2.5 s behind real time and that can't
be removed, so this **delays the picture by the same amount** to match it. The
video's audio is never touched - it keeps flowing live to Windows -> Wave Link
-> HomePod streamer.

## Supported players

Works on any site with a standard HTML5 `<video>` element - **YouTube, Plex,**
and most web players. It automatically picks the **largest playing video** on
the page and overlays it.

Works only on non-DRM video. Netflix/Disney+ (and Plex titles with DRM) block
frame capture, so the delayed picture would be black there - the approach can't
work on protected content.

## How it works

- Finds the largest playing `<video>`, overlays a canvas on it, and shows each
  frame ~2.5 s late (ring buffer of recent frames).
- The real `<video>` keeps playing (just visually hidden), so its audio is
  unaffected and reaches the HomePod live.
- The panel auto-appears when a video is on the page; the **toolbar button**
  shows/hides it anywhere (e.g. to reach the HomePod control on a music page).
- Settings (delay / on-off / hidden) are shared across all sites via extension
  storage - tune once, applies everywhere (the HomePod delay is the same
  regardless of source).

## Load it in Zen / Firefox (for testing)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on...**
3. Select `manifest.json` in this folder
   (the `extension/` folder of this repo)
4. Click the extension's **toolbar button** to open the controls popup.

> Temporary add-ons are removed when the browser restarts. That's fine for
> testing. For permanent install see below.

## Use it

1. Start the HomePod streamer (`Start-HomePodStream.bat`) so audio goes to the
   HomePod, and make sure the browser/YouTube is up on the Wave Link Stream Mix.
2. Play a video (YouTube, Plex, etc.). The picture is now delayed to match.
3. Watch someone talking and use the panel's **-50 / +50 / -250 / +250**
   buttons until the lips match the HomePod audio. Default is 2.50 s. The value
   is shared across all sites.
4. The value is remembered. **ON/OFF** toggles the effect (off = normal live
   picture).

### Disabling the extension on specific sites

The popup shows the **current site's hostname** with a **Disable here / Enable
here** button. Click "Disable here" to add the site to a blacklist - the
extension won't run there (no capture, no hiding the video). It matches the host
and any subdomain (adding `example.com` covers `www.example.com`). The blacklist
is shared across all tabs and applies live (no reload needed).

### The controls (toolbar popup)

The controls live in a normal browser-action **popup** (click the extension's
toolbar button), not injected into the page - so site styles can't break them.
The popup has the delay readout + tune buttons, a **Sync** toggle, and a
**HomePod** connect/disconnect toggle. Settings are saved and applied live to
whatever video is playing.

> In Zen/Firefox the button may sit in the extensions (puzzle-piece) menu. Open
> that menu and pin "HomePod A/V Sync" to the toolbar for one-click access.

### Connect / disconnect the HomePod from the panel

The panel has a **HomePod: connected / disconnected** button that starts and
stops the audio streamer without leaving the browser. It needs the local control
server running:

1. Start `Start-HomePodServer.bat` (in the parent `HomePodStream` folder). Keep
   its window open, or set it to autostart at login.
2. The panel button now reflects and controls the connection:
   - **disconnected — connect** -> click to start streaming to the HomePod
   - **connected — disconnect** -> click to stop
   - **server off** -> the control server isn't running; start the .bat

How it works: the button asks the extension's background script, which calls the
local server (`http://127.0.0.1:17645`, token-protected) that owns the streamer
process. A browser extension can't launch a local process directly, hence the
small server. It's bound to localhost only and start/stop require a shared token,
so other websites can't control your HomePod.

### Choosing which HomePod (scan)

The popup has a **Device** line and a **Scan** button. Click **Scan** to find the
AirPlay/HomePod devices on your network, then click one to select it. The choice
is saved in `homepod_config.json` and used for every stream, so it works with any
HomePod/AirPlay speaker - not just a hardcoded one. If you're connected when you
pick a new device, it reconnects to it automatically. "Device: default" means no
selection (the streamer's built-in default is used).

## Making it permanent

Temporary add-ons vanish on restart. Two options:

- **Edge (easiest, no signing):** open `edge://extensions`, turn on Developer
  mode, click **Load unpacked**, select this folder. It stays installed. (Use
  Edge for HomePod-YouTube sessions.)
- **Zen/Firefox (signed):** sign the extension for self-install with Mozilla's
  `web-ext sign` (needs a free AMO account + API keys), which produces an
  installable `.xpi`. Ask and I'll walk through it.

## Subtitles

Players draw subtitles at *live* time, so they'd run ~2.5 s ahead of the delayed
picture/audio. The extension delays them to match, handling three rendering
mechanisms:

- **textTracks** (most HTML5 players, YouTube captions) - suppresses the native
  track and re-draws cues on the delayed canvas.
- **DOM subtitles** (Plex / libjass) - buffers the element's HTML and shows a
  delayed clone, re-anchored to the live position so it rides with the controls.
- **Canvas subtitles** (jassub / SubtitlesOctopus on anime sites) - bakes the
  subtitle canvas into the delayed frame at capture time and hides the live one.

If a player uses something else (or a worker-rendered canvas we can't read),
the subs stay live/unsynced rather than disappearing - tell me which site and
I'll add a targeted fix.

## Tuning notes

- The right delay = your measured HomePod audio lag. If you lowered/raised the
  streamer's `--latency-ms`, re-tune here to match.
- Memory use scales with delay x resolution; capture is capped at 30 fps and
  1280 px wide to keep it reasonable. Adjust `CFG` at the top of `content.js`
  if you want higher quality (more RAM) or lower (less).
- If the delayed picture looks soft, raise `CFG.maxWidth` (e.g. to 1920).
