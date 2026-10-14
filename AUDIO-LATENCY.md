# Audio latency and metronome sync

## Problem

Clip MIDI notes and the audible metronome click were not aligned. The
click reached the ear later than the DAW beat, by a delay that varied
from beat to beat.

## Cause

The DAW beat is driven by the MIDI clock, so the beat timing itself is
correct. The extra delay comes from the audio path after the beat is
decided:

1. Node writes a `click` line to the Python metronome's stdin.
2. The metronome process starts a new `aplay` process for each click.
3. ALSA, the sound card buffer, and the output device add a fixed delay.

Step 2 is the source of the jitter. Process startup time varies, so the
delay changes from click to click. A constant offset cannot remove
variation, only the average.

## Changes

- `metronome.py`: the per-click `aplay` spawn is replaced by one
  persistent `aplay -M` stream. Clicks are written into that stream by
  a dedicated daemon audio thread. No temporary WAV file is written per
  click. Stop and quit close the stream with a bounded wait.
- Audio latency offset: the UI slider sets a value in ms (0 to 300,
  default 30). The worker shifts clip note-on times earlier by this
  amount in the non-external-clock playback path. Note-off keeps its
  duration relative to its note-on. The DAW beat grid and recording are
  not changed.

## Status

- The default of 30 ms is an estimate. It is not measured on hardware.
- Tests cover the software behavior only: one persistent stream is
  used, and note-on is scheduled the set amount earlier.
- Audible sync has not been verified. Tune the slider by ear with a
  metronome and clip notes playing together, then record the value that
  sounds aligned.

## Future work

- Measure the remaining delay once with a loopback recording and compare
  the click with the MIDI note.
- Persist the chosen value per device if it differs between outputs.
