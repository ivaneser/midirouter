# Technical spec: MIDI Router / Looper for Raspberry Pi 4

## 1. Project overview

A web app + server based on a Raspberry Pi 4 that:
- Routes MIDI messages between physical MIDI ports in real time
- Records and plays back (loops) MIDI clips with precise timing
- Is controlled through a web interface from a smartphone/tablet/browser

**Stack:** Node.js + `@julusian/midi` (RtMidi) on the server, vanilla JS SPA on the client, WebSocket for communication.

---

## 2. Hardware requirements

- Raspberry Pi 4 (2GB+ RAM)
- MIDI interface (USB-MIDI): Focusrite Scarlett 6e, Audient iD4, Behringer U-Phoria UM2, etc.
- Wi-Fi/Ethernet for connecting control clients

---

## 3. Architecture

```
┌──────────────────────────────────────────────┐
│              Raspberry Pi 4                  │
│                                              │
│   ┌─────────────┐     ┌──────────────────┐   │
│   │  @julusian/  │◄───►│   Node.js Server  │   │
│   │    midi      │     │   (ALSA backend)  │   │
│   └──────┬───────┘     └────────┬─────────┘   │
│          │                      │              │
│   USB-MIDI ports                │              │
│   (ALSA sequencer)             │              │
│                                  ▼              │
│                    ┌──────────────────────┐    │
│                    │  WebSocket Server    │    │
│                    │  + MIDI Engine       │    │
│                    └──────────┬───────────┘    │
└───────────────────────────────┼───────────────┘
                                │ WebSocket (WS)
              ┌─────────────────┼─────────────────┐
              │                 │                 │
        📱 Phone           🖥 Browser         📱 Tablet
     (Web UI SPA)       (Web UI SPA)    (Web UI SPA)
```

**How it works:**
- **Node.js server** on the Pi — the only component with access to MIDI through RtMidi/ALSA. Handles routing and looping.
- **The client web app** connects over WebSocket for control. It has no direct access to MIDI.

---

## 4. Functional requirements

### 4.1 Routing

| № | Requirement | Description |
|---|-----------|----------|
| R1 | Enumerate ports | On start the server detects all available MIDI In/Out through ALSA and sends the list to clients |
| R2 | Drag & Drop routes | The client drags an Input port onto an Output — a route is created |
| R3 | 1:N routing | One input → several outputs (split) |
| R4 | N:1 routing | Several inputs → one output with prioritization by MIDI channel |
| R5 | Auto-discovery learning mode | **Main mode**: when an event arrives on a port without a route, the router waits for the first CC signal from a synthesizer and links the ports automatically |
| R6 | Channel filtering | A route can filter by MIDI channel (1–16) or route all channels |
| R7 | Enable/disable route | Toggle On/Off for each route |
| R8 | Flow visualization | The client shows active routes with traffic indication |

### 4.2 Looper

| № | Requirement | Description |
|---|-----------|----------|
| L1 | Clip recording | Record → buffering of incoming MIDI events with timestamps |
| L2 | Clip playback | Play → playback to the selected output port |
| L3 | Cyclic loop | Loop mode: auto-repeat after the end |
| L4 | Multiple clips | At least 8 slots |
| L5 | Overdub / Punch-in | Recording a new layer on top during playback |
| L6 | Stop/Reset | Stop with an immediate reset or a graceful finish |
| L7 | Quantization | Automatic alignment to the grid (1/4, 1/8, 1/16) |

**Implementation status:** the DAW mode is implemented in `daw.js` + `worker-midi.js`. Clips = recorded patterns on a MIDI channel; playback in a loop; Overdub (layering), Replace (overwrite) and Record are supported (`daw-set-record-mode`); quantization to the grid by tempo; up to 16 clips per track (`daw-set-slots`; "+" in the UI adds clips and tracks). A clip is triggered by pressing the LaunchKey pads — automatic mapping.

### 4.3 Virtual controllers in the web interface

The client UI shows **virtual controls** for each connected synthesizer according to its MIDI map (CC/NRPN). This lets you control the synthesizer from any browser/phone, even when the physical knobs are not available.

#### 4.3.1 Korg NTS-1 — CC Map

