# Audio metronome and MIDI Clock

## Shared musical timing

The DAW transport selects internal MIDI Clock or one external master. MIDI Clock
uses `0xF8` at 24 pulses per quarter note; it is not MIDI Time Code (MTC).
Metronome beat events follow the DAW timing. No click notes are sent to MIDI synths.

Open **Timing settings** to set tempo, quantization, beats per bar and the metronome.
The section starts collapsed on phones. Choose a clock source in **Devices & sync**.

| Message | Byte | Meaning |
|---|---|---|
| Start | `0xFA` | Start transport |
| Continue | `0xFB` | Continue transport |
| Stop | `0xFC` | Stop transport |
| Clock | `0xF8` | 24 ticks per quarter note |

Only the selected external master's clock/transport messages drive synchronization.
Its clock is forwarded to allowed outputs, excluding the source and configured
exclusions. Controller profiles select controller clock destinations. Performance
notes from any input remain recordable independently of clock-master selection.
A clock-only source can start the transport on its first tick. Loss of external
clock for more than 750 ms invokes the internal fallback; see [DEBUGGING.md](DEBUGGING.md).

## Raspberry Pi audio

`worker-midi.js` owns `MetronomeController`, which starts `metronome.py` and sends
beat commands. The Python process feeds PCM into a persistent ALSA `aplay -M`
stream while playing. It does not create temporary WAV files for each click.
The feeder waits while stopped instead of busy-spinning.

- Mono PCM at 44,100 Hz, 16-bit samples.
- Normal click: generated 1 kHz decaying sine burst.
- Accent: generated 2 kHz click on the bar's first beat.
- Click duration: 50 ms.
- ALSA period: 512 frames; buffer: 4096 frames.
- Custom sound upload is not implemented.

ALSA buffering and the physical audio path introduce latency; sample generation
does not eliminate scheduling jitter or guarantee perfect audible synchronization.
Use the calibration controls and verify timing on the actual Pi.

The process automatically looks for the headphone device. Override it in the
server service environment if needed:

```ini
Environment="MIDIR_METRONOME_DEVICE=hw:Headphones"
```

Use `aplay -L` to find the correct device name. `metronome.service` is obsolete;
setup disables it so it does not compete with the router-owned process.

## Calibration

In **Devices & sync → Clock & calibration**:

- **Audio offset** shifts clip MIDI notes, -200..200 ms, default -30 ms.
- **Click offset** shifts audio clicks, -200..200 ms, default 0 ms.
- Audio offset: negative values advance notes; positive values delay them.
- The click slider is labeled with the same sign convention, but the current
  Python `clickin` implementation subtracts its click offset from the lead time:
  positive values advance predicted clicks. Direct `click` commands do not use
  that offset. This mismatch remains a calibration limitation; verify by ear.

Settings are stored globally in `settings.json`. Recording compensates the audio
offset once; the separate click offset is not applied to note capture. External
note offsets round to the nearest MIDI tick. See [AUDIO-LATENCY.md](AUDIO-LATENCY.md).

Playing clips also show a progress bar based on their own playback origin and
loop length, including the output shift. It resets left at each loop boundary.
Progress describes MIDI scheduling, not measured sound from a synthesizer.

## Manual audio diagnosis

Normally let the router own the audio process. For standalone diagnosis, stop the
router service, then run:

```bash
python3 metronome.py -d hw:Headphones
```

Type `start`, then `click 1` for an accent or `click 0` for a normal click.
`start` alone does not run a separate beat clock. Other stdin commands include
`bpm 120`, `beats 4`, `offset 0`, `clickin 500 1`, `status`, `stop` and `quit`.
The worker normally sends these commands; avoid running two audio owners together.

Software tests cover beat events, clock routing, audio feeder behavior and
calibration math. Actual headphone latency and instrument synchronization require
hardware validation.
