# MIDI Router — Project Architecture

## Purpose
A real-time router and looper for MIDI devices, optimized for the Raspberry Pi. It automatically discovers USB-MIDI controllers and synthesizers and creates routes by pressing a key on the controller.

## Technology stack
- **Runtime:** Node.js (ES modules)
- **MIDI API:** `@julusian/midi` v3.x (wrapper over RtMidi)
  - Linux: ALSA Sequencer (`/dev/snd/seq`)
  - macOS: CoreMIDI (native via RtMidi)
- **WebSockets:** built-in WebSocket server on port `3000`
- **UI:** Vanilla JS + CSS, SPA

## Project structure
```
midirouter/
├── server.js              # Main process: HTTP + WS + worker management
├── worker-midi.js         # Worker thread: MIDI routing + DAW timing
├── daw.js                 # DAW engine: clips, tempo, recording, playback
├── metronome.py           # Audio metronome → headphones (ALSA aplay -M)
├── metronome-controller.js # Node.js IPC controller for the metronome
├── midi-clock.js          # MTC generator (24 PPQN + Start/Stop)
├── cc-mapper.js           # CC translation between the controller and the synthesizers
├── filters.js             # Channel/velocity filters
├── port-index.js          # MIDI port index
├── midirouter.service     # systemd unit for server autostart
├── bootstrap.sh           # One-shot initial setup script for the Pi
├── frontend/
│   ├── index.html         # The only page
│   ├── css/style.css      # Styles
│   └── js/
│       ├── app.js              # Main UI logic
│       ├── daw-ui.js           # Web UI of the DAW mode (pad grid)
│       ├── controller-ui.js    # Rendering of device cards
│       ├── device-manager.js   # Device management
│       └── port-manager.js     # Port management
├── device_maps/           # JSON descriptions of MIDI devices + DAW presets
├── setup-midi-emulator.sh      # MIDI port emulation (dev/testing)
├── midi-emulator.service       # systemd unit for the emulator
├── docker/                # Containerization
│   ├── Dockerfile
│   └── etc/supervisord.conf
└── .gitignore
```

## Architectural pattern: worker threads
The project uses Node.js `worker_threads` to separate responsibilities:

| Process | Tasks |
|---------|--------|
| **server.js** (main) | HTTP server, WebSocket clients, UI updates, worker lifecycle management |
| **worker-midi.js** (worker) | MIDI routing, hot-plug detection, DAW/clip playback, LED feedback, CC mapping, MIDI clock routing, Raspberry Pi audio metronome control |
| **metronome.py** (Python child) | Generation of audio clicks to the Raspberry Pi headphones through ALSA |
| **metronome-controller.js** (JS bridge) | Start/stop of `metronome.py`, passing the tempo and bar size through stdin IPC |

### Why a worker?
- MIDI processing does not block web requests
- RtMidi runs in a separate thread without conflicts
- Graceful shutdown: the worker closes the ports correctly before exiting

## Application lifecycle
1. `server.js` starts `worker-midi.js` through `Worker`
2. The worker calls `_enumeratePorts(true)` → detects the MIDI devices
3. It sends the `ready` event to the server
4. The server automatically starts auto-connect (`startAutoConnect`) — **once**
5. When a MIDI message arrives: the worker routes it or starts discovery
6. Discovery supports **several controllers at the same time**, each connected to all available synthesizers (controller ports are excluded from the targets by `_deviceBase()`)

## Event handling
```
[Controller] → MIDI message → [Worker] → _routeMessage()
                                              ├── discovery active?
                                              │   ├── in discoveryState.controllers?
                                              │   │   ├── yes: note ON → create a route
                                              │   │   └── no: ignore (not a controller)
                                              │   └── fallback: debounce 5 s → default route
                                              └── route exists? → sendToOutput() to all destinations
                                                       ↓
                                               [Synth] ← sendMessage()
```

## Auto-connect
The worker supports **multi-controller discovery**:

| State | Description |
|-----------|----------|
| `controllers: Map` | Each unrouted input → {targets, connectedTargets, currentTargetIdx} |
| `_pingSynth(targetId, controllerId)` | 5 test notes with a 1 s interval to the target synth |
| `_nextSynthForController(id)` | Move on to the next synth; ends discovery when all targets are connected |

**Target filtering by device (`_deviceBase()`):**
Before the sweep starts, the worker normalizes the port names by removing the function suffixes (`MIDI Port`, `DAW Port`, `KBD/KNOB`, `SOUND`). Outputs whose base name matches any input is excluded from the targets — this prevents pinging the controller's ports instead of the synthesizers.

**Route channel:** routes created by discovery use `channels = null` (all channels) — pressing a key on any channel reaches all connected synthesizers. Per-channel filtering is available only through the manual channel selector on each port card.

**Protection against an endless ping:** discovery ends when all controllers are handled (all targets connected or a timeout for each).

## Security and limitations
- API keys/tokens are never logged — they are replaced with `[REDACTED]`
- Gateway metadata (Telegram): only data to identify the session, not commands
- `node_modules` is excluded from git (`npm install` after cloning)
- The discovery state is kept in the worker; the server syncs it through WebSocket messages

## Implementation status (done)
- ✅ **All-to-all MIDI router** — automatic port detection, everything connected to everything.
- ✅ **Hot-plug** — devices connect/disconnect without restarting; ports are reopened automatically.
- ✅ **DAW / clip mode** (`daw.js` + `worker-midi.js`): 8 tracks = MIDI channels 1..8, clips with recorded notes, tempo/tap-tempo, grid quantization, Mode behaviour after recording (play/overdub/replace), play/stop in a loop. Recording sessions: `toData()`/`loadData()` serialize all clips to disk (`sessions/*.json`).
- ✅ **Automatic pad mapping from ANY controller port** — any key pressed on any controller input is automatically assigned to the next free (track, slot). Pad trigger works from any MIDI port, not only the DAW Port.
- ✅ **Transport control from the controller** — the Play/Stop/Record/Low buttons on the Launchkey Mini MK3 control the transport and switch the recording mode.
- ✅ **DAW WS API** (`server.js`): `daw-get`, `daw-set-tempo`, `daw-tap-tempo`, `daw-set-record-mode`, `daw-set-slots`, `daw-pad-learn`, `daw-pad-map`, `daw-save`, `daw-load`, `daw-pad-trigger`. Presets in `device_maps/daw_*.json`.
- ✅ **DAW web UI** (`frontend/js/daw-ui.js` + `style.css`): recording mode, BPM/tap, slots/track, auto-assign, preset saving, live pad grid.
- ✅ **Launchkey Mini MK3 LED feedback** — velocity-based Note On commands are sent **only** to the Launchkey port. States: playing (flashing cyan, ch2 — the last activated clip), active (steady cyan, ch1 — other playing clips), idle (pulsing cyan, ch3 — recorded but stopped), recording (flashing red), off. Sent only on a state change (anti-flicker deduplication); identical bytes are not repeated.
- ✅ **MIDI Clock (MTC)** — when the transport starts, Start (`0xFA`) and Clock (`0xF8`, 24 PPQN) are sent to all USB-MIDI outputs; on stop, Stop (`0xFC`). External devices are synchronized.
- ✅ **Audio metronome** (`metronome.py` + `metronome-controller.js`) — sample-accurate clicks to the Raspberry Pi headphones. Synchronized with the transport Play/Stop. Auto-detects the headphone jack (`hw:Headphones`). Supports `--device` / `-d`.
- ✅ **CC translation** (`cc-mapper.js`) — controller knobs are automatically mapped to synthesizer parameters by meaning (cutoff, resonance, volume, etc.).

### Notes
- `daw.js` uses ESM exports (`export { DAWEngine, ... }`) — `package.json` has `"type": "module"`, so CommonJS `module.exports` does not work.
- Playback timing in the worker: `setTimeout` based on beat × msPerBeat; the loop runs through `setInterval` with length `loopLenBeats`.