| № | Parameter | CC MSB | Description | UI element type |
|---|---------|--------|----------|----------------|
| V1 | Volume EG Type | 14 | ADSR/AHR/AR/AR loop/Open | Dropdown/select |
| V2 | Attack | 16 | Time | Slider (0-127) |
| V3 | Release | 19 | Time | Slider |
| V4 | Tremolo Depth | 20 | Tremolo depth | Slider |
| V5 | Tremolo Rate | 21 | Tremolo rate | Slider |
| V6 | Osc LFO Rate | 24 | LFO rate | Slider |
| V7 | Osc LFO Depth | 26 | LFO depth | Slider |
| V8 | Osc Type | 53 | Saw/Tri/Square/VPM/Waves | Dropdown |
| V9 | Wave Shaping | 54 | Wave shaping | Slider |
| V10 | Alt | 55 | Alternate wave | Slider |
| V11 | Mod Time | 28 | Modulation time | Slider |
| V12 | Mod Depth | 29 | Modulation depth | Slider |
| V13 | Delay Time | 30 | Delay time | Slider |
| V14 | Delay Depth | 31 | Delay depth | Slider |
| V15 | Mix | 33 | Dry/Wet mix | Slider |
| V16 | Reverb Time | 34 | Reverb time | Slider |
| V17 | Reverb Depth | 35 | Reverb depth | Slider |
| V18 | FX Dry/Wet | 36 | Dry/Wet mix FX | Slider |
| V19 | Filter Type | 42 | LP2/LP4/BP2/BP4/HP2/HP4/Off | Dropdown |
| V20 | Cutoff | 43 | Filter cutoff frequency | **Main slider** |
| V21 | Resonance | 44 | Filter resonance | Slider |
| V22 | Sweep Depth | 45 | Sweep depth | Slider |
| V23 | Sweep Cutoff | 46 | Sweep cutoff | Slider |
| V24 | FX Mod Type | 88 | Chorus/Ensemble/Phase/Flanger | Dropdown |
| V25 | FX Delay Type | 89 | Stereo/MNono/PingPong/Tape | Dropdown |
| V26 | FX Reverb Type | 90 | Hall/Plate/Space/Riser/Submarine | Dropdown |
| V27 | Arp Pattern Length | 117 | Up/Down/Up-Down/Down-Up/Conv/etc. | Dropdown |
| V28 | Arp Intervals | 118 | Oct/Maj/Sus/Aug/Min/Dim | Dropdown |
| V29 | Arp Length | 119 | Arpeggiator length | Slider |

#### 4.3.2 Modal/Craft Synth 2.0 — CC Map (main knobs)

| № | Parameter | CC MSB | Description | UI element type |
|---|---------|--------|----------|----------------|
| C1 | Modulation | 1 | Mod wheel / LFO modulation | Slider/knob |
| C2 | Portamento Time | 5 | Portamento time | Slider |
| C3 | Volume | 7 | Master volume | Slider |
| C4 | Panpot | 11 | Pan | Slider (-64 to +63) |
| C5 | Expression | 11 | Expression pedal | Slider |
| C6 | Hold 1 (Sustain) | 64 | Sustain pedal | Toggle/button |
| C7 | Portamento | 66 | Portamento on/off | Toggle/button |
| C8 | Resonance | 72 | Filter resonance | Slider |
| C9 | Release Time | 73 | Release time | Slider |
| C10 | Attack Time | 74 | Attack time | Slider |
| C11 | Cutoff | 75 | Filter cutoff | **Main slider** |
| C12 | Decay Time | 76 | Decay time | Slider |
| C13 | Vibrato Rate | 77 | Vibrato rate | Slider |
| C14 | Vibrato Depth | 78 | Vibrato depth | Slider |
| C15 | Vibrato Delay | 80 | Vibrato delay | Slider |
| C16 | FILTER Knob | 81 | FILTER knob (user assignable) | **Main slider** |
| C17 | MOD Knob | 82 | Modulation knob | **Slider** |
| C18 | FX Knob | 83 | Effects knob | Slider |
| C19 | SOUND Knob | 84 | Sound knob | Slider |

#### 4.3.4 Arturia MicroFreak — CC Map (main parameters)

