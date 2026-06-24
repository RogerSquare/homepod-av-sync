#!/usr/bin/env python3
"""
HomePod live audio streamer.

Captures a Windows audio device (default: the Elgato Wave Link "Stream Mix")
with ffmpeg, encodes to MP3, and pipes it to a HomePod over AirPlay/RAOP using
pyatv's `atvremote stream_file=-`.

Because it captures the Wave Link Stream Mix, you control *what* the HomePod
plays from inside Wave Link: raise / lower / mute each app on its Stream-Mix
fader and that is exactly what comes out of the HomePod.

The connector is written in Python on purpose: piping raw audio bytes through a
PowerShell pipeline corrupts them (PowerShell re-encodes as text). Python wires
ffmpeg.stdout straight into atvremote.stdin as a real OS pipe.

Usage:
    python homepod_stream.py                # defaults below
    python homepod_stream.py --device "CABLE Output (VB-Audio Virtual Cable)"
    python homepod_stream.py --volume 35    # set HomePod volume once at startup
    python homepod_stream.py --list         # list capture devices and exit
"""

import argparse
import os
import signal
import subprocess
import sys
import time

# ---------------------------------------------------------------------------
# Configuration (sensible defaults for this machine; override on the CLI)
# ---------------------------------------------------------------------------
HOMEPOD_ID = ""                              # set via --id, the popup's Scan, or homepod_config.json
CAPTURE_DEVICE = "Stream Mix (Elgato Virtual Audio)"  # Wave Link Stream Mix (override with --device)
BITRATE = "256k"
SAMPLE_RATE = 44100
AUDIO_BUFFER_MS = "20"                        # dshow capture buffer; lower = less lag
LATENCY_MS = 200                              # RAOP buffer-ahead; dial lower for live
RESTART_DELAY = 3                            # seconds to wait before reconnecting

# Resolve tools from PATH so this is portable across machines (ffmpeg + pyatv's
# atvremote must be installed and on PATH). Falls back to the bare name, which
# subprocess still resolves via PATH at launch.
import shutil
FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
ATVREMOTE = shutil.which("atvremote") or "atvremote"
PYTHON = sys.executable
SHIM = os.path.join(os.path.dirname(os.path.abspath(__file__)), "atvremote_lowlatency.py")
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)  # hide console windows on Windows

_stop = False


def _handle_sigint(signum, frame):
    global _stop
    _stop = True
    print("\n[homepod-stream] stopping...")


