/*
 * Browser-action popup UI for HomePod A/V Sync.
 *
 * Settings (delay / sync on-off) are stored in extension storage; the content
 * scripts watch storage.onChanged and apply them live. HomePod connect/disconnect
 * goes through the background script to the local control server.
 */
const ext = globalThis.browser ?? globalThis.chrome;

const el = (id) => document.getElementById(id);
const state = { delayMs: 2500, enabled: true, homepod: "unknown", hasVideo: false, device: null,
                audioDevice: null, volume: 50, host: "", blacklist: [] };

async function loadSettings() {
  try {
    const o = await ext.storage.local.get(["delayMs", "enabled", "volume"]);
    if (typeof o.delayMs === "number") state.delayMs = o.delayMs;
    if (typeof o.enabled === "boolean") state.enabled = o.enabled;
    if (typeof o.volume === "number") state.volume = o.volume;
  } catch (e) { /* */ }
}
function saveSettings() {
  try { ext.storage.local.set({ delayMs: state.delayMs, enabled: state.enabled, volume: state.volume }); } catch (e) { /* */ }
}

function sendBg(msg) {
  try { const p = ext.runtime.sendMessage(msg); if (p && typeof p.then === "function") return p; } catch (e) { /* */ }
  return new Promise((res) => { try { ext.runtime.sendMessage(msg, res); } catch (e) { res({ ok: false }); } });
}

async function activeTab() {
  const tabs = await ext.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}
async function askContent(msg) {
  const tab = await activeTab();
  if (!tab) return null;
  try { return await ext.tabs.sendMessage(tab.id, msg); } catch (e) { return null; }
}

async function refreshHomepod(cmd) {
  const resp = await sendBg({ type: "hpsync-homepod", cmd: cmd || "status" });
  state.homepod = !resp || !resp.ok ? "off" : (resp.running ? "running" : "stopped");
  if (resp && resp.ok && "device" in resp) state.device = resp.device || null;
  if (resp && resp.ok && "audio_device" in resp) state.audioDevice = resp.audio_device || null;
  render();
}

async function listAudio() {
  const btn = el("audioBtn");
  btn.textContent = "…"; btn.disabled = true;
  try {
    const data = await serverCall("audio-devices");
    renderAudioList(data.devices || []);
  } catch (e) {
    renderAudioList(null, String(e.message || e));
  } finally {
    btn.textContent = "Audio"; btn.disabled = false;
  }
}

function renderAudioList(devices, err) {
  const list = el("audioList");
  list.innerHTML = "";
  list.style.display = "block";
  if (err) {
    const d = document.createElement("div");
    d.className = "hint"; d.textContent = "Failed: " + err + " (is the server running?)";
    list.appendChild(d); return;
  }
  if (!devices.length) {
    const d = document.createElement("div");
    d.className = "hint"; d.textContent = "No audio devices found.";
    list.appendChild(d); return;
  }
  for (const name of devices) {
    const b = document.createElement("button");
    b.className = "devitem" + (state.audioDevice === name ? " sel" : "");
    b.textContent = name;
    b.addEventListener("click", () => selectAudio(name));
    list.appendChild(b);
  }
}

async function selectAudio(name) {
  try {
    const data = await serverCall("audio-device/set", { name });
    state.audioDevice = data.audio_device || null;
    el("audioList").style.display = "none";
    render();
  } catch (e) { /* */ }
}

async function serverCall(path, params) {
  const resp = await sendBg({ type: "hpsync-server", path, params });
  if (!resp || !resp.ok) throw new Error(resp && resp.error || "server unreachable");
  return resp.data;
}

async function scanDevices() {
  const btn = el("scanBtn");
  btn.textContent = "Scanning…"; btn.disabled = true;
  try {
    const data = await serverCall("scan");
    renderDevList(data.devices || []);
  } catch (e) {
    renderDevList(null, String(e.message || e));
  } finally {
    btn.textContent = "Scan"; btn.disabled = false;
  }
}

function renderDevList(devices, err) {
  const list = el("devList");
  list.innerHTML = "";
  list.style.display = "block";
  if (err) {
    const d = document.createElement("div");
    d.className = "hint"; d.textContent = "Scan failed: " + err + " (is the server running?)";
    list.appendChild(d);
    return;
  }
  if (!devices.length) {
    const d = document.createElement("div");
    d.className = "hint"; d.textContent = "No AirPlay devices found.";
    list.appendChild(d);
    return;
  }
  for (const dev of devices) {
    const b = document.createElement("button");
    b.className = "devitem" + (state.device && state.device.id === dev.id ? " sel" : "");
    b.innerHTML = `${escapeHtml(dev.name)}<div class="sub">${escapeHtml(dev.model || dev.address || "")}</div>`;
    b.addEventListener("click", () => selectDevice(dev));
    list.appendChild(b);
  }
}