| № | Parameter | CC MSB | Description | UI element type |
|--|---------|--------|----------|----------------|
| M1 | Spice | 2 | Speech/Vocoder/Resonant FM/Analog/Vacuum/Oscillator Type | Dropdown |
| M2 | Glide | 5 | Glide time (smooth transition between notes) | Slider |
| M3 | Osc Type | 9 | Oscillator type (Speech/Sampler/Resonant FM/Analog/Vacuum/Wave Table) | Dropdown |
| M4 | Osc Wave | 10 | Waveform | Slider |
| M5 | Osc Timbre | 12 | Timbre | Slider |
| M6 | Osc Shape | 13 | Oscillator shape | Slider |
| M7 | Filter Cutoff | 23 | Filter cutoff frequency | **Main slider** |
| M8 | Cycl Env Amt | 24 | Amount Cycling Envelope | Slider |
| M9 | Filter Amt | 26 | Amount envelope to filter | Slider |
| M10 | Cycl Env Hld | 28 | Hold Cycling Envelope | Slider |
| M11 | Env Sustain | 29 | Sustain level of the standard envelope | Slider |
| M12 | Keyboard Hold | 64 | Key Hold button (toggle) | Toggle/button |
| M13 | Filter Resonance | 83 | Filter resonance | Slider |
| M14 | Arp Rate Free | 91 | Arpeggiator rate (free mode) | Slider |
| M15 | Arp Rate Sync | 92 | Arpeggiator rate (sync mode) | Slider |
| M16 | LFO Rate | 93/94 | LFO rate | Slider |
| M17 | Cycl Env Rise | 102 | Cycling envelope rise | Slider |
| M18 | Cycl Env Fall | 103 | Cycling envelope fall | Slider |
| M19 | Env Attack | 105 | Envelope attack time | Slider |
| M20 | Env Decay | 106 | Envelope decay time | Slider |

#### 4.3.5 Waldorf Blofeld — CC Map (main parameters)

Waldorf Blofeld supports MIDI Learn for most parameters. Standard mapping:

| № | Parameter | CC MSB | Description | UI element type |
|--|---------|--------|----------|----------------|
| W1 | Modulation Wheel | 1 | Modulation wheel (LFO/Filter) | Slider/knob |
| W2 | Breath Control | 2 | Breath (can be assigned to a wind controller) | Slider |
| W3 | Foot Control | 4 | Foot controller | Toggle/button |
| W4 | Glide Rate | 5 | Glide rate | Slider |
| W5 | Detune Common | 29 | Oscillator detune | Slider |
| W6 | FM Amount | 30 | Frequency modulation (FM) amount | Slider |
| W7 | Shape Modulation | 31/39/46 | Shapes for Osc 1/2/3 | Sliders |
| W8 | PW (Pulse Width) | 33/40/47 | Pulse width | Slider |
| W9 | PWM Modulation | 34/41/48 | Pulse width modulation | Slider |
| W10 | Sync Amount | 49 | Oscillator sync amount | Slider |
| W11 | Pitchmod Depth | 50 | Pitch modulation depth | Slider |
| W12 | Glide Mode | 51 | Glide mode (legato/free) | Toggle/button |
| W13 | Osc Level | 52/56/58/60 | Levels of Osc 1/Osc 2/Osc 3/Noise | Sliders |
| W14 | Noise Colour | 62 | Noise colour (white/pink) | Toggle/button |
| W15 | Octave Select | 63/35/42 | Octave selection for Osc 1/2/3 | Dropdown |
| W16 | Semitone | 64/36/43 | Semitone for Osc 1/2/3 | Sliders |
| W17 | Filter Type | 68/79 | Filter type Filt1/Filt2 (LP/BP/HP) | Dropdown |
| W18 | Filter Cutoff | 69/80 | Cutoff frequency Filt1/Filt2 | **Main sliders** |
| W19 | Filter Resonance | 70/81 | Resonance Filt1/Filt2 | Sliders |
| W20 | Filter Drive | 71/82 | Filter drive | Slider |
| W21 | Keytrack | 72/83 | Key tracking for the filter | Toggle/button |
| W22 | Env Amount to Filt | 73/84 | Envelope amount to the filter | Sliders |
| W23 | Env Velocity to Filt | 74/85 | Velocity to the filter | Slider |
| W24 | Cutoff Mod | 75/86 | Cutoff modulation | Slider |
| W25 | FM Amount (Filt) | 76/87 | FM for Filt1/Filt2 | Sliders |
| W26 | Pan Filter | 77/88 | Filter pan | Slider |
| W27 | Pan Modulation | 78/89 | Pan modulation | Slider |
| W28 | LFO Shape | 15/19/23 | Shape of LFO 1/2/3 | Dropdown |
| W29 | LFO Speed | 16/20/24 | Rate of LFO 1/2/3 | Sliders |
| W30 | LFO Delay | 18/22/26 | Delay of LFO 1/2/3 | Sliders |
| W31 | Arp Range | 12 | Arpeggiator range | Dropdown |
| W32 | Arp Active | 14 | Arpeggiator on/off | Toggle/button |
| W33 | Amp Volume | 90 | Volume | **Main slider** |
| W34 | FX1 Mix | 93 | Effect 1 mix | Slider |
| W35 | FX2 Mix | 94 | Effect 2 mix | Slider |
| W36 | Env Attack (Filt) | 95/101/107/113 | Envelope attack Filt 1-4 | Sliders |
| W37 | Env Decay | 96/102/108/114 | Envelope decay Filt 1-4 | Sliders |
| W38 | Env Sustain | 97/103/109/115 | Envelope sustain Filt 1-4 | Sliders |
| W39 | Env Release | 100/106/112/118 | Envelope release Filt 1-4 | Sliders |

