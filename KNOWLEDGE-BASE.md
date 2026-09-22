# MIDI Router — Project Knowledge Base

## 📋 Overview

**MIDI Router** is a Raspberry Pi-based MIDI routing and DAW looper application that:
- Routes MIDI between all connected USB-MIDI devices (all-to-all passthrough)
- Provides a web UI for DAW/clip launching (Ableton Session View style)
- Generates precise audio metronome clicks via 3.5mm headphone jack
- Sends MIDI Time Code (MTC) to sync external gear
- Supports Launchkey Mini MK3 DAW mode with pad mapping

---

## 🏗️ Architecture

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

---

## 📁 Key Files

| File | Role |
|------|------|
| `server.js` | Main server — HTTP + WebSocket, manages worker thread |
| `worker-midi.js` | Worker thread — MIDI routing, port enumeration, DAW engine integration |
| `daw.js` | DAW engine — clip launching, transport, metronome logic |
| `midi-clock.js` | MTC generator — 24 PPQN clock + Start/Stop messages |
| `metronome.py` | Python audio metronome — sample-accurate clicks via ALSA PCM |
| `metronome-controller.js` | Node.js controller — manages Python metronome process via stdin IPC |
| `metronome.service` | systemd unit — autostarts Python metronome on boot |
| `cc-mapper.js` | CC mapping/profile system for different controllers |
| `filters.js` | MIDI filters (channel, velocity, message type) |
| `port-index.js` | Port index management for hot-plug detection |
| `frontend/` | Web UI (HTML/CSS/JS) |

---

## 🔧 Recent Changes & Fixes

### 1. Loopback Port Filtering Fix
**Problem:** `_filterPorts()` was filtering `'loopback'` from both inputs AND outputs, preventing loopback output ports from being opened.

**Fix:** Updated `_filterPorts(device, direction = 'in')` to accept a direction parameter:
- **Inputs:** exclude `['Midi Through', 'loopback', 'timer', 'announce']` (feedback prevention)
- **Outputs:** only exclude `['timer', 'announce']` (loopback & Midi Through now allowed)

**Files modified:** `worker-midi.js` — `_filterPorts()` method and `_enumeratePorts()` call sites.

### 2. DAW Metronome Routing Fix
**Problem:** DAW engine's `_onEvent` callback was calling `_sendToAllOutputs()`, routing metronome noteOn/noteOff to ALL USB-MIDI devices.

**Fix:** Removed `_sendToAllOutputs()` from `this.daw._onEvent` in `worker-midi.js`. Now only sends `parentPort.postMessage({ type: 'daw_midi', ... })` for UI visualization.

**Key insight:** `_sendToAllOutputs()` is still correctly used for LED feedback (Launchkey pads) — only the DAW metronome routing was removed.

### 3. MIDI Clock from Launchkey DAW Port
**Problem:** When Play is pressed on Launchkey controller, commands were ignored with `[MIDI] [LOOPBACK] Ignoring DAW Port: sys unknown sys`.

**Root cause:** The DAW Port handler only allowed CC (type 7), SysEx (0xF0), and Note On (type 9) messages. All System Real-Time messages (0xF8-0xFF) were being ignored.

**Fix:** Moved System Real-Time message handling BEFORE the early return check in `_onIncomingMessage()`:
```javascript
// Сначала обрабатываем System Real-Time (MIDI Clock, Start, Continue, Stop)
const isSysRealTime = type >= 8 && type <= 15;
if (isSysRealTime) {
    // Транслируем MTC на все USB-MIDI выходы
    for (const [name, outputPort] of this.outputs) {
        if (!name.toLowerCase().includes('daw port')) {
            outputPort.sendMessage(Buffer.from(bytes));
        }
    }
    // Запускаем/останавливаем аудио метроном для наушников
    ...
}
```

### 4. Metronome IPC Integration
**Problem:** DAW engine's metronome was separate from the Python audio metronome — no way to control it from the web UI.

