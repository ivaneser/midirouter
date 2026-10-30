#!/usr/bin/env python3
"""
=====================================================
  Precise Raspberry Pi Metronome  (headphone output)
=====================================================

Generates sample-accurate metronome clicks triggered by authoritative DAW beat
events.  Each incoming ``click`` command plays exactly one click through a single
persistent ALSA ``aplay -M`` stream fed from the audio thread's pipe.
Continuous free-running playback is no longer used -- beats are driven externally
(internal or external clock).

IPC Controls (via stdin)
------------------------
    start         # Start playing clicks (audio-ready; actual clicks come via ``click``)
    stop          # Stop playing clicks (silence)
    monitor <1|0> # Mix the router's live audio input into the output (with the clicks) on/off
    bpm <n>       # Change BPM (stored for volume / accent calculations)
    beats <n>     # Change beats per measure
    click         # Play one metronome click immediately
    status        # Print current status as JSON
    quit          # Stop and exit
"""

import argparse
import fcntl
import os
import math
from array import array
import signal
import subprocess
import sys
import threading
import json
import time
import urllib.request

# ---------------------------------------------------------------------------
# Audio constants
# ---------------------------------------------------------------------------
SAMPLE_RATE = 44100
CLICK_FREQ  = 1000       # normal click (off-beats)
ACCENT_FREQ = 2000       # accent click (first beat of bar -- higher pitch)
CLICK_DUR   = 0.05
VOLUME      = 0.8
# One persistent aplay is fed continuously (silence + mixed-in clicks), in
# chunks of CHUNK_FRAMES. aplay reads raw stdin in whole periods and blocks
# until one is full, so a stream that only receives clicks sits on them and
# then plays them in bursts. A continuous feed avoids that.
PERIOD_FRAMES = 512                       # aplay period (1024 bytes S16_LE mono)
BUFFER_FRAMES = 4096                      # ~93 ms ALSA buffer (constant latency)
CHUNK_FRAMES  = 512                       # feeder write size (~11.6 ms)
PIPE_BYTES    = 4096                      # small pipe => writes block at real time
F_SETPIPE_SZ  = 1031                    # Linux fcntl constant
MAX_ACTIVE_CLICKS = 8
# Monitoring: the router's live audio input (GET /audio/live, 44.1 kHz mono S16_LE) is mixed into the
# output. The capture device and the output run on different clocks, so a small cushion is kept:
# playback starts once MONITOR_PRIME_MS is buffered, and when more than MONITOR_MAX_MS piles up the
# oldest audio is dropped (a rare tiny skip instead of a growing delay).
MONITOR_URL = os.environ.get("MIDIR_AUDIO_URL", "http://127.0.0.1:3000/audio/live")
MONITOR_PRIME_MS = 60
MONITOR_MAX_MS = 250
MONITOR_KEEP_MS = 100
# Time from writing a click into the stream to hearing it: the ALSA buffer plus the
# pipe backlog. Estimated from the sizes above; tune with MIDIR_CLICK_LATENCY_MS.
CLICK_LATENCY_MS = float(os.environ.get(
    "MIDIR_CLICK_LATENCY_MS",
    (BUFFER_FRAMES + PIPE_BYTES // 2) * 1000.0 / SAMPLE_RATE))
# Tuned by ear from the UI: negative = click earlier, positive = later.
CLICK_OFFSET_MS = 0.0


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
    # Defaults for the monitor state, so a Metronome built without __init__ (as the tests do) still works.
    _monitor = False
    _monitor_primed = False
    _monitor_thread = None

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
        self._audio_process = None  # single persistent aplay, fed by the feeder
        self._last_click_time = 0.0
        self._active = []           # [samples(array 'h'), position, queued_at] clicks to mix in
        self._scheduled = set()     # threading.Timer objects for predicted clicks
        self._last_write_done = 0.0  # monotonic time last chunk write finished (feeder thread only)
        self._wake = threading.Event()
        # Monitoring of the live input (see MONITOR_*).
        self._monitor = False
        self._monitor_buf = bytearray()
        self._monitor_lock = threading.Lock()
        self._monitor_primed = False
        self._monitor_stop = threading.Event()
        self._monitor_thread = None

        # Cached waveform for fast per-click emission.
        self._normal_click = self._click_waveform(self.volume, CLICK_FREQ)
        self._accent_click = self._click_waveform(
            self.volume * (1.0 if self.accent == 1 else 0.7), ACCENT_FREQ)

    # -- sample generation -------------------------------------------------
    def _click_waveform(self, amplitude: float, freq: int = CLICK_FREQ) -> bytes:
        n = int(CLICK_DUR * SAMPLE_RATE)
        data = bytearray(n * 2)
        for i in range(n):
            t = i / SAMPLE_RATE
            env = amplitude * math.exp(-t / 0.008) * math.sin(2 * math.pi * freq * t)
            val = int(math.copysign(min(abs(env), 1.0), env) * 32767)
            data[i * 2]     = val & 0xFF
            data[i * 2 + 1] = (val >> 8) & 0xFF
        return bytes(data)

    # -- audio feeder (runs in its own thread) ----------------------------
    def _open_stream(self) -> subprocess.Popen:
        cmd = ["aplay", "-M",
               "-D", self.alsa_device,
               "-r", str(SAMPLE_RATE),
               "-f", "S16_LE",
               "-c", "1",
               "-t", "raw",
               f"--period-size={PERIOD_FRAMES}",
               f"--buffer-size={BUFFER_FRAMES}"]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                                stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)
        try:
            fcntl.fcntl(proc.stdin.fileno(), F_SETPIPE_SZ, PIPE_BYTES)
        except OSError:
            pass
        return proc

    def _next_chunk(self) -> bytes:
        """Silence plus any clicks that are due, for the next CHUNK_FRAMES.

        A not-yet-started click is placed at the frame offset matching when it
        was queued relative to the last completed chunk write, so consecutive
        clicks keep their true spacing instead of all starting at chunk 0
        (which makes near-simultaneous queueing audible as pairs).
        """
        with self._lock:
            out = array('h', bytes(CHUNK_FRAMES * 2))
            ref_time = self._last_write_done
            still = []
            for clip in self._active:
                samples, pos, queued_at = clip
                off = int((queued_at - ref_time) * SAMPLE_RATE) if pos == 0 else 0
                if off < 0:
                    off = 0               # queued during/after this chunk's write began
                elif off >= CHUNK_FRAMES:   # not in this chunk; try the next one
                    still.append(clip)
                    continue
                n = min(CHUNK_FRAMES - off, len(samples) - pos)
                for i in range(n):
                    v = out[off + i] + samples[pos + i]
                    out[off + i] = max(-32768, min(32767, v))
                clip[1] = pos + n
                if clip[1] < len(samples):
                    still.append(clip)
            self._active = still
        if self._monitor:
            self._mix_monitor(out)
        return out.tobytes()

    def _feed_loop(self):
        """Keeps aplay fed while playing. Blocking writes pace it to real time."""
        print("[metronome] Audio feeder started", flush=True)
        proc = None
        while self._running:
            with self._lock:
                playing = self._playing or self._monitor
                if not self._playing:
                    self._active = []
            if not playing:
                if proc is not None:
                    self._close_proc(proc)
                    proc = None
                    with self._lock:
                        self._audio_process = None
                self._wake.wait(0.2)
                self._wake.clear()
                continue
            if proc is None or proc.poll() is not None:
                try:
                    proc = self._open_stream()
                except FileNotFoundError:
                    print("[metronome] Error: 'aplay' not found. Install alsa-utils.",
                          file=sys.stderr, flush=True)
                    break
                with self._lock:
                    self._audio_process = proc
                # Anchor sub-chunk click placement to the fresh stream.
                self._last_write_done = time.monotonic()
            try:
                proc.stdin.write(self._next_chunk())
                proc.stdin.flush()
                self._last_write_done = time.monotonic()
            except (BrokenPipeError, OSError):
                self._close_proc(proc)
                proc = None
                with self._lock:
                    self._audio_process = None
        if proc is not None:
            self._close_proc(proc)
        with self._lock:
            self._audio_process = None
        print("[metronome] Audio feeder exited", flush=True)

    @staticmethod
    def _close_proc(proc: subprocess.Popen):
        try:
            proc.stdin.close()
        except OSError:
            pass
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.terminate()

    # -- scheduled clicks (predicted beats) ----------------------------
    def schedule_click(self, is_accent: bool, delay_ms: float):
        """Play one click delay_ms from now, compensated for audio latency.

        The router predicts the next beat from the external MIDI clock and asks for
        the click ahead of time; the latency here makes it sound on that beat.
        """
        lead_s = (delay_ms - CLICK_LATENCY_MS - CLICK_OFFSET_MS) / 1000.0
        if lead_s <= 0.0:
            self._emit_click(is_accent)
            return
        with self._lock:
            if not self._playing:
                return
            self._scheduled = {t for t in self._scheduled if t.is_alive()}
            timer = threading.Timer(lead_s, self._emit_click, args=(is_accent,))
            timer.daemon = True
            self._scheduled.add(timer)
        timer.start()

    def _cancel_scheduled(self):
        with self._lock:
            pending = getattr(self, "_scheduled", set())
            self._scheduled = set()
        for timer in pending:
            timer.cancel()

    # -- monitoring of the live input -----------------------------------------
    def set_monitor(self, on: bool):
        """Start or stop mixing the router's live audio into the output."""
        if on:
            if self._monitor:
                return
            self._monitor = True
            self._monitor_stop.clear()
            with self._monitor_lock:
                self._monitor_buf.clear()
                self._monitor_primed = False
            if self._monitor_thread is None or not self._monitor_thread.is_alive():
                self._monitor_thread = threading.Thread(target=self._monitor_loop, daemon=True)
                self._monitor_thread.start()
            print(f"[metronome] MONITOR on ({MONITOR_URL})", flush=True)
        else:
            if not self._monitor:
                return
            self._monitor = False
            self._monitor_stop.set()
            with self._monitor_lock:
                self._monitor_buf.clear()
            print("[metronome] MONITOR off", flush=True)
        self._wake.set()

    def _monitor_push(self, data: bytes):
        """Add captured audio (S16_LE mono). Keeps the cushion bounded."""
        with self._monitor_lock:
            self._monitor_buf += data
            limit = int(SAMPLE_RATE * MONITOR_MAX_MS / 1000) * 2
            if len(self._monitor_buf) > limit:
                keep = int(SAMPLE_RATE * MONITOR_KEEP_MS / 1000) * 2
                del self._monitor_buf[:len(self._monitor_buf) - keep]

    def _monitor_pull(self, frames: int) -> bytes:
        """The next `frames` samples of monitored audio, padded with silence when it ran short."""
        need = frames * 2
        with self._monitor_lock:
            if not self._monitor_primed:
                if len(self._monitor_buf) < int(SAMPLE_RATE * MONITOR_PRIME_MS / 1000) * 2:
                    return bytes(need)
                self._monitor_primed = True
            chunk = bytes(self._monitor_buf[:need])
            del self._monitor_buf[:need]
            if len(chunk) < need:
                self._monitor_primed = False   # ran dry: build the cushion up again
                chunk += bytes(need - len(chunk))
            return chunk

    def _mix_monitor(self, out: "array"):
        samples = array('h')
        samples.frombytes(self._monitor_pull(len(out)))
        for i, v in enumerate(samples):
            if v:
                total = out[i] + v
                out[i] = -32768 if total < -32768 else 32767 if total > 32767 else total

    def _monitor_loop(self):
        """Follow the router's live audio while monitoring; reconnect when it is not there yet."""
        while self._monitor and not self._monitor_stop.is_set():
            try:
                with urllib.request.urlopen(MONITOR_URL, timeout=5) as response:
                    rate = int(response.headers.get("X-Sample-Rate", SAMPLE_RATE))
                    if rate != SAMPLE_RATE:
                        print(f"[metronome] MONITOR: stream is {rate} Hz, expected {SAMPLE_RATE}", flush=True)
                        self._monitor_stop.wait(5)
                        continue
                    while self._monitor and not self._monitor_stop.is_set():
                        data = response.read(2048)
                        if not data:
                            break
                        if len(data) % 2:
                            data = data[:-1]   # whole samples only
                        self._monitor_push(data)
            except Exception as exc:   # router restarting, no audio device yet, ...
                print(f"[metronome] MONITOR: {exc}", flush=True)
            self._monitor_stop.wait(2)

    # -- control API -------------------------------------------------------
    def start(self):
        with self._lock:
            if not self._playing:
                self._playing = True
                self._last_click_time = 0.0
                print(f"[metronome] START  BPM={self.bpm:.1f}  beats={self.beats}  accent={self.accent}  vol={self.volume:.2f}", flush=True)
            else:
                print("[metronome] Already playing", flush=True)
        self._wake.set()

    def stop(self):
        self._cancel_scheduled()
        with self._lock:
            if self._playing:
                self._playing = False
                self._active = []
                print("[metronome] STOP", flush=True)
            else:
                print("[metronome] Already stopped", flush=True)
        self._wake.set()

    def quit(self):
        print("[metronome] QUIT", flush=True)
        self._monitor = False
        stop_monitor = getattr(self, "_monitor_stop", None)
        if stop_monitor is not None:
            stop_monitor.set()
        self._cancel_scheduled()
        with self._lock:
            self._running = False
            self._playing = False
            self._active = []
        self._wake.set()

    def set_bpm(self, bpm: float):
        with self._lock:
            self.bpm = max(20.0, min(300.0, float(bpm)))
            # Recache waveforms at the new volume scaling (BPM doesn't change
            # waveform shape but we update for consistency).
            self._normal_click = self._click_waveform(self.volume, CLICK_FREQ)
            accent_vol = self.volume if self.accent == 1 else self.volume * 0.7
            self._accent_click = self._click_waveform(accent_vol, ACCENT_FREQ)
        print(f"[metronome] BPM -> {self.bpm:.1f}", flush=True)

    def set_beats(self, beats: int):
        with self._lock:
            self.beats = max(1, int(beats))
            self.accent = min(self.accent, self.beats)
            accent_vol = self.volume if self.accent == 1 else self.volume * 0.7
            self._accent_click = self._click_waveform(accent_vol, ACCENT_FREQ)
        print(f"[metronome] Beats -> {self.beats}", flush=True)

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
                "monitor": self._monitor,
            }

    def _emit_click(self, is_accent: bool):
        """Public API -- queue one click for the feeder to mix into the stream."""
        with self._lock:
            if not self._playing or not self._running:
                return
            # Skip duplicate clicks within 10 ms to avoid double-fires.
            now = time.monotonic()
            if now - self._last_click_time < 0.01:
                return
            self._last_click_time = now
            data = self._accent_click if is_accent else self._normal_click
            if len(self._active) >= MAX_ACTIVE_CLICKS:
                self._active.pop(0)
            samples = array('h')
            samples.frombytes(data)
            self._active.append([samples, 0, time.monotonic()])


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
            elif cmd == "offset" and len(parts) >= 2:
                try:
                    set_click_offset(float(parts[1]))
                except ValueError:
                    print(f"[metronome] Invalid offset: {parts}", flush=True)
            elif cmd == "clickin" and len(parts) >= 3:
                # clickin <delay_ms> <accent 0|1>: a click due delay_ms from now.
                try:
                    metronome.schedule_click(parts[2].lower() in ('1', 'true', 'yes'), float(parts[1]))
                except ValueError:
                    print(f"[metronome] Invalid clickin: {parts}", flush=True)
            elif cmd == "click":
                # Determine accent from beat index -- default to normal (beat 1).
                # The controller sends the is_accent flag as an optional arg.
                is_accent = len(parts) >= 2 and parts[1].lower() in ('1', 'true', 'yes')
                metronome._emit_click(is_accent)
            elif cmd == "monitor" and len(parts) >= 2:
                metronome.set_monitor(parts[1].lower() in ('1', 'true', 'on', 'yes'))
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


def set_click_offset(ms: float):
    """Shift every click: negative = earlier, positive = later (tuned by ear)."""
    global CLICK_OFFSET_MS
    CLICK_OFFSET_MS = max(-200.0, min(200.0, float(ms)))
    print(f"[metronome] Click offset -> {CLICK_OFFSET_MS:.0f} ms", flush=True)


def _handle_sigusr1(signum, frame):
    print("[metronome] SIGUSR1 -> toggle play/stop", flush=True)
    # Can't easily toggle without reference; signals mainly for systemd graceful stop
    pass


def main():
    parser = argparse.ArgumentParser(
        description="Precise Raspberry Pi Metronome (headphone output)")
    parser.add_argument("-B", "--bpm", type=float, default=120, help="BPM")
    parser.add_argument("-b", "--beats", type=int, default=4, help="Beats/measure")
    parser.add_argument("-a", "--accent", type=int, default=1, help="Accent beat")
    parser.add_argument("-v", "--volume", type=float, default=VOLUME, help="Volume 0.0-1.0")
    parser.add_argument("-d", "--device", type=str, default=None, help="ALSA device")
    args = parser.parse_args()

    metro = Metronome(bpm=args.bpm, beats_per_bar=args.beats,
                      accent_beat=args.accent, volume=args.volume,
                      alsa_device=args.device)

    # Start audio feeder (idle until 'start' command)
    playback_thread = threading.Thread(target=metro._feed_loop, daemon=True)
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