async function selectDevice(dev) {
  try {
    const data = await serverCall("device/set", { id: dev.id, name: dev.name });
    state.device = data.device || null;
    el("devList").style.display = "none";
    render();
  } catch (e) { /* ignore */ }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---- per-site blacklist --------------------------------------------------
async function loadSite() {
  const tab = await activeTab();
  let host = "";
  try { host = new URL(tab.url).hostname; } catch (e) { /* about:/extension page */ }
  state.host = host;
  const o = await ext.storage.local.get(["blacklist"]);
  state.blacklist = Array.isArray(o.blacklist) ? o.blacklist : [];
  renderSite();
}
function hostBlocked() {
  const h = state.host;
  return !!h && state.blacklist.some((e) => e && (h === e || h.endsWith("." + e)));
}
function renderSite() {
  const btn = el("siteBtn");
  if (!state.host) {
    el("siteName").textContent = "—";
    btn.style.display = "none";
    return;
  }
  btn.style.display = "";
  el("siteName").textContent = state.host; el("siteName").title = state.host;
  btn.textContent = hostBlocked() ? "Enable here" : "Disable here";
}
async function toggleSite() {
  if (!state.host) return;
  const base = state.host.replace(/^www\./, "");
  let bl = state.blacklist.slice();
  if (hostBlocked()) {
    bl = bl.filter((e) => !(state.host === e || state.host.endsWith("." + e)));
  } else if (!bl.includes(base)) {
    bl.push(base);
  }
  state.blacklist = bl;
  await ext.storage.local.set({ blacklist: bl });
  renderSite();
}

function render() {
  el("delay").textContent = (state.delayMs / 1000).toFixed(2);

  el("syncDot").style.background = state.enabled ? "#36c46a" : "#666";
  el("syncRow").title = state.enabled ? "Video sync ON — click to disable" : "Video sync OFF — click to enable";

  const map = {
    running: ["#36c46a", "HomePod connected — click to disconnect"],
    stopped: ["#e0563f", "HomePod disconnected — click to connect"],
    off: ["#666", "Control server off — run Start-HomePodServer.bat"],
    unknown: ["#666", "Checking…"],
  };
  const [c, title] = map[state.homepod] || map.unknown;
  el("hpDot").style.background = c;
  el("hpRow").title = title;

  const devTxt = "Device: " + (state.device ? state.device.name : "default");
  el("devName").textContent = devTxt; el("devName").title = devTxt;
  const audTxt = "Audio: " + (state.audioDevice || "default");
  el("audioName").textContent = audTxt; el("audioName").title = audTxt;

  // Volume needs a selected HomePod.
  el("volSlider").disabled = !state.device;
  el("volSlider").title = state.device ? "" : "Scan and select a HomePod first";

  el("hint").textContent = state.hasVideo
    ? "Tune until lips match the HomePod."
    : "No video detected on this tab.";
}

function setDelay(ms) {
  state.delayMs = Math.max(0, Math.min(6000, Math.round(ms)));
  saveSettings();
  render();
}

document.querySelectorAll("button[data-d]").forEach((b) =>
  b.addEventListener("click", () => setDelay(state.delayMs + parseInt(b.dataset.d, 10))));

el("syncRow").addEventListener("click", () => {
  state.enabled = !state.enabled;
  saveSettings();
  render();
});

el("hpRow").addEventListener("click", () => {
  refreshHomepod(state.homepod === "running" ? "stop" : "start");
});

el("scanBtn").addEventListener("click", scanDevices);
el("audioBtn").addEventListener("click", listAudio);
el("siteBtn").addEventListener("click", toggleSite);

// Volume: update the number live while dragging; send to the HomePod on release.
el("volSlider").addEventListener("input", () => { el("volVal").textContent = el("volSlider").value; });
el("volSlider").addEventListener("change", () => {
  state.volume = parseInt(el("volSlider").value, 10);
  saveSettings();
  serverCall("volume", { level: state.volume }).catch(() => {});
});

(async () => {
  await loadSettings();
  el("volSlider").value = state.volume;
  el("volVal").textContent = state.volume;
  render();
  await loadSite();
  const cs = await askContent({ type: "hpsync-getstate" });
  if (cs && cs.ok) state.hasVideo = !!cs.hasVideo;
  render();
  refreshHomepod("status");
})();
