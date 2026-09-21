# Metronome & MIDI Clock (MTC) Guide

The midirouter now provides **two synchronized timing sources**:

1. **Audio metronome** (`metronome.py`) — precise click track through the 3.5mm headphone jack
2. **MIDI clock** (`midi-clock.js` + DAW engine) — 24 PPQN MTC sent to all connected USB-MIDI devices via the Node.js server

Both are driven by the same BPM/transport source so your headphones and external gear stay in sync.

---

## 1. Audio Metronome (Headphone Jack)

A Python script that generates **sample-accurate** metronome clicks using ALSA `aplay -M` (mmap mode). The sound card's DMA engine plays the pre-computed samples at exact hardware timing — no CPU jitter.

### Features
- 20–300 BPM range
- 1–16 beats per measure
- Accent on any beat (louder first beat by default)
- Adjustable volume
- Crisp 1 kHz sine-burst click sound

### Usage

```bash
# Basic: 120 BPM, 4/4
python3 metronome.py

# 90 BPM, 6/8 time, accent on beat 1
python3 metronome.py -B 90 -b 6 -a 1

# Fast 200 BPM, 2-beat feel, lower volume
python3 metronome.py -B 200 -b 2 -v 0.5

# Help
python3 metronome.py --help
```

### Controls
- **Ctrl+C** to stop

### How it works
1. Generates `BUFFER_SECS` seconds of audio samples at 44,100 Hz with clicks placed at exact sample positions
2. Writes to a temporary WAV file
3. Plays via `aplay -M` (ALSA mmap mode) — the sound card's hardware DMA streams it to the 3.5mm jack at precise sample intervals
4. Loops: generates next buffer while previous plays

---

## 2. MIDI Clock (MTC) — Sync External Gear

The Node.js midirouter server now sends **MIDI Time Code (MTC)** to all connected USB-MIDI devices when the transport starts. This syncs external synthesizers, drum machines, and sequencers to the same tempo.

### Messages Sent
| Message | Byte | When |
|---------|------|------|
| Start   | `0xFA` | Transport start |
| Clock tick | `0xF8` | 24 per quarter note (PPQN) |
| Stop    | `0xFC` | Transport stop |

### How to Use

1. **Start the midirouter server:**
   ```bash
   node server.js
   ```

2. **Open the web UI** at `http://<pi-ip>:3000`

3. **Set the tempo** using the BPM control or tap tempo button

4. **Toggle MIDI Clock** — click the **⏱ MTC** button to enable/disable clock output to all connected devices

5. **Start transport** — click **▶ Play**. The server sends:
   - `0xFA` (MIDI Start) to all outputs
   - 24 PPQN clock ticks synced to the tempo
   - When you stop: `0xFC` (MIDI Stop)

### What gets connected
All USB-MIDI devices detected by ALSA are automatically opened as outputs, including:
- **Launchkey Mini MK3** — DAW mode sync
- **NTS-1 digital kit** — start/stop + clock for loop-based sequences
- **Craft Synth 2.0** — tempo-synced arps/modulation
- **nanoPAD2** — (controller, but can receive clock)

---

## Architecture

```
┌─────────────────────────────┐         WebSocket          ┌──────────────────┐
│  Web UI (browser)           │ ◄─────────────────►       │  server.js        │
│  - BPM / Tap tempo          │                              │  (HTTP + WS)     │
│  - Metro toggle             │                              │                  │
│  - ⏱ MTC toggle             │                              │  ┌────────────┐  │
│  - Transport Play/Stop      │                              │  │ Worker Thread│  │
└─────────────────────────────┘                              │  │ (worker-midi)│  │
                                                              │  │              │  │
┌─────────────────────────────┐                              │  │  ┌──────────┐  │  │
│  metronome.py (Python)      │         (same BPM)           │  │  │ DAWEngine│  │  │
│  - Sample-accurate audio    │ ◄──────── sync source ────── │  │  │          │  │  │
│  - aplay -M → headphone jack│         (BPM + transport)     │  │  │ midi-clock│  │  │
└─────────────────────────────┘                              │  │  │ (24 PPQN) │  │  │
                                                              │  │  └──────────┘  │  │
                                                              │  │       │        │  │
                                                              │  │ _sendToAllOutputs()│
                                                              │  └────────────┘     │
                                                              └──────────────────┘
                                                                          │
                    ┌─────────────────────────────────────────────────────┤
                    ▼
         ┌──────────────────────────┐
         │ ALSA Sequencer (/dev/snd/seq)
         │  → Launchkey Mini MK3    │
         │  → NTS-1 digital kit     │
         │  → Craft Synth 2.0       │
         │  → nanoPAD2              │
         └──────────────────────────┘
```

### Key Files
| File | Role |
|------|------|
| `metronome.py` | Standalone audio metronome (Python + ALSA PCM) |
| `midi-clock.js` | MTC generator — 24 PPQN clock + Start/Stop messages |
| `daw.js` | DAW engine — integrates MidiClock into transport lifecycle |
| `worker-midi.js` | Worker thread — routes MIDI clock to all output ports |
| `server.js` | Main server — forwards UI toggles to worker |
| `test-midi-clock.js` | Standalone test script for verifying MIDI clock output |

### Testing

```bash
# Test the audio metronome (3 seconds)
python3 metronome.py -B 120 -b 4

# Test MIDI clock output to all connected devices (5 seconds @ 120 BPM)
node test-midi-clock.js -B 120 -d 5
```

---

## Troubleshooting

**No sound from headphones?**
- Check the 3.5mm jack is properly inserted
- Verify volume: `amixer` or use `-v` flag (0.0–1.0)
- Check ALSA output: `aplay -L` should list your headphone device

**MIDI clock not reaching devices?**
- Make sure the device is connected and shows in `aplaymidi -l`
- Try the standalone test: `node test-midi-clock.js -d 3`
- Check the ⏱ MTC button is ON (highlighted) in the web UI

**Timing feels off?**
- The Python metronome uses hardware DMA — should be precise
- Node.js MIDI clock uses corrected setInterval — very stable but check CPU load
- For best results, run both at the same BPM value