#### 4.3.6 Mutable Instruments PreenFM2 — CC Map (main parameters)

PreenFM2 uses FM synthesis (Yamaha DX7-style). Main parameters via CC and NRPN:

| № | Parameter | CC MSB | Description | UI element type |
|--|---------|--------|----------|----------------|
| P1 | Volume | 22 | Volume | Slider |
| P2 | Pan | 23 | Pan | Slider |
| P3 | Algorithm | 16 | FM algorithm (0–28) | Dropdown/select |
| P4 | Op 1 Frequency | 50 | Frequency of operator 1 (carrier) | Slider |
| P5 | Op 1 Env Attack | 74 | Attack of the envelope of operator 1 | Slider |
| P6 | Op 1 Env Decay | — NRPN | Decay of the envelope of operator 1 | NRPN slider |
| P7 | Op 1 Env Sustain | — NRPN | Sustain level of operator 1 | NRPN slider |
| P8 | Op 1 Env Release | — NRPN | Release of operator 1 | NRPN slider |
| P9 | Mod Index 1 | — NRPN | Modulation index of operator 1 | NRPN slider |
| P10 | Mod Index 2–5 | — NRPN | Modulation indices of operators 2-5 | NRPN sliders |
| P11 | Mix 1–4 | 16/18/20/22 | Operator mix (CC, first 4) | Sliders |
| P12 | Pan 1–4 | 17/19/21/23 | Operator pan (CC, first 4) | Sliders |
| P13 | LFO Rate | — NRPN | LFO rate | NRPN slider |
| P14 | LFO Depth | — NRPN | LFO depth | NRPN slider |
| P15 | Glide Time | — NRPN | Glide time | NRPN slider |
| P16 | Velocity Sensitivity | — NRPN | Velocity sensitivity | NRPN slider |
| P17 | Arp Clock | 97 | Arpeggiator rate | Slider |
| P18 | Arp Direction | 98 | Arpeggiator direction (Up/Down/Bidir) | Dropdown |
| P19 | Arp Octave | 99 | Arpeggiator octave | Dropdown |
| P20 | Arp Pattern | 100 | Arpeggiator pattern | Dropdown |
| P21 | Matrix ModW → Env | 62/63 | Matrix modulation (Attack/Release mod ops) | Sliders |

#### 4.3.7 Arturia Bruteforce 2 — CC Map (main knobs)

| № | Parameter | CC MSB | Description | UI element type |
|---|---------|--------|----------|----------------|
| B1 | Volume | 7 | Volume | Slider |
| B2 | Cutoff | 74 | Cutoff frequency | **Main slider** |
| B3 | Resonance | 71 | Filter resonance | Slider |
| B4 | Attack | 74 | Attack time (ADSR) | Slider |
| B5 | Decay | 76 | Decay time | Slider |
| B6 | Sustain | 74 | Sustain level | Slider |
| B7 | Release | 73 | Release time | Slider |
| B8 | LFO Rate | 1 | LFO rate | Slider |
| B9 | LFO Depth | 1 | LFO depth | Slider |
| B10 | Mod Wheel | 1 | Modulation | Slider/knob |
| B11 | Pitch Bend | PB | Vibrato/pitch bend | **Two-axis joystick** |

