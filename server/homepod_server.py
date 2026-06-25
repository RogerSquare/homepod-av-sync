#!/usr/bin/env python3
"""
HomePod control server.

A tiny localhost-only HTTP server that starts/stops the HomePod audio streamer
(homepod_stream.py) so the browser extension can connect/disconnect from its
panel. A browser extension can't launch a local process itself, so it calls this
instead.

Endpoints (all on http://127.0.0.1:17645):
  GET /status              -> {"running": bool, "device": {...}|null}
  GET /start?token=...     -> starts the streamer, {"running": bool}
  GET /stop?token=...      -> stops the streamer,  {"running": bool}
  GET /scan?token=...      -> {"devices": [{name,id,address,model,raop}, ...]}
  GET /device              -> {"device": {id,name}|null}
  GET /device/set?token=...&id=...&name=... -> save selection (empty id clears)

start/stop/scan/device-set require ?token=<TOKEN> (a shared secret the extension
knows) so other websites can't control your HomePod. Bound to 127.0.0.1 only.
The selected device persists in homepod_config.json and is passed to the streamer.

Run it (keep the window open, or autostart at login):
    python homepod_server.py
"""

import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
STREAMER = os.path.join(HERE, "homepod_stream.py")
CONFIG_FILE = os.path.join(HERE, "homepod_config.json")
PYTHON = sys.executable
HOST, PORT = "127.0.0.1", 17645
TOKEN = "hpsync-7Kq2"  # must match the token in the extension's background.js

CREATE_NEW_PROCESS_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)  # hide console windows (ffmpeg, taskkill)

_proc = None
_lock = threading.Lock()
_user_stopped = False   # last stop() was a deliberate user/extension stop
_dropped = False        # streamer exited on its own (HomePod taken over / connection lost)


def _refresh_state():
    """Detect when the streamer exited by itself (e.g. another device took over
    the HomePod) so /status can report it as a 'dropped' connection."""
    global _proc, _dropped
    with _lock:
        if _proc is not None and _proc.poll() is not None:
            if not _user_stopped:
                _dropped = True
            _proc = None


