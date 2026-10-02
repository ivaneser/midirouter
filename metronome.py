#!/usr/bin/env python3
"""
=====================================================
  Precise Raspberry Pi Metronome  (headphone output)
=====================================================

Generates sample-accurate metronome clicks triggered by authoritative DAW beat
events.  Each incoming ``click`` command plays exactly one click through ALSA
``aplay -M`` to the 3.5 mm headphone jack.  Continuous free-running playback is
no longer used — beats are driven externally (internal or external clock).

IPC Controls (via stdin)
------------------------
    start         # Start playing clicks (audio-ready; actual clicks come via ``click``)
    stop          # Stop playing clicks (silence)
    bpm <n>       # Change BPM (stored for volume / accent calculations)
    beats <n>     # Change beats per measure
    click         # Play one metronome click immediately
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
BUFFER_SECS = 4.0           # chunks are interrupted and rebuilt on control changes


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
        self._playing  = False     # audio-ready (clicks accepted)?
        self._lock     = threading.Lock()
        self._audio_process = None
        self._audio_generation = 0
        self._last_click_time = 0.0

        # Cached waveform for fast per-click emission.
        self._normal_click = self._click_waveform(self.volume)
        self._accent_click = self._click_waveform(
            self.volume * (1.0 if self.accent == 1 else 0.7))

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

    def _write_wav(self, data: bytes) -> str:
        tmpdir = tempfile.gettempdir()
        path = os.path.join(tmpdir, f"metronome_{os.getpid()}_{id(data)}.wav")
        with wave.open(path, "w") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(data)
        return path

    # -- playback loop (runs in its own thread) ---------------------------
    def _play_loop(self):
        """Waits for click commands and streams them."""
        print("[metronome] Playback thread started", flush=True)
        while self._running:
            with self._lock:
                is_running = self._running
                do_play = self._playing
                generation = self._audio_generation
                if not is_running:
                    break
            if not do_play:
                time.sleep(0.05)
                continue

            # Check if there's a click to play (set by _emit_click_locked).
            with self._lock:
                click_data = getattr(self, '_pending_click', None)
                if click_data is None:
                    continue
                generation = self._audio_generation

            path = self._write_wav(click_data)
            try:
                cmd = ["aplay", "-M",
                       "-D", self.alsa_device,
                       "-r", str(SAMPLE_RATE),
                       "-f", "S16_LE",
                       "-c", "1",
                       "-t", "wav",
                       path]
                process = subprocess.Popen(cmd, stdout=subprocess.DEVNULL,
                                           stderr=subprocess.DEVNULL)
                with self._lock:
                    self._audio_process = process
                    interrupted = generation != self._audio_generation
                if interrupted:
                    process.terminate()
                process.wait()
            except FileNotFoundError:
                print("[metronome] Error: 'aplay' not found. Install alsa-utils.",
                      file=sys.stderr, flush=True)
                break
            finally:
                with self._lock:
                    if self._audio_process is not None and self._audio_process.poll() is not None:
                        self._audio_process = None
                    # Clear pending click after playback.
                    self._pending_click = None
                try:
                    os.remove(path)
                except OSError:
                    pass
        print("[metronome] Playback thread exited", flush=True)

    def _emit_click(self, is_accent: bool):
        """Public API — emit one click. Chooses accent or normal waveform."""
        with self._lock:
            if not self._playing or not self._running:
                return
            # Skip duplicate clicks within 10 ms to avoid double-fires.
            now = time.monotonic()
            if now - self._last_click_time < 0.01:
                return
            self._last_click_time = now
            click_data = self._accent_click if is_accent else self._normal_click
            # If a previous click is still playing, interrupt it and queue the new one.
            if getattr(self, '_pending_click', None) is not None:
                self._interrupt_audio_locked()
            self._pending_click = click_data
            self._audio_generation += 1

    def _interrupt_audio_locked(self):
        process = self._audio_process
        if process is not None and process.poll() is None:
            try:
                process.terminate()
            except OSError:
                pass

    # -- control API -------------------------------------------------------
    def start(self):
        with self._lock:
            if not self._playing:
                self._playing = True
                self._last_click_time = 0.0
                print(f"[metronome] START  BPM={self.bpm:.1f}  beats={self.beats}  accent={self.accent}  vol={self.volume:.2f}", flush=True)
            else:
                print("[metronome] Already playing", flush=True)

    def stop(self):
        with self._lock:
            if self._playing:
                self._playing = False
                self._pending_click = None
                self._interrupt_audio_locked()
                print("[metronome] STOP", flush=True)
            else:
                print("[metronome] Already stopped", flush=True)

    def quit(self):
        print("[metronome] QUIT", flush=True)
        with self._lock:
            self._running = False
            self._playing = False
            self._interrupt_audio_locked()

    def set_bpm(self, bpm: float):
        with self._lock:
            self.bpm = max(20.0, min(300.0, float(bpm)))
            # Recache waveforms at the new volume scaling (BPM doesn't change
            # waveform shape but we update for consistency).
            self._normal_click = self._click_waveform(self.volume)
            accent_vol = self.volume if self.accent == 1 else self.volume * 0.7
            self._accent_click = self._click_waveform(accent_vol)
        print(f"[metronome] BPM → {self.bpm:.1f}", flush=True)

    def set_beats(self, beats: int):
        with self._lock:
            self.beats = max(1, int(beats))
            self.accent = min(self.accent, self.beats)
            accent_vol = self.volume if self.accent == 1 else self.volume * 0.7
            self._accent_click = self._click_waveform(accent_vol)
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
            elif cmd == "click":
                # Determine accent from beat index — default to normal (beat 1).
                # The controller sends the is_accent flag as an optional arg.
                is_accent = len(parts) >= 2 and parts[1].lower() in ('1', 'true', 'yes')
                metronome._emit_click(is_accent)
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