**Fix:** 
- Created `MetronomeController` (`metronome-controller.js`) that spawns `metronome.py` with stdio pipes
- Overrode DAW engine methods in `worker-midi.js`:
  - `setTempo(bpm)` → calls `metronomeCtrl.setBpm(bpm)`
  - `_startMetronome()` → calls `metronomeCtrl.play()`
  - `_stopMetronome()` → calls `metronomeCtrl.stop()`
  - `startTransport()` → starts Python metronome if metronome enabled
  - `stopTransport()` → stops Python metronome
  - `setMetronomeBeatsPerMeasure(n)` → calls `metronomeCtrl.setBeats(n)`

### 5. SystemD Service for Metronome
**Created:** `/home/pi/myprojects/midirouter/metronome.service` — systemd unit that:
- Runs as `pi` user with `audio` group
- Has `CAP_SYS_RAWIO` capability for ALSA access
- Autostarts Python metronome on boot
- Supports signal-based control (SIGUSR1/SIGUSR2)

---

## 🎛️ Control Flow

### Web UI → Metronome
```
Web UI (BPM + Metro toggle + Beats)
    ↓ WebSocket
server.js (forwards messages)
    ↓ worker-midi.js
DAW engine (setTempo / setMetronome / setMetronomeBeatsPerMeasure)
    ↓ MetronomeController (stdin IPC)
metronome.py → aplay -M → 3.5mm jack (headphones)
```

### Launchkey MIDI Clock → All Devices + Headphones
```
Launchkey DAW Port (0xF8 clock, 0xFA start, 0xFB continue, 0xFC stop)
    ↓ worker-midi.js (_onIncomingMessage)
    ├──→ Все USB-MIDI выходы (MTC 0xF8/0xFA/0xFB/0xFC)
    └──→ metronome.py → aplay -M → 3.5mm jack (headphones)
```

---

## 🎮 How to Control Metronome

### Via Web Interface (http://localhost:3000)
1. **Toggle metronome:** Click `♪ Metro` button (changes to `♫ Metro ON`)
2. **Change BPM:** Enter value in `BPM` field (20-300) or use `Tap` button
3. **Change beats per measure:** Select from `Beats` dropdown (1-8)
4. **Start/stop transport:** Click `▶ Play` / `⏹ Stop`

### Via Terminal (direct Python process)
```bash
# Start metronome
python3 metronome.py -B 120 -b 4 -v 0.8

# Control via stdin commands: start, stop, bpm <n>, beats <n>, status, quit

# Control via signals (when running in background):
kill -USR1 <PID>   # start/stop
kill -USR2 <PID>   # cycle BPM (120→90→60→100→80→120)
```

### Via systemd service (optional)
```bash
sudo cp metronome.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now metronome.service
```

---

## 🔧 Troubleshooting

### No sound from headphones?
- Check 3.5mm jack is properly inserted
- Verify volume: `amixer get PCM` (should be on, ~96%)
- Check ALSA output: `aplay -L` should list headphone device
- Check `metronome.py` process is running: `ps aux | grep metronome.py`

### MIDI clock not reaching devices?
1. Make sure devices are connected and show in `aplaymidi -l`
2. Try standalone test: `node test-midi-clock.js -d 3`
3. Check ⏱ MTC button is ON (highlighted) in web UI
4. Verify `/dev/snd/seq` permissions: `ls -la /dev/snd/seq` (should be `crw-rw---- root audio`)

### Worker init failing with "Operation not permitted"?
The worker can't access `/dev/snd/seq`. Fix:
```bash
# 1. Add pi user to audio group
sudo usermod -aG audio pi

# 2. Set permissions on /dev/snd/seq
sudo chmod 666 /dev/snd/seq

# 3. Create udev rule for persistent permissions
echo 'SUBSYSTEM=="sound", KERNEL=="seq", MODE="0666"' | sudo tee /etc/udev/rules.d/99-snd-seq-permissions.rules
sudo udevadm control --reload

# 4. Restart service
sudo systemctl restart midirouter.service
```

### Worker init timeout?
The worker might be hanging during port enumeration:
1. Check all USB-MIDI devices are connected
2. Check for conflicting processes: `ps aux | grep -E "node|python3 metronome"`
3. Kill any stuck processes and restart:
   ```bash
   ps aux | grep "[n]ode server.js" | awk '{print $2}' | while read pid; do kill "$pid"; done
   sleep 1
   sudo systemctl start midirouter.service
   ```