def load_config():
    try:
        with open(CONFIG_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(cfg):
    try:
        with open(CONFIG_FILE, "w") as f:
            json.dump(cfg, f, indent=2)
    except Exception as e:
        print("[server] config save error:", e)


def selected_device():
    return load_config().get("device")


def scan_devices():
    """Scan the LAN for AirPlay/RAOP audio devices (HomePods, AirPlay speakers)."""
    async def _scan():
        import pyatv
        from pyatv.const import Protocol
        loop = asyncio.get_event_loop()
        configs = await pyatv.scan(loop, timeout=5)
        out = []
        for c in configs:
            protos = {s.protocol for s in c.services}
            if Protocol.RAOP not in protos and Protocol.AirPlay not in protos:
                continue
            model = None
            try:
                if c.device_info and c.device_info.model:
                    model = str(c.device_info.model).split(".")[-1]  # drop "DeviceModel." prefix
            except Exception:
                pass
            out.append({
                "name": c.name,
                "id": str(c.identifier) if c.identifier else None,
                "address": str(c.address) if c.address else None,
                "model": model,
                "raop": Protocol.RAOP in protos,
            })
        return out
    return asyncio.run(_scan())


def audio_devices():
    """List DirectShow audio capture devices (what the streamer can capture)."""
    p = subprocess.run(
        [ffmpeg_path(), "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
        capture_output=True, text=True, creationflags=NO_WINDOW,
    )
    devices, in_audio = [], False
    for line in p.stderr.splitlines():
        if "] " in line:
            line = line.split("] ", 1)[1]
        s = line.strip()
        if "DirectShow audio devices" in s:
            in_audio = True
            continue
        if "DirectShow video devices" in s:
            in_audio = False
            continue
        if not in_audio or s.startswith("Alternative"):
            continue
        m = re.match(r'^"(.+?)"', s)
        if m and m.group(1) not in devices:
            devices.append(m.group(1))
    return devices


# Invoke atvremote as a module via the running Python so it works no matter what
# is on PATH (the bare `atvremote` exe often isn't, e.g. under the Store Python).
ATVREMOTE = [sys.executable, "-m", "pyatv.scripts.atvremote"]


def ffmpeg_path():
    p = shutil.which("ffmpeg")
    if p:
        return p
    cand = os.path.join(os.path.dirname(sys.executable), "Library", "bin", "ffmpeg.exe")
    return cand if os.path.exists(cand) else "ffmpeg"


def set_homepod_volume(level):
    """Set the selected HomePod's volume (0-100) via a quick atvremote call."""
    dev = selected_device()
    if not (dev and dev.get("id")):
        raise RuntimeError("no HomePod selected")
    subprocess.run(ATVREMOTE + ["--id", dev["id"], f"set_volume={level}"],
                   capture_output=True, text=True, timeout=20, creationflags=NO_WINDOW)


def get_homepod_volume():
    dev = selected_device()
    if not (dev and dev.get("id")):
        return None
    p = subprocess.run(ATVREMOTE + ["--id", dev["id"], "volume"],
                       capture_output=True, text=True, timeout=20, creationflags=NO_WINDOW)
    m = re.search(r"(\d+(?:\.\d+)?)", p.stdout)
    return round(float(m.group(1))) if m else None


def now_playing_title():
    """Return the HomePod's current Title/Artist/Album, or None. Our own stream
    sets no metadata, so any value here means another device is playing to it."""
    dev = selected_device()
    if not (dev and dev.get("id")):
        return None
    p = subprocess.run(ATVREMOTE + ["--id", dev["id"], "playing"],
                       capture_output=True, text=True, timeout=20, creationflags=NO_WINDOW)
    for line in p.stdout.splitlines():
        m = re.match(r"\s*(?:Title|Artist|Album):\s*(\S.*)$", line)
        if m and m.group(1).strip() not in ("", "-"):
            return m.group(1).strip()
    return None


def is_running():
    return _proc is not None and _proc.poll() is None


def start():
    global _proc, _user_stopped, _dropped
    with _lock:
        if is_running():
            return
        _user_stopped = False
        _dropped = False
        args = [PYTHON, STREAMER]
        cfg = load_config()
        dev = cfg.get("device")
        if dev and dev.get("id"):
            args += ["--id", dev["id"]]
        adev = cfg.get("audio_device")
        if adev:
            args += ["--device", adev]
        _proc = subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=CREATE_NEW_PROCESS_GROUP | NO_WINDOW,
        )
        print(f"[server] streamer started (pid {_proc.pid}) "
              f"device={dev['name'] if dev else 'default'}")


def _kill_streamer():
    """Kill the streamer without marking it a user stop (used on takeover)."""
    global _proc
    with _lock:
        if is_running():
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(_proc.pid)],
                           capture_output=True, creationflags=NO_WINDOW)
        _proc = None


def _takeover_monitor():
    """Persistent push-updates listener for near-instant takeover detection.
    The HomePod pushes a state change the moment another device plays; our own
    stream sets no metadata, so any Title/Artist while we're streaming means we
    were taken over -> yield the HomePod and flag a drop."""
    global _dropped
    while True:
        dev = selected_device()
        if not (dev and dev.get("id")):
            time.sleep(5)
            continue
        started = time.monotonic()
        try:
            proc = subprocess.Popen(
                ATVREMOTE + ["--id", dev["id"], "push_updates"],
                stdin=subprocess.PIPE,  # keep open so push_updates doesn't exit on stdin EOF
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                creationflags=NO_WINDOW,
            )
            for line in proc.stdout:  # blocks until the HomePod pushes an update
                m = re.match(r"\s*(?:Title|Artist|Album):\s*(\S.*)$", line)
                if m and m.group(1).strip() not in ("", "-") and is_running() and not _user_stopped:
                    print("[server] takeover detected (push); yielding HomePod")
                    with _lock:
                        _dropped = True
                    _kill_streamer()
            proc.wait()
        except Exception:
            pass
        # Back off hard if the listener died almost immediately (avoid spawn spin).
        time.sleep(15 if (time.monotonic() - started) < 3 else 3)


