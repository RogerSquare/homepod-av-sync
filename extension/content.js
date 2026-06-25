/*
 * HomePod A/V Sync  (generic HTML5 video)
 *
 * The HomePod plays AirPlay audio ~2.5 s behind real time (buffered-audio mode),
 * and that delay can't be removed. So instead of speeding up the audio, we slow
 * down the *picture* to match: capture each video frame into a ring buffer and
 * draw it onto an overlay canvas ~2.5 s later. The real <video> keeps playing
 * (hidden) so its audio still flows live to Windows -> Wave Link -> HomePod.
 *
 * Works on any site with a normal HTML5 <video> (YouTube, Plex, etc.). It picks
 * the largest playing video on the page and overlays it. The panel auto-appears
 * when a video is present and is reachable anywhere via the toolbar button.
 *
 * Settings (delay / enabled / hidden) live in extension storage so they are
 * shared across every site, not per-origin.
 *
 * Set DEBUG=true for a red border, [hpsync] console logs, a TEST FILL button,
 * and live pixel sampling.
 */
(() => {
  "use strict";

  const DEBUG = false;
  const log = (...a) => { if (DEBUG) console.log("[hpsync]", ...a); };

  const ext = globalThis.browser ?? globalThis.chrome;
  const isYouTube = location.hostname.includes("youtube");
  const CFG = { defaultDelayMs: 2500, maxCaptureFps: 60, maxWidth: 1920, marginFrames: 8,
                minVideoW: 200, minVideoH: 150 };

  // Shared settings (extension storage, not per-origin localStorage).
  const store = { delayMs: CFG.defaultDelayMs, enabled: true, hidden: false, blacklist: [] };
  async function loadStore() {
    try {
      const o = await ext.storage.local.get(["delayMs", "enabled", "hidden", "blacklist"]);
      if (typeof o.delayMs === "number") store.delayMs = o.delayMs;
      if (typeof o.enabled === "boolean") store.enabled = o.enabled;
      else ext.storage.local.set({ enabled: store.enabled }); // persist default explicitly
      if (typeof o.hidden === "boolean") store.hidden = o.hidden;
      if (Array.isArray(o.blacklist)) store.blacklist = o.blacklist;
    } catch (e) { log("loadStore err", e); }
  }
  // Don't run on user-blacklisted sites (matches the host or any subdomain).
  function isBlocked() {
    const h = location.hostname;
    return (store.blacklist || []).some((e) => e && (h === e || h.endsWith("." + e)));
  }
  function saveStore() { try { ext.storage.local.set({ ...store }); } catch (e) { log("saveStore err", e); } }

  let video = null, detectedVideo = null, canvas = null, vctx = null, host = null;
  let subTracks = []; // native subtitle tracks we suppressed, to re-draw delayed
  let ring = null, ringCap = 0, head = 0, bufW = 0, bufH = 0;
  let lastCapT = 0, raf = null;
  let frameCount = 0, lastErr = "";
  let hideMode = "visibility", lastQ = null, lastQT = 0; // perf hide + decode-freeze fallback
  let lastBlankT = 0, blankSince = 0, blankLevel = 0; // blank-capture (overlay-path) escalation
  let useClone = false, cloneVideo = null;            // off-DOM captureStream clone (final fallback)
  let antiOverlay = false;                            // alternate the filter each frame to defeat the GPU overlay
  const unreadable = new WeakSet();                   // videos whose frames are locked in a GPU overlay - leave them live
  let testFill = false, frmSample = "?", visSample = "?";
  let forceShow = false; // toolbar opened the panel on a page with no video

  const now = () => performance.now();
  const area = (v) => { const r = v.getBoundingClientRect(); return r.width * r.height; };
  const isValid = (v) => v && document.contains(v) && v.offsetWidth > 0 && v.offsetHeight > 0;

  // ---- Video detection: largest visible, ready <video> --------------------
  function findBestVideo() {
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll("video")) {
      if (unreadable.has(v)) continue; // frames locked in a GPU overlay; can't delay it
      const r = v.getBoundingClientRect();
      if (r.width < CFG.minVideoW || r.height < CFG.minVideoH) continue;
      if (v.readyState < 1) continue;
      const a = r.width * r.height;
      if (a > bestArea) { bestArea = a; best = v; }
    }
    return best;
  }

  // ---- Ring buffer ---------------------------------------------------------
  function computeBufSize() {
    const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
    const scale = Math.min(1, CFG.maxWidth / vw);
    bufW = Math.max(2, Math.round(vw * scale));
    bufH = Math.max(2, Math.round(vh * scale));
  }
  function buildRing() {
    computeBufSize();
    ringCap = Math.ceil((store.delayMs / 1000) * CFG.maxCaptureFps) + CFG.marginFrames;
    ring = new Array(ringCap);
    for (let i = 0; i < ringCap; i++) {
      const oc = document.createElement("canvas"); // plain canvas: Gecko draws video onto it
      oc.width = bufW; oc.height = bufH;
      ring[i] = { t: -1, oc, octx: oc.getContext("2d", { alpha: false }) };
    }
    head = 0;
  }
  function flushRing() {
    if (ring) for (const e of ring) e.t = -1;
    subBuf = []; lastSubHtml = null; // drop stale subtitle snapshots too
  }

  function pickFrame(target) {
    let best = null, oldest = null;
    for (const e of ring) {
      if (e.t < 0) continue;
      if (!oldest || e.t < oldest.t) oldest = e;
      if (e.t <= target && (!best || e.t > best.t)) best = e;
    }
    return best || oldest;
  }

  function sampleCenter(ctx, w, h) {
    try { const d = ctx.getImageData((w / 2) | 0, (h / 2) | 0, 1, 1).data; return `${d[0]},${d[1]},${d[2]}`; }
    catch (e) { return "TAINTED"; }
  }

  // ---- Combined capture + render loop -------------------------------------
  function loop() {
    if (canvas && video) {
      if (!isValid(video)) { detach(); return; }
      // Re-insert if the player's framework (e.g. Plex/React) removed our canvas.
      if (!canvas.isConnected && video.parentElement) {
        if (isYouTube) video.parentElement.appendChild(canvas);
        else video.parentElement.insertBefore(canvas, video);
      }
      enforceHide();        // keep the original hidden (player may reset it)
      checkDecodeFreeze();  // fall back to opacity:0 if a player stalls decode
      checkBlankCapture();  // escalate (or give up) if frames read flat (overlay plane)
      if (!video) return;   // checkBlankCapture may have given up and detached
      const t = now();
      if (t - lastCapT >= 1000 / CFG.maxCaptureFps && !video.paused && video.videoWidth > 0) {
        lastCapT = t;
        const vw = video.videoWidth;
        const expectW = Math.max(2, Math.round(vw * Math.min(1, CFG.maxWidth / vw)));
        if (expectW !== bufW) buildRing();
        // Capture from the off-DOM clone if we escalated to it (it's never on the
        // overlay plane); otherwise straight from the page's video element.
        const cap = (useClone && cloneVideo && cloneVideo.videoWidth) ? cloneVideo : video;
        try {
          const e = ring[head];
          e.octx.drawImage(cap, 0, 0, bufW, bufH);
          compositeSubCanvas(e.octx); // bake in canvas-overlay subs (jassub/Octopus)
          e.t = t;
          if (DEBUG && frameCount % 30 === 0) frmSample = sampleCenter(e.octx, bufW, bufH);
          head = (head + 1) % ringCap;
          frameCount++;
        } catch (err) { lastErr = String(err.message || err); log("capture err", err); }
      }

      syncCanvasSize();
      if (testFill) { vctx.fillStyle = "#ff00ff"; vctx.fillRect(0, 0, canvas.width, canvas.height); }
      else {
        const frame = pickFrame(now() - store.delayMs);
        if (frame) drawContain(frame.oc);
        else { vctx.fillStyle = "#000"; vctx.fillRect(0, 0, canvas.width, canvas.height); }
        captureShowingTracks();   // suppress native subs, collect tracks
        drawDelayedSubtitle();    // re-draw them at the delayed time
        if (frameCount % 30 === 0) { setupDomSubs(); updateSubCanvas(); } // detect sub renderers
        else if (subCanvas) updateSubCanvas(); // keep the canvas-subs hidden
        renderDomSubs();          // delayed clone of custom-DOM subs
      }
      if (DEBUG) {
        drawDebugOverlay();
        if (frameCount % 30 === 0) visSample = sampleCenter(vctx, canvas.width, canvas.height);
      }
    }
    raf = requestAnimationFrame(loop);
  }

  function drawContain(src) {
    const cw = canvas.width, ch = canvas.height;
    vctx.fillStyle = "#000"; vctx.fillRect(0, 0, cw, ch);
    const s = Math.min(cw / bufW, ch / bufH);
    const dw = bufW * s, dh = bufH * s;
    try { vctx.drawImage(src, (cw - dw) / 2, (ch - dh) / 2, dw, dh); }
    catch (err) { lastErr = String(err.message || err); }
  }

  // Move any "showing" subtitle/caption track to "hidden": cues still load and
  // we can read them, but the browser stops painting them live. We then draw
  // them ourselves, delayed. (Players that render captions via their own DOM
  // instead of textTracks won't be caught here.)
  function captureShowingTracks() {
    const tracks = video.textTracks || [];
    for (let i = 0; i < tracks.length; i++) {
      const tr = tracks[i];
      if ((tr.kind === "subtitles" || tr.kind === "captions") && tr.mode === "showing") {
        tr.mode = "hidden";
        if (!subTracks.includes(tr)) subTracks.push(tr);
      }
    }
  }

  function drawDelayedSubtitle() {
    if (!subTracks.length) return;
    const dt = video.currentTime - store.delayMs / 1000;
    if (dt < 0) return;
    const parts = [];
    for (const tr of subTracks) {
      if (tr.mode === "disabled") continue; // user turned subtitles off
      const cues = tr.cues;
      if (!cues) continue;
      for (let i = 0; i < cues.length; i++) {
        const c = cues[i];
        if (c.startTime <= dt && dt <= c.endTime && c.text) parts.push(c.text);
      }
    }
    const text = parts.join("\n").replace(/<[^>]+>/g, "").trim();
    if (!text) return;
    const lines = text.split("\n");
    const fpx = Math.max(14, Math.round(canvas.height * 0.045));
    vctx.font = `600 ${fpx}px system-ui, sans-serif`;
    vctx.textAlign = "center";
    vctx.lineJoin = "round";
    let y = canvas.height - Math.round(canvas.height * 0.07);
    for (let i = lines.length - 1; i >= 0; i--) {
      const x = canvas.width / 2;
      vctx.lineWidth = Math.max(3, fpx / 5);
      vctx.strokeStyle = "rgba(0,0,0,0.9)";
      vctx.strokeText(lines[i], x, y);
      vctx.fillStyle = "#fff";
      vctx.fillText(lines[i], x, y);
      y -= fpx * 1.25;
    }
  }

  function restoreTracks() {
    for (const tr of subTracks) { try { tr.mode = "showing"; } catch (e) { /* */ } }
    subTracks = [];
  }

  // ---- Custom-DOM subtitles (e.g. Plex / libjass) -------------------------
  // Some players draw subtitles as their own DOM (libjass) instead of via
  // textTracks. We can't see those as cues, so we buffer the element's rendered
  // HTML with timestamps, hide the original, and show a delayed clone.
  let subEl = null, subClone = null, subObserver = null, subBuf = [], lastSubHtml = null, subTy = 0;
  let subCanvas = null; // canvas-overlay subtitles (jassub / SubtitlesOctopus)
  const SUB_SELECTORS = ".libjass-subs, [class*='libjass'], [class*='ibjass-subs']";

  function findSubEl() {
    for (const el of document.querySelectorAll(SUB_SELECTORS)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
    return null;
  }

  function setupDomSubs() {
    if (subEl && !document.contains(subEl)) teardownDomSubs();
    const el = findSubEl();
    if (!el || el === subEl) return;
    teardownDomSubs();
    subEl = el;
    subBuf = [{ t: now(), html: subEl.innerHTML }];
    subClone = document.createElement("div");
    subClone.id = "hpsync-subs";
    Object.assign(subClone.style, {
      position: "fixed", pointerEvents: "none", zIndex: "2147483646", overflow: "hidden",
    });
    document.documentElement.appendChild(subClone);
    subEl.style.visibility = "hidden"; // keep laid out so we can mirror its rect
    subObserver = new MutationObserver(() => {
      subBuf.push({ t: now(), html: subEl.innerHTML });
      if (subBuf.length > 600) subBuf.shift();
    });
    subObserver.observe(subEl, { childList: true, subtree: true, characterData: true, attributes: true });
    log("dom-subs attached", subEl.className);
  }

  function teardownDomSubs() {
    if (subObserver) { subObserver.disconnect(); subObserver = null; }
    if (subEl) { try { subEl.style.visibility = ""; } catch (e) { /* */ } subEl = null; }
    if (subClone && subClone.parentElement) subClone.parentElement.removeChild(subClone);
    subClone = null; subBuf = []; lastSubHtml = null; subTy = 0;
  }

  function contentRect(el) {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      if (r && r.height >= 1) return r;
    } catch (e) { /* */ }
    return null;
  }

  function renderDomSubs() {
    if (!subClone || !subEl) return;
    const r = subEl.getBoundingClientRect();
    subClone.style.left = r.left + "px";
    subClone.style.top = r.top + "px";
    subClone.style.width = r.width + "px";
    subClone.style.height = r.height + "px";
    subClone.style.fontSize = getComputedStyle(subEl).fontSize; // libjass scales by resolution
    const target = now() - store.delayMs;
    let pick = null;
    for (const s of subBuf) if (s.t <= target && (!pick || s.t > pick.t)) pick = s;
    const html = pick ? pick.html : "";
    if (html !== lastSubHtml) { subClone.innerHTML = html; lastSubHtml = html; }

    // Re-anchor vertically to the LIVE original so it rides up/down with the
    // player controls, while still showing delayed text. Throttled: each
    // contentRect() forces a synchronous layout, and subtitles don't need
    // 60 fps position updates.
    if (frameCount % 4 === 0) {
      const liveR = contentRect(subEl);
      const cloneR = contentRect(subClone);
      if (liveR && cloneR) {
        subTy += liveR.bottom - cloneR.bottom;
        subClone.style.transform = `translateY(${subTy}px)`;
      }
    }
  }

  // ---- Canvas-overlay subtitles (jassub / SubtitlesOctopus, anime sites) --
  // ASS subs on anime sites render to a <canvas> over the video (not DOM /
  // textTracks). We find that canvas, bake it into our delayed frame at capture
  // time (so it's delayed in lockstep with the picture), and hide the live one.
  function overlapArea(a, b) {
    const ow = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const oh = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return ow * oh;
  }
  const _scratch = document.createElement("canvas");
  const _sctx = _scratch.getContext("2d");
  function canReadCanvas(c) {
    // A canvas transferred to a worker (OffscreenCanvas) throws here; if so we
    // must NOT hide it, or subtitles would disappear entirely.
    try { _sctx.drawImage(c, 0, 0, 1, 1); return true; } catch (e) { return false; }
  }
  function findSubCanvas() {
    if (!video) return null;
    const vr = video.getBoundingClientRect();
    const vArea = Math.max(1, vr.width * vr.height);
    let best = null, bestScore = 0;
    for (const c of document.querySelectorAll("canvas")) {
      if (c === canvas || c.id === "hpsync-canvas") continue;
      const r = c.getBoundingClientRect();
      if (r.width < 50 || r.height < 50) continue;
      const ov = overlapArea(vr, r);
      const cls = c.className + " " + (c.parentElement ? c.parentElement.className : "");
      const known = /jassub|libass|octopus|subtitle|caption/i.test(cls);
      if (ov < vArea * 0.4 && !known) continue; // must cover most of the video, unless named
      if (!canReadCanvas(c)) continue;          // skip worker-transferred canvases
      const score = ov * (known ? 3 : 1);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }
  function updateSubCanvas() {
    const c = findSubCanvas();
    if (c !== subCanvas) {
      if (subCanvas) { try { subCanvas.style.removeProperty("visibility"); } catch (e) { /* */ } }
      subCanvas = c || null;
    }
    if (subCanvas && subCanvas.style.getPropertyValue("visibility") !== "hidden") {
      subCanvas.style.setProperty("visibility", "hidden", "important");
    }
  }
  function teardownSubCanvas() {
    if (subCanvas) { try { subCanvas.style.removeProperty("visibility"); } catch (e) { /* */ } }
    subCanvas = null;
  }
  function compositeSubCanvas(octx) {
    if (!subCanvas || !subCanvas.width || !subCanvas.height || !video.videoWidth) return;
    try {
      const vr = video.getBoundingClientRect();
      // The video content is letterboxed inside the element box (object-fit:
      // contain). Map the subtitle relative to the CONTENT rect, not the box,
      // so it isn't squished. (No letterbox -> content == box -> no change.)
      const elAR = vr.width / vr.height;
      const cAR = video.videoWidth / video.videoHeight;
      let cw, ch;
      if (cAR > elAR) { cw = vr.width; ch = vr.width / cAR; }
      else { ch = vr.height; cw = vr.height * cAR; }
      const cx = vr.left + (vr.width - cw) / 2;
      const cy = vr.top + (vr.height - ch) / 2;
      const sr = subCanvas.getBoundingClientRect();
      const sx = (sr.left - cx) / cw * bufW;
      const sy = (sr.top - cy) / ch * bufH;
      const sw = sr.width / cw * bufW;
      const sh = sr.height / ch * bufH;
      octx.drawImage(subCanvas, 0, 0, subCanvas.width, subCanvas.height, sx, sy, sw, sh);
    } catch (e) { lastErr = String(e.message || e); }
  }

  function drawDebugOverlay() {
    vctx.strokeStyle = "#ff2d2d"; vctx.lineWidth = 4;
    vctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
    vctx.fillStyle = "#00ff66"; vctx.font = "bold 15px system-ui";
    vctx.fillText(`hpsync ${canvas.width}x${canvas.height} f:${frameCount} frm:${frmSample} vw:${video.videoWidth} paused:${video.paused}`, 14, 24);
    vctx.fillText(`lvl:${blankLevel} clone:${useClone}/${cloneVideo ? (cloneVideo.videoWidth || 0) : "-"} hide:${hideMode} anti:${antiOverlay}`, 14, 98);
    const cp = canvas.parentElement ? (canvas.parentElement.className || canvas.parentElement.tagName).slice(0, 28) : "NONE";
    const vp = video.parentElement ? (video.parentElement.className || video.parentElement.tagName).slice(0, 28) : "NONE";
    vctx.fillText(`conn:${canvas.isConnected} samePar:${canvas.parentElement === video.parentElement}`, 14, 44);
    vctx.fillText(`cPar:${cp}`, 14, 62);
    vctx.fillText(`vPar:${vp}`, 14, 80);
  }

  // Hide the original so it isn't double-rendered. visibility:hidden is the
  // perf win (not painted), but some players (YouTube) stop decoding video
  // frames when the element isn't visible, which blanks our capture. So we
  // detect that and fall back to opacity:0 (still rendered, but frames flow).
  function applyHide() {
    if (!video) return;
    if (hideMode === "opacity") {
      video.style.removeProperty("visibility");
      video.style.setProperty("opacity", "0", "important");
    } else {
      video.style.removeProperty("opacity");
      video.style.setProperty("visibility", "hidden", "important");
    }
  }
  function enforceHide() {
    if (!video) return;
    if (hideMode === "visibility") {
      if (video.style.getPropertyValue("visibility") !== "hidden") applyHide();
    } else if (video.style.getPropertyValue("opacity") !== "0") applyHide();
    // Some players (YouTube, Plex) decode onto a GPU overlay plane that drawImage
    // reads as a flat color (black/grey); a near-invisible CSS filter forces the
    // video onto the normal (readable) compositing path. drawImage reads the raw
    // decoded frame, so the 0.1% brightness change doesn't alter what we capture.
    // A *static* filter isn't always enough: a window resize re-promotes the
    // video back onto the overlay. So once we've seen the overlay (antiOverlay),
    // we alternate the filter value every frame, which forces Firefox to keep
    // re-compositing it onto a readable layer and never settle back on the overlay.
    const want = antiOverlay ? `brightness(${(frameCount & 1) ? "1.001" : "1.002"})`
                             : "brightness(1.001)";
    if (video.style.getPropertyValue("filter") !== want) {
      video.style.setProperty("filter", want, "important");
    }
  }
  // If frames keep reading as a flat color while the video is playing (the
  // overlay-plane case the filter above didn't cure on its own), the element is
  // probably not being painted under visibility:hidden. Fall back to opacity:0,
  // which keeps it composited/readable. Mirrors checkDecodeFreeze().
  function frameLooksBlank(octx, w, h) {
    try {
      const pts = [[w * 0.25, h * 0.5], [w * 0.5, h * 0.5], [w * 0.75, h * 0.5],
                   [w * 0.5, h * 0.25], [w * 0.5, h * 0.75]];
      let r0 = -1, g0 = -1, b0 = -1;
      for (const [x, y] of pts) {
        const d = octx.getImageData(x | 0, y | 0, 1, 1).data;
        if (r0 < 0) { r0 = d[0]; g0 = d[1]; b0 = d[2]; }
        else if (Math.abs(d[0] - r0) > 6 || Math.abs(d[1] - g0) > 6 || Math.abs(d[2] - b0) > 6) return false;
      }
      return true;
    } catch (e) { return false; } // tainted/unreadable canvases still display - don't escalate
  }
  // Final fallback: mirror the video's decoded frames into a detached <video>
  // via captureStream(). The clone is never added to the DOM, so it can't be
  // promoted to a hardware overlay - drawImage(clone) always reads real pixels,
  // no matter what compositing path the page's own element is stuck on.
  function setupClone() {
    if (cloneVideo) return true;
    try {
      const cap = video.captureStream ? video.captureStream()
                : (video.mozCaptureStream ? video.mozCaptureStream() : null);
      if (!cap) { log("captureStream unavailable"); return false; }
      cloneVideo = document.createElement("video");
      cloneVideo.muted = true; cloneVideo.defaultMuted = true; cloneVideo.playsInline = true;
      cloneVideo.srcObject = cap; // off-DOM on purpose: keeps it off the overlay plane
      const p = cloneVideo.play(); if (p && p.catch) p.catch(() => {});
      log("clone capture via captureStream");
      return true;
    } catch (e) { lastErr = String(e.message || e); cloneVideo = null; return false; }
  }
  function teardownClone() {
    if (cloneVideo) {
      try { cloneVideo.pause(); cloneVideo.srcObject = null; } catch (e) { /* */ }
      cloneVideo = null;
    }
    useClone = false;
  }

  // Escalate while captured frames stay flat during playback:
  //   level 0: visibility:hidden + filter
  //   level 1: anti-overlay (per-frame filter) + opacity:0
  //   level 2: off-DOM captureStream clone (overlay-proof; reads real pixels)
  // We keep checking past level 1 so a later window resize can reach level 2.
  function checkBlankCapture() {
    if (!video || video.paused || !ring || !video.videoWidth || blankLevel >= 3) return;
    const t = now();
    if (t - lastBlankT < 600) return;
    lastBlankT = t;
    const e = ring[(head - 1 + ringCap) % ringCap]; // most recently captured frame
    if (!e || e.t < 0) return;
    if (frameLooksBlank(e.octx, bufW, bufH)) {
      if (!blankSince) blankSince = t;
      else if (t - blankSince > 1200) {
        blankSince = 0;
        if (blankLevel === 0) {
          blankLevel = 1; antiOverlay = true; hideMode = "opacity"; applyHide();
          log("flat capture -> anti-overlay filter + opacity:0");
        } else if (blankLevel === 1) {
          blankLevel = 2;
          useClone = setupClone(); // overlay-proof off-DOM clone
          if (useClone) { antiOverlay = false; } // reading the clone now; stop fighting the overlay
          log("flat capture persists -> captureStream clone (" + useClone + ")");
        } else {
          // Even the clone reads flat: frames are locked in a GPU hardware overlay
          // that no canvas/captureStream read can touch (Firefox DirectComposition
          // video overlay). Give up gracefully - restore the live video so the user
          // isn't stuck on grey - and point them to the one-time about:config fix.
          blankLevel = 3;
          unreadable.add(video);
          toast("Can't delay this video: Firefox's hardware video overlay hides it from capture. " +
                "One-time fix - open about:config, set gfx.webrender.dcomp-video-overlay-win to false, restart.");
          log("flat capture unrecoverable -> giving up (GPU overlay); video left live");
          detach();
        }
      }
    } else { blankSince = 0; }
  }
  function checkDecodeFreeze() {
    if (hideMode !== "visibility" || !video || video.paused) return;
    const t = now();
    if (t - lastQT < 500) return;
    lastQT = t;
    let frames = null;
    try { if (video.getVideoPlaybackQuality) frames = video.getVideoPlaybackQuality().totalVideoFrames; } catch (e) { /* */ }
    const ct = video.currentTime;
    if (lastQ && frames !== null && ct - lastQ.ct > 0.1 && frames - lastQ.frames <= 0) {
      // Timeline advancing but no new decoded frames -> hidden video stalled.
      hideMode = "opacity";
      applyHide();
      log("decode froze under visibility:hidden -> opacity:0 fallback");
    }
    lastQ = { ct, frames };
  }

  // YouTube "ambient mode" (cinematic lighting) re-renders the video into a
  // #cinematics canvas, which pushes the video onto a compositing path that
  // drawImage reads as black. Hide that renderer while we're capturing so the
  // video stays on the readable path; restore it on detach.
  function disableYouTubeAmbient() {
    if (!isYouTube || document.getElementById("hpsync-yt-ambient")) return;
    const s = document.createElement("style");
    s.id = "hpsync-yt-ambient";
    s.textContent = "#cinematics, ytd-cinematics, #cinematics-container, " +
      ".ytp-cinematics-container, #player-full-bleed-container ytd-cinematics " +
      "{ display: none !important; }";
    document.documentElement.appendChild(s);
  }
  function restoreYouTubeAmbient() {
    const s = document.getElementById("hpsync-yt-ambient");
    if (s) s.remove();
  }

  function syncCanvasSize() {
    let w, h, left, top;
    if (isYouTube) {
      // Original YouTube method: position from viewport rects (its container
      // collapses to 0 height, which breaks offset math).
      const vr = video.getBoundingClientRect(), hr = host.getBoundingClientRect();
      w = Math.max(2, Math.round(vr.width)); h = Math.max(2, Math.round(vr.height));
      left = vr.left - hr.left; top = vr.top - hr.top;
    } else {
      // Generic: offset coords (canvas is the video's sibling, same offsetParent).
      w = Math.max(2, video.offsetWidth); h = Math.max(2, video.offsetHeight);
      left = video.offsetLeft; top = video.offsetTop;
    }
    canvas.style.left = left + "px";
    canvas.style.top = top + "px";
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  // ---- Attach / detach -----------------------------------------------------
  function attach(v) {
    if (!v || v === video) return;
    detach();
    // EME/DRM-protected media draws black to canvas and can't be captured. Don't
    // hide it (that would just show a black screen) — leave the native video.
    if (v.mediaKeys) { detectedVideo = v; log("skip: DRM/EME protected video"); return; }
    video = v;
    frameCount = 0; lastErr = ""; frmSample = "?"; visSample = "?";
    log("attach", { cls: v.className, w: v.videoWidth, h: v.videoHeight });
    buildRing();

    canvas = document.createElement("canvas");
    canvas.id = "hpsync-canvas";
    Object.assign(canvas.style, {
      position: "absolute", left: "0", top: "0",
      pointerEvents: "none", background: "#000",
    });
    host = v.parentElement;
    if (!host) { lastErr = "no parent"; video = null; return; }
    if (isYouTube) {
      // Restore the original YouTube approach: append AFTER the video with a
      // high z-index (its controls live outside this container, so it's safe).
      canvas.style.zIndex = "2147483646";
      host.appendChild(canvas);
      disableYouTubeAmbient(); // ambient mode breaks drawImage capture
    } else {
      // Generic players (Plex/anime): before the video, no z-index, so the
      // player's in-container controls keep painting on top.
      host.insertBefore(canvas, v);
    }
    // desynchronized: low-latency GPU path (drawImage is already HW-accelerated).
    vctx = canvas.getContext("2d", { alpha: false, desynchronized: true });

    // Hide with visibility:hidden so the browser doesn't composite the original
    // (perf win, avoids the double-render lag). It keeps decoding frames for
    // capture; checkDecodeFreeze() falls back to opacity:0 if a player stalls
    // decode while hidden. (YouTube's earlier black was ambient mode, now killed.)
    hideMode = "visibility";
    lastQ = null; lastQT = 0;
    blankLevel = 0; blankSince = 0; useClone = false; antiOverlay = false; teardownClone();
    applyHide();
    v.addEventListener("seeking", flushRing);
    v.addEventListener("emptied", flushRing);

    lastCapT = 0;
    if (!raf) raf = requestAnimationFrame(loop);
  }

  function detach() {
    if (raf != null) { cancelAnimationFrame(raf); raf = null; }
    if (video) {
      restoreTracks();
      teardownDomSubs();
      teardownSubCanvas();
      teardownClone();
      restoreYouTubeAmbient();
      video.style.removeProperty("visibility");
      video.style.removeProperty("opacity");
      video.style.removeProperty("filter");
      video.removeEventListener("seeking", flushRing);
      video.removeEventListener("emptied", flushRing);
    }
    if (canvas && canvas.parentElement) canvas.parentElement.removeChild(canvas);
    canvas = null; vctx = null; ring = null; video = null;
  }

  // ---- HomePod connection (via local control server) ----------------------
  // The control UI lives in the browser-action popup now; this only tracks
  // connection state so it can auto-cut/resume the stream on pause/play.
  let homepodState = "unknown"; // running | stopped | off | unknown
  let autoPaused = false;       // stream stopped because the video is paused
  let droppedPaused = false;    // video paused because the HomePod connection dropped
  let pauseTimer = null;

  const isMainVideo = (t) => t && t.tagName === "VIDEO"
    && t.getBoundingClientRect().width >= CFG.minVideoW;

  function onMediaPause(e) {
    if (!isMainVideo(e.target) || homepodState !== "running") return;
    clearTimeout(pauseTimer);
    // Debounce so scrubbing (pause->play) doesn't thrash the stream.
    pauseTimer = setTimeout(() => {
      if (e.target.paused) { autoPaused = true; homepodCmd("stop"); }
    }, 250);
  }
  function onMediaPlay(e) {
    if (!isMainVideo(e.target)) return;
    tick(); // attach immediately when a video starts (don't wait for the poll)
    clearTimeout(pauseTimer);
    // Resume the stream whether we paused for a user-pause or a dropped HomePod
    // (pressing play reclaims the HomePod).
    if (autoPaused || droppedPaused) { autoPaused = false; droppedPaused = false; homepodCmd("start"); }
  }

  function sendBg(msg) {
    try { const p = ext.runtime.sendMessage(msg); if (p && typeof p.then === "function") return p; } catch (e) { /* */ }
    return new Promise((res) => { try { ext.runtime.sendMessage(msg, res); } catch (e) { res({ ok: false }); } });
  }
  async function homepodCmd(cmd) {
    const resp = await sendBg({ type: "hpsync-homepod", cmd });
    homepodState = !resp || !resp.ok ? "off" : (resp.running ? "running" : "stopped");
    // HomePod connection dropped (another device took over) -> pause the video so
    // it doesn't keep playing without sound; play again to reclaim the HomePod.
    if (resp && resp.ok && resp.dropped && video && !video.paused) {
      droppedPaused = true;
      try { video.pause(); } catch (e) { /* */ }
      toast("HomePod taken over - video paused. Press play to reclaim it.");
    }
    return resp;
  }

  // Brief on-page notice (auto-dismisses).
  let toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      Object.assign(toastEl.style, {
        position: "fixed", bottom: "24px", left: "50%", transform: "translateX(-50%)",
        zIndex: "2147483647", background: "rgba(20,20,24,0.95)", color: "#eaeaea",
        font: "13px system-ui, sans-serif", padding: "10px 16px", borderRadius: "8px",
        border: "1px solid #3a3a44", boxShadow: "0 6px 20px rgba(0,0,0,0.5)", pointerEvents: "none",
        transition: "opacity 0.3s",
      });
    }
    toastEl.textContent = msg;
    if (!toastEl.isConnected) document.documentElement.appendChild(toastEl);
    toastEl.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (toastEl) toastEl.style.opacity = "0"; }, 4000);
  }

  // ---- Main tick: track the page's best video -----------------------------
  function tick() {
    if (document.hidden) return; // don't process background tabs
    if (isBlocked()) { if (video) detach(); detectedVideo = null; return; }
    const best = findBestVideo();
    detectedVideo = best || null;
    if (store.enabled && best) {
      if (best !== video && (!isValid(video) || area(best) > area(video) * 1.2)) attach(best);
    } else if (video) {
      detach();
    }
  }

  // ---- Messaging: popup reads page state; reacts to setting changes -------
  if (ext && ext.runtime && ext.runtime.onMessage) {
    ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === "hpsync-getstate") {
        sendResponse({ ok: true, hasVideo: !!detectedVideo, attached: !!video,
          host: location.hostname, blocked: isBlocked() });
      }
    });
  }
  // Settings are changed by the popup via storage; apply them live here.
  if (ext && ext.storage && ext.storage.onChanged) {
    ext.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      let delayChanged = false, enabledChanged = false;
      if (changes.delayMs && typeof changes.delayMs.newValue === "number") {
        store.delayMs = changes.delayMs.newValue; delayChanged = true;
      }
      if (changes.enabled && typeof changes.enabled.newValue === "boolean") {
        store.enabled = changes.enabled.newValue; enabledChanged = true;
      }
      if (changes.blacklist) { store.blacklist = changes.blacklist.newValue || []; enabledChanged = true; }
      if (delayChanged && video) buildRing();
      if (enabledChanged) tick(); // re-evaluate attach/detach (also handles blacklist)
    });
  }

  // ---- Wiring --------------------------------------------------------------
  async function init() {
    await loadStore();
    tick();
    setInterval(tick, 1000);
    document.addEventListener("yt-navigate-finish", () => setTimeout(tick, 400));
    // play/pause don't bubble, so listen in the capture phase.
    document.addEventListener("pause", onMediaPause, true);
    document.addEventListener("play", onMediaPlay, true);
    // Attach as soon as a video is ready, instead of waiting for the 1s poll.
    document.addEventListener("loadeddata", () => tick(), true);
    document.addEventListener("canplay", () => tick(), true);
    // Pause all capture/render on background tabs; resume when this tab is shown.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        if (raf != null) { cancelAnimationFrame(raf); raf = null; }
      } else {
        tick();
        if (video && raf == null) raf = requestAnimationFrame(loop);
      }
    });
    // Poll connection state (for pause/resume gating) only while a video is here.
    homepodCmd("status").catch(() => {});
    setInterval(() => { if (detectedVideo) homepodCmd("status").catch(() => {}); }, 2000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