### High CPU usage by server?
The worker might be stuck in a loop:
1. Check the process state: `ps aux | grep "[n]ode server.js"` (look for `R` state)
2. Kill and restart:
   ```bash
   ps aux | grep "[n]ode server.js" | awk '{print $2}' | while read pid; do kill "$pid"; done
   sleep 1
   npm start
   ```

---

## 📊 Systemd Services

### midirouter.service (main service)
- **Location:** `/etc/systemd/system/midirouter.service`
- **User:** pi (with audio group + CAP_SYS_RAWIO)
- **ExecStart:** `/usr/bin/node server.js`
- **Restart:** always (3s delay)

### metronome.service (optional standalone metronome)
- **Location:** `/etc/systemd/system/metronome.service`
- **User:** pi (with audio group + CAP_SYS_RAWIO)
- **ExecStart:** `/usr/bin/python3 /home/pi/myprojects/midirouter/metronome.py -B 120 -b 4 -v 0.8`
- **Restart:** always (3s delay)
- **Signal control:** SIGUSR1 (start/stop), SIGUSR2 (BPM cycle)

---

## 🎹 MIDI Device Mapping

### Launchkey Mini MK3
- **DAW Port:** Transport, CC, and Note On messages
- **Pad mapping:** 16 pads → 4 tracks × 4 slots
- **MIDI Clock:** Receives MTC from server for sync

### NTS-1 digital kit
- **Role:** External synth/sequencer
- **Sync:** Receives MIDI Start/Stop/Clock from server

### Craft Synth 2.0
- **Role:** External synthesizer
- **Sync:** Receives MIDI Clock for tempo-synced arps/modulation

### nanoPAD2
- **Role:** Pad controller
- **Note:** Can receive clock but primarily an input device

---

## 🎵 Audio Architecture

### Python Metronome (`metronome.py`)
1. Generates `BUFFER_SECS` seconds of audio samples at 44,100 Hz
2. Places clicks at exact sample positions (1 kHz sine burst)
3. Writes to temporary WAV file
4. Plays via `aplay -M` (ALSA mmap mode) — hardware DMA streams at precise sample intervals
5. Loops: generates next buffer while previous plays

### Key parameters
- **BPM:** 20-300 (set via CLI or stdin command)
- **Beats per measure:** 1-16 (default 4)
- **Volume:** 0.0-1.0 (default 0.8)
- **Accent:** Louder first beat by default

---

## 📝 Development Notes

### Running in development mode
```bash
npm run dev
```

### Running in production mode
```bash
sudo systemctl start midirouter.service
```

### Viewing logs
```bash
# Server logs
journalctl -u midirouter.service -f

# Metronome logs (if using systemd service)
journalctl -u metronome.service -f
```

### Key commands for debugging
```bash
# Check ALSA devices
aplaymidi -l

# Check audio output device
aplay -L

# Check PCM volume
amixer get PCM

# Check headphone jack setting
amixer cget numid=3

# Check running processes
ps aux | grep -E "node|python3 metronome"

# Check MIDI clock test
node test-midi-clock.js -B 120 -d 5
```

---

## 🔄 Session State

The DAW engine maintains state across the session:
- **Tempo:** Current BPM (default 120)
- **Time signature:** Beats per measure (default 4/4)
- **Metronome enabled:** Boolean flag
- **MIDI Clock enabled:** Boolean flag
- **Record mode:** Current record mode setting
- **Clip state:** Which clips are playing on each track
- **Pad mapping:** Note → track/slot mapping for Launchkey pads

---

## 📚 Related Documentation

- `ARCHITECTURE.md` — Detailed system architecture
- `AUTO-CONNECT.md` — Auto-connect behavior and rules
- `BOOT.md` — Boot process and startup sequence
- `DEBUGGING.md` — Debugging tips and techniques
- `DEVICE-MAPPING.md` — Device mapping configuration
- `METRONOME.md` — Metronome and MIDI Clock guide (comprehensive)
- `README.md` — Project overview and quick start
- `SETUP.md` — Initial setup instructions
- `SPEC.md` — Full project specification
