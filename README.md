# MIDI Router / Looper (midirouter)

Web app + server on a Raspberry Pi 4 for real-time MIDI routing and recording.
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

### 4. MIDI Clock (MTC) — syncing external devices
On Play the MIDI Clock (24 PPQN) starts; on Stop `0xFC` is sent. The clock goes to the MIDI outputs of the synthesizers and to the controllers selected in the profile's `midiClockOutput`. In the Launchkey Mini MK3 profile the DAW port receives the clock to sync the blinking LEDs.

Incoming MIDI Clock also works as an external master: Start/Continue/Stop control the transport, the tempo and clip phase follow the bars, and notes are played on the 24 pulses per beat. A source without Start automatically starts the transport on the first pulse. While an external clock is arriving, the internal generator is paused; after losing the clock for more than 750 ms the router returns to the internal tempo. For the Launchkey, enable MIDI Clock Output in the controller settings.

### 5. Controller LEDs
The profile defines the MIDI messages for clip states: **playing**, **recorded**, **recording**, **off**. For other devices, Note, CC or SysEx bytes can be defined in JSON.

Launchkey Mini MK3 (DAW port, colours via Note On velocity): **playing** — the last activated playing clip: blinking cyan (ch2, vel 37); **active** — other playing clips: steady cyan (ch1, vel 37); **idle** — stopped but recorded: pulsing cyan (ch3, vel 37); **recording** — blinking red (ch2, vel 5); **off** — note off. LKM3 channels: ch1 — steady colour, ch2 — blinking (period 1 beat), ch3 — pulsing (period 2 beats).

### 6. MIDI device list
The «🔊 MIDI Devices» tab shows all connected MIDI ports (inputs and outputs) in one flat list; hot-plug is shown live.

## Quick start

### One-time setup (new Pi / new SD card)
```bash
ssh pi@<ip>
sudo bash ~/myprojects/midirouter/bootstrap.sh
# The script installs Node.js and ALSA itself, adds the user to the audio group,
# enables autostart and reboots the Pi.
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

Requirements: Raspberry Pi 4 (or 3B+), a USB-MIDI controller/synthesizer, ALSA (`/dev/snd`), alsa-utils, Python 3. The `midirouter` service user must have access to the `audio` group.

**ALSA device for headphones:**
- The metronome automatically looks for `hw:Headphones` or `headphones` through `aplay -L`.
- To force a choice, set `MIDIR_METRONOME_DEVICE`, for example `hw:0,0`, in the service environment.

## Controls
- **Post-record (behaviour when the initial recording stops):** Play / Overdub (in the web UI).
- **BPM + Tap Tempo.**
- **Clips per track:** 3 by default; "+" under a track adds an empty clip (max 16). Long-press (≈600 ms) a recorded clip to clear it.
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
├── midi-clock.js          # MIDI Time Code (MTC): 24 PPQN + Start/Stop
├── metronome.service      # obsolete unit; bootstrap removes it
├── midirouter.service     # systemd unit for the server itself
├── bootstrap.sh           # One-time setup: Wi-Fi + Node.js + ALSA + autostart
├── frontend/
│   ├── index.html         # Page with the router and DAW panels
│   ├── css/style.css
│   └── js/
│       ├── app.js              # Main UI logic + WS
│       ├── daw-ui.js           # DAW web UI: pad grid, sessions, transport
│       ├── device-manager.js   # Device and synthesizer cards
│       └── synth-catalog.js    # Output classification (Craft/NTS-1) + CC maps
├── device_maps/           # Configuration presets (daw_*.json) and synthesizer CC maps
├── sessions/              # Recording sessions: sessions/<name>.json
└── docs/*.md              # Documentation (SPEC, ARCHITECTURE, etc.)
```

## Autostart when the Pi boots
The service is already set up by `bootstrap.sh`. If you need to do it manually:
```bash
sudo cp midirouter.service /etc/systemd/system/
sudo systemctl disable --now metronome.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/metronome.service
sudo systemctl daemon-reload
sudo systemctl enable --now midirouter.service
```

## Documentation
- `SPEC.md` — technical specification
- `ARCHITECTURE.md` — project architecture
- `AUTO-CONNECT.md` — automatic port connection
- `DEVICE-MAPPING.md` — device mapping
- `DEBUGGING.md` — diagnostics

## Dependencies
- `@julusian/midi` (RtMidi)
- `ws` (WebSocket)

Check the recording logic and the pad map without MIDI hardware: `npm test`.