def list_devices():
    """Print ffmpeg DirectShow audio capture devices."""
    proc = subprocess.run(
        [FFMPEG, "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
        stderr=subprocess.PIPE, stdout=subprocess.PIPE, text=True, creationflags=NO_WINDOW,
    )
    in_audio = False
    for line in proc.stderr.splitlines():
        line = line.split("] ", 1)[-1] if "] " in line else line
        if "DirectShow audio devices" in line:
            in_audio = True
            print("Audio capture devices:")
            continue
        if "DirectShow video devices" in line:
            in_audio = False
        if in_audio and line.strip().startswith('"'):
            print("  " + line.strip())


def set_volume(volume):
    """One-shot: set HomePod volume (0-100) before streaming starts."""
    print(f"[homepod-stream] setting HomePod volume to {volume}")
    subprocess.run(
        [ATVREMOTE, "--id", HOMEPOD_ID, f"set_volume={volume}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=NO_WINDOW,
    )


def ffmpeg_cmd(device):
    return [
        FFMPEG, "-hide_banner", "-loglevel", "warning",
        "-f", "dshow",
        "-audio_buffer_size", AUDIO_BUFFER_MS,
        "-i", f"audio={device}",
        "-ac", "2", "-ar", str(SAMPLE_RATE),
        "-c:a", "libmp3lame", "-b:a", BITRATE, "-reservoir", "0",
        "-f", "mp3", "-flush_packets", "1",
        "pipe:1",
    ]


def atv_cmd():
    # Run atvremote through the low-latency shim instead of the bare exe.
    return [PYTHON, SHIM, "--id", HOMEPOD_ID, "stream_file=-"]


def stream_once(device, latency_ms, max_seconds=None):
    """Run one ffmpeg|atvremote session; return when it ends (or after max_seconds)."""
    env = os.environ.copy()
    env["RAOP_LATENCY_FRAMES"] = str(int(latency_ms / 1000 * SAMPLE_RATE))
    ff = subprocess.Popen(ffmpeg_cmd(device), stdout=subprocess.PIPE, creationflags=NO_WINDOW)
    atv = subprocess.Popen(atv_cmd(), stdin=ff.stdout, env=env, creationflags=NO_WINDOW)
    # Let ffmpeg get SIGPIPE if atvremote dies first.
    ff.stdout.close()
    started = time.monotonic()
    try:
        while not _stop:
            if atv.poll() is not None:
                break          # atvremote exited (stream ended / HomePod dropped)
            if ff.poll() is not None:
                break          # ffmpeg died (device lost)
            if max_seconds and (time.monotonic() - started) >= max_seconds:
                break
            time.sleep(0.2)
    finally:
        for p in (atv, ff):
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    p.kill()


def run_sweep(device, steps, seconds_each):
    """Play live audio at descending latencies so you can hear where it breaks."""
    print("[homepod-stream] SWEEP: play music now and listen for the first stutter.\n")
    for ms in steps:
        if _stop:
            break
        print(f"  >>> now at {ms} ms  (Ctrl+C to stop the sweep) <<<")
        stream_once(device, ms, max_seconds=seconds_each)
        time.sleep(1)   # brief gap between reconnections
    print("\n[homepod-stream] sweep done. Re-run with --latency-ms <last clean value>.")


def main():
    global HOMEPOD_ID
    parser = argparse.ArgumentParser(description="Stream Windows audio to a HomePod.")
    parser.add_argument("--device", default=CAPTURE_DEVICE,
                        help="ffmpeg dshow capture device name")
    parser.add_argument("--id", default=HOMEPOD_ID, dest="hp_id",
                        help="HomePod identifier (MAC) from `atvremote scan`")
    parser.add_argument("--volume", type=int, default=None,
                        help="set HomePod volume (0-100) once at startup")
    parser.add_argument("--latency-ms", type=int, default=LATENCY_MS, dest="latency_ms",
                        help="RAOP buffer-ahead in ms; lower = more live (try 200 down to 60)")
    parser.add_argument("--sweep", action="store_true",
                        help="step through descending latencies to find your floor")
    parser.add_argument("--list", action="store_true",
                        help="list capture devices and exit")
    args = parser.parse_args()

    HOMEPOD_ID = args.hp_id

    if args.list:
        list_devices()
        return

    # If no --id given, fall back to the device selected via the popup (saved
    # in homepod_config.json next to this script).
    if not HOMEPOD_ID:
        try:
            import json
            cfg = os.path.join(os.path.dirname(os.path.abspath(__file__)), "homepod_config.json")
            with open(cfg) as f:
                HOMEPOD_ID = ((json.load(f).get("device") or {}).get("id") or "")
        except Exception:
            pass
    if not HOMEPOD_ID:
        print("[homepod-stream] No HomePod selected. Pass --id <id>, or pick one "
              "in the extension popup (Scan), then retry.")
        return

    signal.signal(signal.SIGINT, _handle_sigint)
    if args.volume is not None:
        set_volume(args.volume)

    print(f"[homepod-stream] capturing: {args.device}")
    print(f"[homepod-stream] -> HomePod: {HOMEPOD_ID}")

    if args.sweep:
        run_sweep(args.device, [200, 150, 100, 80, 60], seconds_each=20)
        return

    print(f"[homepod-stream] latency: {args.latency_ms} ms buffer-ahead")
    print("[homepod-stream] control what plays via Wave Link's Stream-Mix faders.")
    print("[homepod-stream] press Ctrl+C to stop.\n")

    while not _stop:
        stream_once(args.device, args.latency_ms)
        if _stop:
            break
        print(f"[homepod-stream] stream ended; reconnecting in {RESTART_DELAY}s...")
        for _ in range(RESTART_DELAY * 2):
            if _stop:
                break
            time.sleep(0.5)

    print("[homepod-stream] stopped.")


if __name__ == "__main__":
    main()
