#!/usr/bin/env python3
"""
=====================================================
  Precise Raspberry Pi Metronome  (headphone output)
=====================================================

Generates sample-accurate metronome clicks and streams them to the
standard audio output (3.5 mm headphone jack) via ALSA `aplay -M`.

IPC Controls (via stdin)
------------------------
    start         # Start playing clicks
    stop          # Stop playing clicks (silence)
    bpm <n>       # Change BPM
    beats <n>     # Change beats per measure
    status        # Print current status as JSON
    quit          # Stop and exit
"""

import argparse
import math
import os
import signal
import subprocess
import sys
import tempfile
import wave
import threading
import json
import time

# ---------------------------------------------------------------------------
# Audio constants
# ---------------------------------------------------------------------------
SAMPLE_RATE = 44100
CLICK_FREQ  = 1000
CLICK_DUR   = 0.05
VOLUME      = 0.8
BUFFER_SECS = 4.0           # smaller → faster BPM reaction


def _default_alsa_device():
    """Guess best ALSA device for Raspberry Pi headphone jack."""
    try:
        out = subprocess.check_output(['aplay', '-L'], stderr=subprocess.DEVNULL, text=True)
        if 'Headphones' in out:
            return 'hw:Headphones'
    except Exception:
        pass
    try:
        with open('/proc/asound/cards', 'r') as f:
            content = f.read()
            if 'Headphones' in content or 'bcm2835' in content:
                return 'default'
    except Exception:
        pass
    return 'default'


class Metronome:
    def __init__(self, bpm: float, beats_per_bar: int = 4,
                 accent_beat: int = 1, volume: float = VOLUME,
                 alsa_device: str = None):
        self.bpm       = max(20.0, min(300.0, float(bpm)))
        self.beats     = max(1, int(beats_per_bar))
        self.accent    = max(1, min(self.beats, int(accent_beat)))
        self.volume    = max(0.0, min(1.0, float(volume)))
        self.alsa_device = alsa_device or _default_alsa_device()

        self._running  = True      # process alive flag
        self._playing  = False     # currently clicking?
        self._lock     = threading.Lock()

        self._beat_vol = [self.volume if (i + 1) == self.accent else
                          self.volume * 0.7 for i in range(self.beats)]

    # -- sample generation -------------------------------------------------
    def _click_waveform(self, amplitude: float) -> bytes:
        n = int(CLICK_DUR * SAMPLE_RATE)
        data = bytearray(n * 2)
        for i in range(n):
            t = i / SAMPLE_RATE
            env = amplitude * math.exp(-t / 0.008) * math.sin(2 * math.pi * CLICK_FREQ * t)
            val = int(math.copysign(min(abs(env), 1.0), env) * 32767)
            data[i * 2]     = val & 0xFF
            data[i * 2 + 1] = (val >> 8) & 0xFF
        return bytes(data)

    def _build_buffer(self, play: bool) -> bytes:
        """Build BUFFER_SECS of audio. If play=False → silence."""
        buffer_samples = int(BUFFER_SECS * SAMPLE_RATE)
        out = bytearray(buffer_samples * 2)
        if not play:
            return bytes(out)

        clicks_by_amp = {}
        for amp in set(self._beat_vol):
            clicks_by_amp[amp] = self._click_waveform(amp)

        beat_interval_samples = SAMPLE_RATE * (60.0 / self.bpm)
        sample_pos = 0
        while sample_pos < buffer_samples:
            for amp in self._beat_vol:
                if sample_pos >= buffer_samples:
                    break
                click = clicks_by_amp[amp]
                start = int(sample_pos * 2)
                end   = min(start + len(click), len(out))
                for i in range(end - start):
                    # Mix click into buffer (simple add; clicks never overlap at normal BPM)
                    cur = int.from_bytes(out[start + i:start + i + 2], 'little', signed=True)
                    new = int.from_bytes(click[i:i + 2], 'little', signed=True)
                    mixed = max(-32768, min(32767, cur + new))
                    out[start + i]     = mixed & 0xFF
                    out[start + i + 1] = (mixed >> 8) & 0xFF
                sample_pos += beat_interval_samples

        return bytes(out)

    def _write_wav(self, data: bytes) -> str:
        tmpdir = tempfile.gettempdir()
        path = os.path.join(tmpdir, f"metronome_{os.getpid()}.wav")
        with wave.open(path, "w") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(data)
        return path

    # -- playback loop (runs in its own thread) ---------------------------
    def _play_loop(self):
        """Continuously stream buffers. Plays silence when not _playing."""
        print("[metronome] Playback thread started", flush=True)
        while self._running:
            with self._lock:
                do_play = self._playing
            data = self._build_buffer(do_play)
            path = self._write_wav(data)
            try:
                cmd = ["aplay", "-M",
                       "-D", self.alsa_device,
                       "-r", str(SAMPLE_RATE),
                       "-f", "S16_LE",
                       "-c", "1",
                       "-t", "wav",
                       path]
                subprocess.run(cmd,
                               stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL)
            except FileNotFoundError:
                print("[metronome] Error: 'aplay' not found. Install alsa-utils.",
                      file=sys.stderr, flush=True)
                break
            finally:
                try:
                    os.remove(path)
                except OSError:
                    pass
        print("[metronome] Playback thread exited", flush=True)

    # -- control API -------------------------------------------------------
    def start(self):
        with self._lock:
            if not self._playing:
                self._playing = True
                print(f"[metronome] START  BPM={self.bpm:.1f}  beats={self.beats}  accent={self.accent}  vol={self.volume:.2f}", flush=True)
            else:
                print("[metronome] Already playing", flush=True)

    def stop(self):
        with self._lock:
            if self._playing:
                self._playing = False
                print("[metronome] STOP", flush=True)
            else:
                print("[metronome] Already stopped", flush=True)

    def quit(self):
        print("[metronome] QUIT", flush=True)
        with self._lock:
            self._running = False
            self._playing = False

    def set_bpm(self, bpm: float):
        with self._lock:
            self.bpm = max(20.0, min(300.0, float(bpm)))
            beat_interval_samples = SAMPLE_RATE * (60.0 / self.bpm)
        print(f"[metronome] BPM → {self.bpm:.1f}", flush=True)

    def set_beats(self, beats: int):
        with self._lock:
            self.beats = max(1, int(beats))
            self.accent = min(self.accent, self.beats)
            self._beat_vol = [self.volume if (i + 1) == self.accent else
                              self.volume * 0.7 for i in range(self.beats)]
        print(f"[metronome] Beats → {self.beats}", flush=True)

    def status(self) -> dict:
        with self._lock:
            return {
                "running": self._running,
                "playing": self._playing,
                "bpm": self.bpm,
                "beats": self.beats,
                "accent": self.accent,
                "volume": self.volume,
                "device": self.alsa_device,
            }


