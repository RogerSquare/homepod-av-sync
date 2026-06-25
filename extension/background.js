/*
 * Background relay: "hpsync-homepod" messages (from the popup or a content
 * script) call the local control server to start/stop/status the HomePod
 * streamer. Done here, not in content scripts, so a page's CSP/CORS can't block
 * the localhost request.
 */
const ext = globalThis.browser ?? globalThis.chrome;

const SERVER = "http://127.0.0.1:17645";
const TOKEN = "hpsync-7Kq2"; // must match TOKEN in homepod_server.py

async function serverGet(path, params) {
  const q = new URLSearchParams({ token: TOKEN, ...(params || {}) });
  const r = await fetch(`${SERVER}/${path}?${q}`, { cache: "no-store" });
  if (!r.ok) throw new Error("http " + r.status);
  return r.json();
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "hpsync-homepod") { // cmd: status | start | stop
    serverGet(msg.cmd)
      .then((j) => sendResponse({ ok: true, running: !!j.running, dropped: !!j.dropped, device: j.device, audio_device: j.audio_device }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg.type === "hpsync-server") { // generic: { path, params }
    serverGet(msg.path, msg.params)
      .then((j) => sendResponse({ ok: true, data: j }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
});