### 4.4 Auto-discovery Learning Mode (details)

The mode automatically discovers the link between the controller and the synthesizers:

```
Phase 1: DISCOVERY
┌─────────────────────────────────────────────┐
│  All unrouted inputs → controllers          │
│  Unrouted outputs, excluding ports of the same │
│  physical devices (via _deviceBase())       │
│  Start ping sequence (5 notes × 1 s)        │
└─────────────────────────────────────────────┘

Phase 2: CONNECTION
┌─────────────────────────────────────────────┐
│  Key press on the controller                │
│  → Route controller → synth created         │
│     channels = null (all channels)          │
│  → Confirmed with a double note             │
│  → Move on to the next synthesizer          │
└─────────────────────────────────────────────┘

Phase 3: OPERATION
┌─────────────────────────────────────────────┐
│  Each controller is connected to all        │
│  available synthesizers                     │
│  → The visual diagram shows all links       │
│  → The route can be edited manually         │
│     (MIDI channel selection via dropdown)   │
└─────────────────────────────────────────────┘
```

**Device normalization (`_deviceBase()`):**
Ports of one physical device have different function suffixes: `MIDI Port`, `DAW Port`, `KBD/KNOB`, `SOUND`. The function `_deviceBase(name)` removes these suffixes to determine the base device name. Outputs whose base matches any input are excluded from the targets.

**Implementation details:**

1. **Multi-controller**: all unrouted inputs become controllers, each connected to the unrouted outputs, excluding the ports of the same physical devices.
2. **Ping timeout**: 5 test notes with a 1 s interval; after the timeout — move on to the next synthesizer (no looping).
3. **Route channels**: discovery creates routes with `channels = null` (all channels). Channel filtering is available through the manual UI selector.
4. **Fallback discovery**: if a device sends MIDI without a route — after 5 seconds a default route is created to the first available output port.
5. **Duplicate protection**: the `discoveryActive` flags in the server and the worker prevent repeated auto-connect runs.

### 4.5 Web interface control

| № | Requirement | Description |
|---|-----------|----------|
| U1 | Adaptive UI | Works on phones (320px+), tablets, desktops |
| U2 | Visual routing diagram | Drag-and-drop or automatic discovery through the learning mode |
| U3 | Looper panel | 8+ slots with Record/Play/Stop/Loop/Overdub buttons |
| U4 | Global controls | Tap Tempo, MIDI Clock Out, Master Volume (CC7), Mute Group |
| U5 | Route presets | Save/load configuration |
| U6 | Real-time feedback | Port activity indication, loop progress, BPM |

### 4.6 API and protocol

| № | Requirement | Description |
|---|-----------|----------|
| P1 | WebSocket for control | Commands as WS JSON |
| P2 | Binary MIDI over WS | Raw bytes as `ArrayBuffer`/`Uint8Array` (not JSON — latency) |
| P3 | REST API for presets | HTTP GET/POST for saving configurations |

---

## 5. Communication protocol (WebSocket)

### 5.1 Client → server commands