def read_commands(metronome: Metronome):
    """Read commands from stdin in a separate thread."""
    print("[metronome] Listening on stdin...", flush=True)
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            parts = line.split()
            cmd = parts[0].lower()
            if cmd == "start":
                metronome.start()
            elif cmd == "stop":
                metronome.stop()
            elif cmd == "bpm" and len(parts) >= 2:
                try:
                    metronome.set_bpm(float(parts[1]))
                except ValueError:
                    print(f"[metronome] Invalid BPM: {parts[1]}", flush=True)
            elif cmd == "beats" and len(parts) >= 2:
                try:
                    metronome.set_beats(int(parts[1]))
                except ValueError:
                    print(f"[metronome] Invalid beats: {parts[1]}", flush=True)
            elif cmd == "status":
                print(json.dumps(metronome.status()), flush=True)
            elif cmd == "quit":
                metronome.quit()
                break
            else:
                print(f"[metronome] Unknown command: {cmd}", flush=True)
    except (IOError, OSError):
        pass


def _handle_sigusr1(signum, frame):
    print("[metronome] SIGUSR1 → toggle play/stop", flush=True)
    # Can't easily toggle without reference; signals mainly for systemd graceful stop
    pass


def main():
    parser = argparse.ArgumentParser(
        description="Precise Raspberry Pi Metronome (headphone output)")
    parser.add_argument("-B", "--bpm", type=float, default=120, help="BPM")
    parser.add_argument("-b", "--beats", type=int, default=4, help="Beats/measure")
    parser.add_argument("-a", "--accent", type=int, default=1, help="Accent beat")
    parser.add_argument("-v", "--volume", type=float, default=VOLUME, help="Volume 0.0–1.0")
    parser.add_argument("-d", "--device", type=str, default=None, help="ALSA device")
    args = parser.parse_args()

    metro = Metronome(bpm=args.bpm, beats_per_bar=args.beats,
                      accent_beat=args.accent, volume=args.volume,
                      alsa_device=args.device)

    # Start playback thread first (generates silence until 'start' command)
    playback_thread = threading.Thread(target=metro._play_loop, daemon=True)
    playback_thread.start()

    # Start command reader
    cmd_thread = threading.Thread(target=read_commands, args=(metro,), daemon=True)
    cmd_thread.start()

    signal.signal(signal.SIGINT, lambda *_: metro.quit())
    signal.signal(signal.SIGTERM, lambda *_: metro.quit())
    signal.signal(signal.SIGUSR1, _handle_sigusr1)

    print(f"[metronome] Ready. Device={metro.alsa_device}. Send 'start' to begin.", flush=True)

    # Keep main thread alive until quit
    while metro._running:
        time.sleep(0.5)

    print("[metronome] Exiting.", flush=True)
    playback_thread.join(timeout=2)
    sys.exit(0)


if __name__ == "__main__":
    main()
