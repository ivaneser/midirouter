# MIDI Router / Looper (midirouter)

Web app + server on a Raspberry Pi for real-time MIDI routing and clip recording.
Controlled from a browser/smartphone over WebSocket; works with physical USB-MIDI devices.

## Features

### 1. MIDI router (all-to-all)
Automatically detects input and output MIDI ports and connects them all to each other in real time. Controllers, synthesizers, loopback — everything works right after connecting. **Hot-plug**: devices connect/disconnect without restarting the server.

### 2. DAW / Clip mode (Ableton Live style)
Turns the router into a mini DAW: each **MIDI channel = track**, a recorded pattern = **clip**. Controlled with the keys of the controller (LaunchKey, nanoPAD2 and any other):

| Concept | Implementation |
|---|---|
| Track (channel) | MIDI channel 1–16 (6 tracks by default; "+" after the last track adds one, max 16) |
| Clip slot | a recorded pattern on a channel |
| Empty pad → record, press again → stop | toggle; releasing the pad does nothing |
| Post-record: Play / Overdub | defines what happens when the initial recording stops: loop / keep playing and record layers |
| Clip length | its own whole number of bars (snapped up) |
| Recorded notes | tied to the tempo and quantized to the grid |
| Sessions | save/load recordings to disk (`sessions/*.json`) |

**How to play.** An empty clip always starts recording when its pad is pressed (any Post-record mode). Pressing the same pad again stops the recording at the bar line, and the clip moves to the selected **Post-record** mode: **Play** — the take starts looping (the next press stops it, the press after that plays it again); **Overdub** — the clip keeps looping and records a new layer on top; the next press switches it to Play. Pressing a new empty clip in the same group (track) stops the current clip and starts recording into the new one.

**Controller profiles:** input ports, pads, transport buttons and LED responses are defined by JSON files in `controller_profiles/`. The Launchkey Mini MK3 profile is enabled; an example for nanoPAD2 is in `controller_profiles/examples/` and needs to be checked against the device settings. Regular keys stay on the MIDI route to the synthesizers. For a new controller see [CONTROLLERS.md](CONTROLLERS.md).

### 3. Audio metronome → Raspberry Pi headphones
The Python metronome `metronome.py` generates clicks through ALSA `aplay` straight to the Raspberry Pi audio output. The Node.js worker controls it together with the DAW transport, tempo and bar size. Clicks go only to the audio output; synthesizers receive notes and MIDI Clock over MIDI, but never metronome notes.

### 4. MIDI Clock — syncing external devices
On Play the MIDI Clock (24 PPQN) starts; on Stop `0xFC` is sent. The clock goes to the MIDI outputs of the synthesizers and to the controllers selected in the profile's `midiClockOutput`. In the Launchkey Mini MK3 profile the DAW port receives the clock to sync the blinking LEDs.

Incoming MIDI Clock also works as an external master: Start/Continue/Stop control the transport, the tempo and clip phase follow the bars, and notes are played on the 24 pulses per beat. A source without Start automatically starts the transport on the first pulse. While an external clock is arriving, the internal generator is paused; after losing the clock for more than 750 ms the router returns to the internal tempo. For the Launchkey, enable MIDI Clock Output in the controller settings.

### 5. Controller LEDs
The profile defines the MIDI messages for clip states: **playing**, **recorded**, **recording**, **off**. For other devices, Note, CC or SysEx bytes can be defined in JSON.

Launchkey Mini MK3 (DAW port, colours via Note On velocity): **playing** — the last activated playing clip: blinking cyan (ch2, vel 37); **active** — other playing clips: steady cyan (ch1, vel 37); **idle** — stopped but recorded: pulsing cyan (ch3, vel 37); **recording** — blinking red (ch2, vel 5); **off** — note off. LKM3 channels: ch1 — steady colour, ch2 — blinking (period 1 beat), ch3 — pulsing (period 2 beats).

### 6. MIDI device list
Open **Devices & sync** to see connected ports and expand instrument parameters.
Matching input/output entries share one card, and parameter controls target the
output ID. Repeated ALSA name prefixes are shortened for display; distinct devices
and DAW/performance ports remain identifiable. Raw port IDs are kept for routing.

Supported instrument panels:

| Instrument | Controls | Map |
|---|---|---|
| Modal Craft Synth 2.0 | 18 parameters | `modal_craft_synth_v2.json` |
| Korg NTS-1 digital kit | 29 parameters | `korg_nts1.json` |
| Arturia MicroFreak | 21 parameters | `arturia_microfreak.json` |

