#!/usr/bin/env python3
"""
Thin wrapper around pyatv's `atvremote` that lowers the RAOP playback latency.

pyatv hard-codes the AirPlay/RAOP buffer-ahead to `22050 + sample_rate` frames
(~1.5 s at 44.1 kHz) in pyatv.protocols.raop.protocols.StreamContext. That delay
is what makes streamed audio feel "behind". The HomePod actually negotiates a
latency range down to 11025 frames (~0.25 s), so we monkeypatch the value at
runtime to whatever RAOP_LATENCY_FRAMES says, then hand off to atvremote's main.

Patching at runtime (instead of editing site-packages) means a `pip install
--upgrade pyatv` won't silently undo the change.

Set the buffer via env var RAOP_LATENCY_FRAMES (frames at 44.1 kHz; 11025 = 0.25 s,
22050 = 0.5 s). All other arguments are passed straight through to atvremote.
"""

import os
import sys

from pyatv.protocols.raop.protocols import StreamContext

# Default 0.5 s if not specified. The HomePod doesn't hard-reject low values, so
# we allow aggressive experimentation down to a tiny safety floor (~10 ms); below
# that you're just guaranteeing underruns.
_frames = int(os.environ.get("RAOP_LATENCY_FRAMES", "22050"))
_frames = max(_frames, 441)

_orig_init = StreamContext.__init__
_orig_reset = StreamContext.reset


def _init(self):
    _orig_init(self)
    self.latency = _frames


def _reset(self):
    _orig_reset(self)          # reset() recomputes latency, so override after
    self.latency = _frames


StreamContext.__init__ = _init
StreamContext.reset = _reset

print(f"[lowlatency] RAOP latency patched to {_frames} frames "
      f"(~{int(_frames / 44100 * 1000)} ms)", file=sys.stderr)

from pyatv.scripts.atvremote import main  # noqa: E402  (after the patch)

if __name__ == "__main__":
    main()