def stop():
    global _proc, _user_stopped, _dropped
    with _lock:
        _user_stopped = True
        _dropped = False
        if is_running():
            # Kill the whole tree (python -> ffmpeg, shim -> atvremote).
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(_proc.pid)],
                           capture_output=True, creationflags=NO_WINDOW)
            print(f"[server] streamer stopped (pid {_proc.pid})")
        _proc = None


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _token_ok(self):
        q = parse_qs(urlparse(self.path).query)
        return q.get("token", [None])[0] == TOKEN

    def do_GET(self):
        path = urlparse(self.path).path.rstrip("/")
        if path in ("", "/status"):
            _refresh_state()
            self._send(200, {"running": is_running(), "dropped": _dropped,
                             "device": selected_device(),
                             "audio_device": load_config().get("audio_device")})
        elif path in ("/start", "/stop"):
            if not self._token_ok():
                self._send(403, {"error": "bad token"})
                return
            start() if path == "/start" else stop()
            self._send(200, {"running": is_running()})
        elif path == "/scan":
            if not self._token_ok():
                self._send(403, {"error": "bad token"})
                return
            try:
                self._send(200, {"devices": scan_devices()})
            except Exception as e:
                self._send(500, {"error": str(e)})
        elif path == "/device":
            self._send(200, {"device": selected_device()})
        elif path == "/device/set":
            if not self._token_ok():
                self._send(403, {"error": "bad token"})
                return
            q = parse_qs(urlparse(self.path).query)
            dev_id = (q.get("id", [""])[0] or "").strip()
            name = (q.get("name", [""])[0] or "").strip()
            cfg = load_config()
            if dev_id:
                cfg["device"] = {"id": dev_id, "name": name or dev_id}
            else:
                cfg.pop("device", None)  # clear -> streamer uses its default
            save_config(cfg)
            # If currently streaming, reconnect to the newly selected device.
            if is_running():
                stop()
                start()
            self._send(200, {"device": cfg.get("device"), "running": is_running()})
        elif path == "/audio-devices":
            if not self._token_ok():
                self._send(403, {"error": "bad token"})
                return
            try:
                self._send(200, {"devices": audio_devices()})
            except Exception as e:
                self._send(500, {"error": str(e)})
        elif path == "/volume":
            q = parse_qs(urlparse(self.path).query)
            level = q.get("level", [None])[0]
            if level is None:  # GET current volume
                try:
                    self._send(200, {"volume": get_homepod_volume()})
                except Exception as e:
                    self._send(500, {"error": str(e)})
            else:              # SET volume (token required)
                if not self._token_ok():
                    self._send(403, {"error": "bad token"})
                    return
                try:
                    lvl = max(0, min(100, int(float(level))))
                    set_homepod_volume(lvl)
                    self._send(200, {"volume": lvl})
                except Exception as e:
                    self._send(500, {"error": str(e)})
        elif path == "/audio-device":
            self._send(200, {"audio_device": load_config().get("audio_device")})
        elif path == "/audio-device/set":
            if not self._token_ok():
                self._send(403, {"error": "bad token"})
                return
            q = parse_qs(urlparse(self.path).query)
            name = (q.get("name", [""])[0] or "").strip()
            cfg = load_config()
            if name:
                cfg["audio_device"] = name
            else:
                cfg.pop("audio_device", None)  # clear -> streamer uses its default
            save_config(cfg)
            if is_running():
                stop()
                start()
            self._send(200, {"audio_device": cfg.get("audio_device"), "running": is_running()})
        else:
            self._send(404, {"error": "not found"})

    def log_message(self, *args):
        pass  # quiet


class _Server(ThreadingHTTPServer):
    # On Windows, allow_reuse_address=True (the default) lets MULTIPLE instances
    # bind the same port - so re-running the server stacks duplicates. Refuse it.
    allow_reuse_address = False


if __name__ == "__main__":
    # When launched with pythonw (hidden background task) there's no console, so
    # stdout/stderr are None and print() would crash. Redirect to a log file.
    if sys.stdout is None or sys.stderr is None:
        _log = open(os.path.join(HERE, "homepod_server.log"), "a", buffering=1, encoding="utf-8")
        sys.stdout = sys.stderr = _log
    # Bind first; if another instance already owns the port, exit quietly WITHOUT
    # starting the takeover monitor (avoids orphaned push-update listeners).
    try:
        httpd = _Server((HOST, PORT), Handler)
    except OSError:
        print(f"[server] port {PORT} already in use - another instance is running. Exiting.")
        sys.exit(0)
    threading.Thread(target=_takeover_monitor, daemon=True).start()
    print(f"HomePod control server on http://{HOST}:{PORT}  (Ctrl+C to quit)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        stop()
        print("\n[server] bye")