Continuous parameters use rotary knobs: drag up/down, hold Shift for fine control,
or use keyboard arrows. Readouts show the UI value; values are not read back from
the instrument. Selectors and switches are used for discrete parameters. Opening a
panel sends no MIDI. Bipolar knobs start at zero with the pointer centered; for
-64..63 controls, displayed zero sends MIDI value 64.

Groups follow sound design: sound/oscillators → filter/amplifier → envelopes
(including cycling envelope) → effects → modulation → performance controls.
See [DEVICE-MAPPING.md](DEVICE-MAPPING.md) for map formats and supported parameters.

### 7. Responsive session workspace
The dark interface adapts to phone, tablet and desktop widths. Controls have touch
sized targets, safe-area spacing and visible keyboard focus. Timing settings start
collapsed below 700px and expanded on larger screens; either can be toggled manually.
Recent-session shortcuts are hidden on phones; saved sessions remain available via Load.

Each **playing clip has a progress bar** that fills left to right over its own loop
length and restarts at the end. Bars follow the worker playback origin and audio
shift, or external MIDI ticks. Clips of different lengths progress independently;
queued clips do not advance before playback begins, and stopped clips show no bar.

## Quick start

### One-time setup (new Pi / new SD card)
```bash
ssh pi@<ip>
sudo bash ~/myprojects/midirouter/bootstrap.sh
# The script installs Node.js and ALSA itself, adds the user to the audio group,
# enables autostart, grants the service user web power-off permission, and reboots the Pi.
```

### Daily start (if autostart is not needed)
```bash
cd ~/myprojects/midirouter
npm start          # start server.js
# open http://<ip-pi>:3000
```

### Check that it works
```bash
sudo systemctl status midirouter.service   # server status
sudo journalctl -u midirouter.service -n 30 # logs
aconnect -i                                 # list of MIDI ports
```

Requirements: Raspberry Pi running Linux, a USB-MIDI controller/synthesizer, ALSA (`/dev/snd`), alsa-utils, Python 3. The `midirouter` service user must have access to the `audio` group.

The project has been used on Pi 4. Pi 3 models are expected to work, but timing and
memory use have not been benchmarked on a Pi 3A+. Use a headless OS and open the
web UI on another device; a powered USB hub can supply multiple instruments.

**ALSA device for headphones:**
- The metronome automatically looks for `hw:Headphones` or `headphones` through `aplay -L`.
- To force a choice, set `MIDIR_METRONOME_DEVICE`, for example `hw:0,0`, in the service environment.

## Controls
- **Post-record (behaviour when the initial recording stops):** Play / Overdub (in the web UI).
- **Tempo + Tap:** in the expandable Timing settings section.
- **Devices & sync:** clock master, audio/click offsets, and instrument knobs.
- **Power off:** asks for confirmation, then requests Raspberry Pi shutdown. Setup
  installs the required sudoers rule; see [SETUP.md](SETUP.md). Current server
  SIGINT handling also requests host shutdown. See the limitations in [ARCHITECTURE.md](ARCHITECTURE.md).
- **Clips per track:** 2 by default; "+" under a track adds an empty clip (max 16); "-" removes its last clip, and on a track's only clip removes the whole track. Long-press (≈600 ms) a recorded clip to clear it.
- **Auto-assign pads:** turns the automatic key mapping on/off.
- **Sessions:** 💾 Save / ⏬ Load — save/load recordings (all clips) to disk in `sessions/*.json`; a dialog asks for the name after the button is pressed.
- **Configuration presets:** save/load routing settings (`device_maps/daw_*.json`, tab ⚙️ MIDI Routing).

### How to play (LaunchKey or any MIDI controller)
1. Empty pad = **record**: press it — recording starts; press the same pad again — recording stops.
2. After stopping, the clip moves to the state of the selected **Post-record** mode:
   - **Play** — the take starts looping; press = stop, another press = play again.
   - **Overdub** — the take ends at the bar line and the clip enters the overdub status: it keeps looping and records new notes as a layer; the next press ends the overdub at the bar line and the clip moves to Play. On a stopped clip, a press starts a new overdub layer.
3. Pressing a **new empty clip in the same group** stops the current clip and starts recording into the new one.
4. **Launchkey transport buttons:** Play (CC115) — toggles the transport (MIDI Clock + metronome + active clips), Stop (CC116) — stops everything, Record (CC117) — turns Session Record on/off without deleting clips. When switched on, the transport and metronome start; press an empty pad to choose the clip to record. If the transport was stopped by Record, the transport starts without a count-in and the first take starts at the next bar line. Pressing Record again finishes the take at the nearest bar boundary. Loop (CC118) switches the length of the global cycle.

