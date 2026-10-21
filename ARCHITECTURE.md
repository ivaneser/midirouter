# MIDI Router architecture

## Runtime

| Component | Responsibility |
|---|---|
| `server.js` | HTTP/static files, WebSocket clients, worker lifecycle, UI command translation, host shutdown |
| `worker-midi.js` | Opens RtMidi ports, routes MIDI, schedules clip notes, records input, manages clock and LED feedback |
| `daw.js` | Tracks/clips, recording sessions, quantization, transport and metronome beat events |
| `clock-master.js` / `external-midi-clock.js` | Selected clock source, fanout, external tempo and phase tracking |
| `metronome-controller.js` / `metronome.py` | Child-process IPC and local ALSA audio clicks |
| `frontend/js/app.js` | WebSocket connection and frontend message dispatch |
| `frontend/js/daw-ui.js` | Session grid, transport, saved sessions and clip progress |
| `frontend/js/device-manager.js` | Connected device cards and instrument parameter panels |
| `frontend/js/connected-devices.js` | Input/output pairing, inventory deduplication and display names |
| `frontend/js/synth-catalog.js` | Model detection, JSON CC definitions, default values and CC encoding |
| `frontend/js/synth-layout.js` | Parameter group labels and sound-design order |
| `frontend/js/midi-knob.js` | Native range accessibility with vertical pointer dragging |

The Node.js processes use ES modules. MIDI ports use `@julusian/midi` (RtMidi),
WebSocket transport uses `ws`, and the Pi metronome requires Python 3 and ALSA
`aplay`. The HTTP server starts before MIDI initialization so its UI remains
reachable if hardware initialization fails.

## Routing and recording

Input callbacks enter `_onIncomingMessage`. Clock and transport messages are
handled separately from performance notes. Only the selected external master
supplies timing; notes from other inputs can still be recorded. Note recording
is independent of the controller pad-learning registry and rejects timestamps
before the scheduled recording start.

With no custom mappings, messages use all-to-all routing with controller output
exclusions. Configured mappings use the shared `computeRoutingStep` decision path
in `route-midi.js`, including route filters and CC mapping. JSON controller
profiles define pads, transport actions and feedback; see [CONTROLLERS.md](CONTROLLERS.md).

The worker handles hot-plug enumeration and ALSA subscription recovery. Inventory
contains complete port IDs; frontend display-name cleanup does not rewrite them.

## Clip scheduling and progress

Internal playback stores each active clip's `originMs`, `loopBeats`,
`msPerBeat` and audio offset. Note callbacks schedule against absolute deadlines.
External playback stores `startTick`, `loopTicks`, note events and pending note-offs.
Each clip repeats according to its own length.

`_clipPlaybackProgress()` derives normalized progress from those active playback
records. Internal progress uses the captured playback offset; external progress
uses the master's tick count and the tick-rounded offset. Queued or stopped clips
do not report progress. A clip whose slot has changed does not report stale progress.

The worker includes `clipProgress: [{ trackIdx, slot, progress }]` in both
`daw_progress.payload` and `daw_state.state`. The server forwards progress and
converts state to the frontend payload. Transport progress normally updates every
50 ms. The frontend updates fill transforms without rebuilding clip buttons;
wrapping snaps to the left instead of animating backwards. Clip bars also work
while an existing clip loops during overdubbing.

Recording converts wall time to grid time by subtracting the audio offset.
Playback adds that offset once. Finished takes start looping at the shifted
stop boundary. See [AUDIO-LATENCY.md](AUDIO-LATENCY.md).

## Instrument controls

Supported panels load local JSON maps for Craft Synth, NTS-1 and MicroFreak.
Groups follow oscillators, tone shaping, envelopes, effects, modulation and
performance controls. Knobs keep a native range input for keyboard/screen-reader
support; dragging changes values without a jump on initial touch. Shift enables
fine adjustment. Rendering never sends MIDI; user changes send to the output ID
of the paired device card. The existing CC builder emits channel-1 messages.
Values are local UI settings, not a readback of the hardware patch.

Map files and their limitations are described in [DEVICE-MAPPING.md](DEVICE-MAPPING.md).

## Persistence and setup

- `sessions/*.json`: recorded session content via `DAWEngine.toData()` / `loadData()`.
- `settings.json`: global calibration settings, including audio and click offsets.
- `controller_profiles/*.json`: controller input, transport and feedback definitions.
- `device_maps/*.json`: instrument CC maps and separate DAW/config presets.
- `midirouter.service`: server autostart; the worker owns the metronome process.
- `setup-shutdown-permissions.sh`: validates the service user's exact shutdown rule
  with `visudo`, then installs it as root with mode `0440`.

## Power-off behavior and current limitations

The web Power off button sends `shut-down`. `performShutdown()` stops the router,
closes clients and runs `sudo /sbin/shutdown -h now`. Bootstrap, autostart setup and
the legacy installer provision permission for their configured service user.

SIGINT currently invokes the same host-power-off function. A failed power-off
request is logged after clients disconnect; the server still exits and the
`Restart=always` unit can restart it. Permission installation does not change
this failure behavior. Do not interpret a disconnected UI as proof of host shutdown.

Software tests cover scheduling, CC encoding, device pairing, knob gestures,
progress rendering and mocked sudoers installation. Physical iOS Safari behavior,
Pi audio timing and every instrument parameter remain hardware validation tasks.
