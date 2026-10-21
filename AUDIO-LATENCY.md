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
- Audio latency offset: the UI slider sets a signed value in ms (-200 to 200,
  default -30). Negative values send clip notes earlier; positive values
  send them later. Both internal and external MIDI clock playback apply
  the shift (external timing rounds to the nearest 24-PPQN tick). Note-off keeps its
  duration relative to its note-on. The DAW beat grid is not changed.
- Recording follows the same offset. Clip notes are sent `audioOffsetMs`
  after their grid time, so a key pressed in time with what the performer
  hears is stored at `press - audioOffsetMs` on the grid. This applies to
  pad/keyboard presses, the bar-line start and stop of a take, and the
  count-in. The wall clock is converted to grid time once at each entry
  point (`DAWEngine._pressTime`, `_gridToWall`). The click offset is not
  used for recording.
- A finished take starts looping at its shifted recording-stop boundary,
  without waiting for another global cycle. The shift is applied once:
  recording uses wall time minus the offset, and playback uses grid time
  plus the offset. Opening notes already due at handoff play immediately;
  later loop passes retain the configured advance or delay. Held notes
  closed at the end of a take use the same clip origin as released notes.

## Status

- The default of -30 ms is an estimate. It is not measured on hardware.
- Tests cover the software behavior only: one persistent stream is
  used, and note-on is scheduled the set amount earlier.
- Audible sync has not been verified. Tune the slider by ear with a
  metronome and clip notes playing together, then record the value that
  sounds aligned.

## Future work

- Measure the remaining delay once with a loopback recording and compare
  the click with the MIDI note.
- Support separate calibration per output device. The current audio and
  click offsets are saved globally in the router settings.