### Pad lights (LaunchKey Mini MK3 RGB)
The pads light up through Note On on the **Launchkey DAW Port** (bottom row of Session mode — notes 112–119, top row — 96–103):
- **Blinking cyan** (ch2, vel 37) — the last activated clip, playing in a loop.
- **Steady cyan** (ch1, vel 37) — other playing clips.
- **Pulsing cyan** (ch3, vel 37) — clip recorded but stopped.
- **Blinking red** (ch2, vel 5) — recording in progress.
- **Off** — empty clip (or after a Reset).

LKM3 channels: ch1 — steady colour, ch2 — blinking (period = 1 beat), ch3 — pulsing (period = 2 beats); the colour is chosen by the Note On velocity. An identical noteOn is not sent again — otherwise the LKM3 flickers the LED.

## Project structure
```
midirouter/
├── server.js              # HTTP + WS + worker control + DAW API
├── worker-midi.js         # Worker thread: MIDI routing + DAW timing
├── controller-engine.js   # Loads and runs the JSON controller profiles
├── controller_profiles/   # Pads, transport, LEDs, MIDI port selection
├── daw.js                 # DAW engine (clips, tempo, recording, playback)
├── metronome.py           # Audio metronome → Raspberry Pi headphones (ALSA aplay)
├── metronome-controller.js # Node.js metronome controller (stdin IPC)
├── midi-clock.js          # MIDI Clock: 24 PPQN + Start/Stop
├── metronome.service      # obsolete unit; bootstrap removes it
├── midirouter.service     # systemd unit for the server itself
├── setup-shutdown-permissions.sh # Validates and installs the web power-off rule
├── bootstrap.sh           # One-time setup: Wi-Fi + Node.js + ALSA + autostart
├── frontend/
│   ├── index.html         # Page with the router and DAW panels
│   ├── css/style.css
│   └── js/
│       ├── app.js              # Main UI logic + WS
│       ├── daw-ui.js           # DAW web UI: pad grid, sessions, transport
│       ├── device-manager.js   # Device and synthesizer cards
│       ├── synth-catalog.js    # Output classification + CC map loading
│       ├── synth-layout.js     # Sound-design group order
│       ├── midi-knob.js        # Pointer/keyboard rotary controls
│       └── connected-devices.js # Input/output pairing + display names
├── device_maps/           # Configuration presets (daw_*.json) and synthesizer CC maps
├── sessions/              # Recording sessions: sessions/<name>.json
└── *.md                   # Documentation (SPEC, ARCHITECTURE, etc.)
```

## Listen page

A separate, listen-only page for many devices: `http://<pi>/` (port 80; on the hotspot `http://10.0.0.1/`).
One big round play button in the middle shows the voice level; a psychedelic visualization that follows the
sound is drawn around it. It serves only that page and the live audio of the USB audio interface, nothing of
the DAW or MIDI controls, and each device just opens its own stream (about 0.7 Mbit/s each).

- Opening port 80 needs a permission the service has only once its unit includes `CAP_NET_BIND_SERVICE`
  (it is in `midirouter.service`). Install it with
  `sudo cp midirouter.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart midirouter.service`.
  Until then the page falls back to port 8080 and logs that.
- The hotspot redirects all web traffic to the main UI; `wifi-ap/start-ap.sh` leaves `10.0.0.1:80` alone
  so the listen page is reachable there (restart the access point to apply it).
- `LISTEN_PORT=8080` picks another port, `LISTEN_PORT=off` turns the page off. `MIDIROUTER_AUDIO=off` stops
  the router from opening the audio interface at all.

## Autostart when the Pi boots
The service is already set up by `bootstrap.sh`. If you need to do it manually:
```bash
sudo bash enable-autostart.sh
# Uses the invoking user and current repository path; also installs power-off permission.
```

## Documentation
- `SPEC.md` — technical specification
- `ARCHITECTURE.md` — project architecture
- `AUTO-CONNECT.md` — automatic port connection
- `DEVICE-MAPPING.md` — device mapping
- `DEBUGGING.md` — diagnostics
- `SETUP.md` — installation and shutdown permissions
- `METRONOME.md` — audio click and clock configuration
- `AUDIO-LATENCY.md` — recording/playback offset semantics

## Dependencies
- `@julusian/midi` (RtMidi)
- `ws` (WebSocket)

Check the recording logic and the pad map without MIDI hardware: `npm test`.
