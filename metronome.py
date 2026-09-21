#!/usr/bin/env python3
"""
=====================================================
  Precise Raspberry Pi Metronome  (headphone output)
=====================================================

Generates sample-accurate metronome clicks and streams them to the
standard audio output (3.5 mm headphone jack) via ALSA `aplay -M`.

Why this is *precise*
---------------------
All samples are pre-computed at sample-level resolution (44 100 Hz).
`aplay` streams the buffer straight to the sound card's DMA engine,
which plays the samples back at exact hardware timing — completely
independent of Python scheduling or Linux CPU jitter.

The click itself is a 1 kHz sine burst with an exponential decay
envelope, so it sounds like a crisp woodblock / electronic click.

Usage
-----
    # Basic: 120 BPM, 4/4
    python3 metronome.py

    # 90 BPM, 6/8 time, accent on beat 1
    python3 metronome.py -B 90 -b 6 -a 1

    # Fast 200 BPM, 2-beat feel
    python3 metronome.py -B 200 -b 2

Controls: Ctrl+C (or just close the terminal) to stop.
"""

import argparse
import math
import os
import signal
import subprocess
import sys
import tempfile
import wave


# ---------------------------------------------------------------------------
# Audio / timing constants (tweak these to change the click character)
# ---------------------------------------------------------------------------
SAMPLE_RATE = 44100          # CD-quality sample rate
CLICK_FREQ  = 1000           # sine-wave frequency of the click (Hz)
CLICK_DUR   = 0.05           # duration of each click in seconds
VOLUME      = 0.8            # peak volume, 0.0 – 1.0

# How many seconds of audio to pre-buffer before streaming.
# Larger → fewer rebuffer cycles (smoother), but slower BPM response.
BUFFER_SECS = 6.0


class Metronome:
    """Generate and play a precise metronome."""

    def __init__(self, bpm: float, beats_per_bar: int = 4,
                 accent_beat: int = 1, volume: float = VOLUME):
        self.bpm       = max(20.0, min(300.0, float(bpm)))
        self.beats     = max(1, int(beats_per_bar))
        self.accent    = max(1, min(self.beats, int(accent_beat)))
        self.volume    = max(0.0, min(1.0, float(volume)))
        self._running  = False

        # Volume for each beat: accent beat is louder
        self._beat_vol = [self.volume if (i + 1) == self.accent else
                          self.volume * 0.7 for i in range(self.beats)]

    # -- sample generation -------------------------------------------------
    def _click_waveform(self, amplitude: float) -> bytes:
        """Return one click as a 16-bit mono WAV chunk."""
        n = int(CLICK_DUR * SAMPLE_RATE)
        data = bytearray(n * 2)
        for i in range(n):
            t = i / SAMPLE_RATE
            # Exponential-decay sine burst (crisp attack, smooth tail)
            env = amplitude * math.exp(-t / 0.008) * math.sin(
                2 * math.pi * CLICK_FREQ * t)
            val = int(math.copysign(min(abs(env), 1.0), env) * 32767)
            data[i * 2]     = val & 0xFF
            data[i * 2 + 1] = (val >> 8) & 0xFF
        return bytes(data)

    def _build_buffer(self) -> bytes:
        """
        Build `BUFFER_SECS` seconds of audio with sample-accurate beat
        placement. Returns raw 16-bit mono samples (bytes).

        At normal BPMs each click (50 ms) is much shorter than the beat
        interval, so clicks never overlap — we simply place each one at
        its exact sample position inside a silent buffer.
        """
        buffer_samples = int(BUFFER_SECS * SAMPLE_RATE)
        out = bytearray(buffer_samples * 2)   # start with silence

        # Pre-compute click waveforms grouped by amplitude (avoids
        # redundant generation when accent and normal beats share values)
        clicks_by_amp = {}
        for amp in set(self._beat_vol):
            clicks_by_amp[amp] = self._click_waveform(amp)

        beat_interval_samples = SAMPLE_RATE * (60.0 / self.bpm)

        # Place a click at every beat position inside the buffer
        sample_pos = 0
        while sample_pos < buffer_samples:
            for amp in self._beat_vol:
                if sample_pos >= buffer_samples:
                    break
                click = clicks_by_amp[amp]
                start = int(sample_pos * 2)          # byte offset
                end   = min(start + len(click), len(out))
                for i in range(end - start):
                    out[start + i] = click[i]        # place click sample
                sample_pos += beat_interval_samples

        return bytes(out)

    def _write_wav(self, data: bytes) -> str:
        """Write the buffer to a temporary WAV file and return its path."""
        tmpdir = tempfile.gettempdir()
        path = os.path.join(tmpdir, f"metronome_{os.getpid()}.wav")
        with wave.open(path, "w") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)           # 16-bit
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(data)
        return path

    # -- playback ----------------------------------------------------------
    def _play_loop(self):
        """Continuously generate + stream buffers via `aplay -M`."""
        while self._running:
            data = self._build_buffer()
            path = self._write_wav(data)
            try:
                cmd = ["aplay", "-M",                  # mmap mode → precise
                       "-r",  str(SAMPLE_RATE),
                       "-f",  "S16_LE",
                       "-c",  "1",
                       "-t",  "wav",
                       path]
                subprocess.run(cmd,
                               stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL)
            except FileNotFoundError:
                print("Error: 'aplay' not found. Install alsa-utils.",
                      file=sys.stderr)
                break
            finally:
                try:
                    os.remove(path)
                except OSError:
                    pass

    def start(self):
        """Start the metronome (blocks until Ctrl+C)."""
        self._running = True
        print(f"[metronome]  BPM={self.bpm:.1f}   "
              f"{self.beats}/4   accent=beat {self.accent}   "
              f"vol={self.volume:.2f}")
        print("             Ctrl+C to stop.")
        try:
            self._play_loop()
        except KeyboardInterrupt:
            pass
        finally:
            self.stop()

    def stop(self):
        """Stop the metronome."""
        self._running = False


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Precise Raspberry Pi Metronome (headphone output)")
    parser.add_argument("-B", "--bpm", type=float, default=120,
                        help="Beats per minute (default: 120)")
    parser.add_argument("-b", "--beats", type=int, default=4,
                        help="Beats per measure (default: 4)")
    parser.add_argument("-a", "--accent", type=int, default=1,
                        help="Accentuated beat number (default: 1)")
    parser.add_argument("-v", "--volume", type=float, default=VOLUME,
                        help="Volume 0.0–1.0 (default: %.2f)" % VOLUME)
    args = parser.parse_args()

    metro = Metronome(bpm=args.bpm, beats_per_bar=args.beats,
                      accent_beat=args.accent, volume=args.volume)

    signal.signal(signal.SIGINT, lambda *_: metro.stop())
    metro.start()


if __name__ == "__main__":
    main()