```jsonc
// Request the list of ports
{ "type": "request_ports" }

// Create a route manually: inputPortId -> outputPortId [channels]
{
  "type": "create_route",
  "payload": {
    "from": "input_0",
    "to": "output_2",
    "channels": [1, 3, 5],     // null = all channels
    "messageTypes": ["noteOn", "cc"]  // null = all
  }
}

// Enable/disable learning mode for a port
{ "type": "start_learning", "payload": { "inputPortId": "input_0" } }

// Cancel learning
{ "type": "cancel_learning", "payload": { "inputPortId": "input_0" } }

// Confirm the discovered link
{ "type": "confirm_route", "payload": { "routeId": "r1" } }

// Remove a route
{ "type": "delete_route", "payload": { "routeId": "r1" } }

// Enable/disable a route
{ "type": "toggle_route", "payload": { "routeId": "r1", "enabled": true } }

// Record a loop
{ "type": "loop_record", "payload": { "slot": 0 } }

// Play the loop
{ "type": "loop_play", "payload": { "slot": 0, "outputPort": "output_2" } }

// Stop the loop
{ "type": "loop_stop", "payload": { "slot": 0 } }

// Overdub recording on top
{ "type": "loop_overdub", "payload": { "slot": 0 } }

// Tap Tempo
{ "type": "tap_tempo" }

// ---- DAW / Clip mode (4.2) ----
// Request the current DAW state
{ "type": "daw-get" }

// Set the tempo (BPM)
{ "type": "daw-set-tempo", "bpm": 120 }

// Recording mode: 'none' | 'replace' | 'overdub'
{ "type": "daw-set-record-mode", "mode": "replace" }

// Number of slots per track (1/2/4/8)
{ "type": "daw-set-slots", "n": 4 }

// Enable/disable automatic pad mapping (key -> track/slot)
{ "type": "daw-pad-learn", "on": true }

// Manual mapping note -> (track, slot)
{ "type": "daw-pad-map", "note": 60, "trackIdx": 0, "slot": 0 }

// Simulate a pad press from the web UI (testing without a controller)
{ "type": "daw-pad-trigger", "trackIdx": 0, "slot": 0 }

// Save a routing configuration preset
{ "type": "daw-save", "name": "my_clip" }

// Load a routing configuration preset
{ "type": "daw-load", "name": "my_clip" }

// Recording sessions (DAW clips) on disk: sessions/<name>.json
{ "type": "daw-save-session", "name": "groove-1" }
{ "type": "daw-load-session", "name": "groove-1" }
{ "type": "daw-delete-session", "name": "groove-1" }
{ "type": "daw-list-sessions" }

// Save a preset
{ "type": "save_preset", "payload": { "name": "my_setup", "config": {...} } }

// Load a preset
{ "type": "load_preset", "payload": { "name": "my_setup" } }

// Send CC to a port (from the virtual controller)
{
  "type": "send_cc",
  "payload": {
    "outputPortId": "output_0",
    "channel": 1,
    "controller": 43,     // Cutoff NTS-1
    "value": 64
  }
}

// Send NoteOn (from the virtual controller)
{
  "type": "send_note",
  "payload": {
    "outputPortId": "output_0",
    "channel": 1,
    "note": 60,
    "velocity": 80
  }
}

// Request the list of controllers for a port (get the synthesizer's CC map)
{ "type": "request_device_info", "payload": { "outputPortId": "output_0" } }
```

### 5.2 Server → client responses

```jsonc
// List of ports
{ "type": "ports_list", "payload": [
  { "id": "input_0", "name": "Akai LPK25 MIDI In", "type": "input" },
  { "id": "output_0", "name": "Korg NTS-1 MIDI Out", "type": "output" }
]}

// MIDI event from a physical device → client (visualization)
{ "type": "midi_event", "payload": { "portId": "input_0", "data": [144, 60, 100], "timestamp": 12345.678 } }

// Loop progress
{ "type": "loop_progress", "payload": { "slot": 0, "progress": 0.45, "beat": 12 } }

// Route activity (blinking)
{ "type": "route_activity", "payload": { "routeId": "r1" } }

// Confirmation of the discovered link
{ "type": "route_discovered", "payload": {
    "routeId": "r1",
    "from": "input_0",
    "to": "output_0",
    "channels": [1],
    "messageTypes": ["noteOn", "cc"],
    "confirmed": false  // waiting for the user's confirmation
}}

// Learning mode state
{ "type": "learning_status", "payload": {
    "inputPortId": "input_0",
    "state": "waiting" | "timeout" | "discovered"
}}

// DAW: clip/track/tempo state
{ "type": "daw_state", "payload": {
    "tempo": 120,
    "recordMode": "replace",
    "slotsPerTrack": 4,
    "tracks": [ { "channel": 1, "playing": true, "clips": [ {"notes": 3, "length": 8} ] } ],
    "loopLenBeats": 16
}}

// DAW: pad mapping list (note -> track/slot)
{ "type": "daw_pad_map_list", "payload": {
    "learnMode": true,
    "map": [ { "note": 60, "trackIdx": 0, "slot": 0 } ]
}}

// DAW: presets available for loading
{ "type": "daw-presets", "payload": { "names": ["my_clip"] }}

// DAW: list of recording sessions on disk / session operation error
{ "type": "daw_session_list", "sessions": ["groove-1"] }
{ "type": "daw_session_error", "name": "groove-1", "error": "..." }

// DAW: clip MIDI event (visualization of playback/recording)
{ "type": "daw_event", "payload": { "trackIdx": 0, "slot": 0, "note": 60 } }

// Device information (CC map)
{ "type": "device_info", "payload": {
    "portId": "output_0",
    "manufacturer": "Korg",
    "model": "NTS-1",
    "controls": [
      { "cc": 43, "name": "Cutoff", "type": "slider" },
      { "cc": 42, "name": "Filter Type", "type": "dropdown" }
    ]
}}

// Error
{ "type": "error", "payload": { "message": "..." }}
```

---

## 6. Project structure

```
~/myprojects/midirouter/
├── SPEC.md              ← this document
├── package.json
├── server/
│   ├── index.js         ← entry point, WebSocket server + HTTP
│   ├── midi_engine.js   ← RtMidi wrapper, routing logic, looper
│   ├── learning_mode.js ← Auto-discovery learning mode
│   ├── presets.js       ← saving/loading presets (JSON files)
│   └── config.js        ← configuration (WS port, MIDI ports, etc.)
├── client/
│   ├── index.html       ← SPA single-file app
│   ├── src/
│   │   ├── app.js       ← WebSocket client, UI logic
│   │   ├── router_ui.js ← drag-and-drop route diagram + learning mode
│   │   ├── looper_ui.js ← looper panel
│   │   ├── controller_ui.js ← virtual controllers (CC map)
│   │   └── styles.css   ← adaptive styles
├── presets/             ← JSON files with route presets
└── README.md            ← instructions for running
```

---

## 7. Quality criteria

| Parameter | Requirement |
|----------|-----------|
| **Routing latency** | < 5 ms from receiving a byte to sending it (internal, between the Pi's ports) |
| **Loop accuracy** | Jitter < 1 ms during playback |
| **Stability** | The server runs 24/7 without restarting |
| **UI response** | WebSocket command → UI reaction < 50 ms on the local network |

---

## 8. Development stages

### Stage 1: Basic routing (MVP)
- [ ] Node.js server + RtMidi/ALSA connection
- [ ] Enumerate MIDI ports
- [ ] Simple 1:1 routing between ports
- [ ] WebSocket API for managing routes
- [ ] Minimal web UI with drag-and-drop

### Stage 2: Auto-discovery learning mode
- [ ] Waiting mode for CC from a synthesizer
- [ ] Automatic route creation on detection
- [ ] Confirmation on the client
- [ ] Timeout and mode reset

### Stage 3: Virtual controllers
- [ ] CC map database for Korg NTS-1, Modal Craft Synth 2.0, Arturia Bruteforce 2
- [ ] Display of virtual sliders/buttons on the client
- [ ] Sending CC via WebSocket → server → MIDI Out

### Stage 4: Extended routing
- [ ] 1:N and N:1 routing
- [ ] Filtering by channels and message types
- [ ] Toggle On/Off for routes
- [ ] Real-time traffic visualization

### Stage 5: Looper
- [ ] Recording/playback of MIDI with timing
- [ ] Cyclic loop (loop mode)
- [ ] 8+ slots for clips
- [ ] Overdub / Punch-in

### Stage 6: Polish
- [ ] Tap Tempo, MIDI Clock Out
- [ ] Quantization
- [ ] Route presets (save/load)
- [ ] Adaptive design for mobile
- [ ] README and installation instructions for the Pi

---

## 9. Dependencies

### Server
| Package | Purpose |
|-------|-----------|
| `@julusian/midi` | RtMidi wrapper for Node.js (native MIDI access through ALSA) |
| `ws` or `uWebSockets.js` | WebSocket server (uWebSockets is faster, lower latency) |
| `express` | HTTP server for serving the static UI |

### Client
- Plain JavaScript (vanilla JS) without frameworks — a lightweight SPA that loads fast on mobile
- WebSocket API (native)
- CSS Grid / Flexbox for responsive layout

---

## 10. Risks and limitations

| Risk | Mitigation |
|------|-----------|
| Latency under high load | uWebSockets + ring buffer instead of JSON for MIDI packets |
| Web MIDI API does not work on iOS Safari | The client connects to the server over WS, not directly to MIDI — not a problem, because the Pi has access to the devices |
| JACK vs ALSA on Linux | Both backends are supported in @julusian/midi; JACK gives lower latency but needs configuration |
| Port conflicts with other applications | The server holds the MIDI ports exclusively; other applications do not connect to the same ports |
