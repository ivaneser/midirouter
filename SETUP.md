# SETUP & DEPLOYMENT

## 🟢 Plug & Play for Raspberry Pi (recommended)
Flash Raspberry Pi OS with Imager → log in over SSH → once:
```bash
sudo bash bootstrap.sh
```
Everything is done automatically: Wi-Fi `master`, Node.js, the `audio` group, the UMP fix, server autostart. Details — **`BOOT.md`**.

## Installation on Ubuntu (Raspberry Pi)

### System requirements
- Node.js v22+ 
- ALSA Sequencer (`/dev/snd/seq`) — the Linux kernel MIDI driver
- Access rights to `/dev/snd/*` (group `audio` or `plugdev`)

### Installing dependencies
```bash
cd ~/myprojects/midirouter
npm install
```

### Configuring ALSA Sequencer

#### 1. Load virtual MIDI ports (for testing)
```bash
# Automatic script:
sudo bash setup-midi-emulator.sh

# Or manually:
sudo modprobe snd-seq-dummy midi_devs=2
sudo modprobe snd-seq-virmidi midi_devs=2
```

#### 2. Disable UMP Mode (Universal MIDI Ports)
ALSA 1.2+ runs in UMP mode, which hides the legacy ports from `aconnect`.

**Fix:** create a configuration file:
```bash
sudo bash -c 'echo "options snd-seq enable_ump=0" > /etc/modprobe.d/snd-seq-ump.conf'
```
⚠️ **Requires a system reboot!** Without it `aconnect` will not show the virtual ports.

#### 3. Access rights to `/dev/snd/seq`
If you get `Permission denied`:
```bash
# Add the user to the audio group:
sudo usermod -aG audio $USER
sudo usermod -aG plugdev $USER
# Log out and back in!
```

#### 4. Verify it works
```bash
aconnect -o        # Show output ports
aconnect -i        # Show input ports
lsmod | grep snd   # Loaded ALSA modules
cat /proc/asound/seq/devices  # Sequencer devices
```

### Emulator autostart (systemd)
```bash
sudo cp midi-emulator.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable midi-emulator.service
sudo systemctl start midi-emulator.service
```

## Installation on macOS (Mac Mini)

macOS has no ALSA — the native CoreMIDI through RtMidi is used.

### Installation
```bash
cd ~/myprojects/midirouter
npm install
node server.js
```

CoreMIDI works without extra configuration. All USB-MIDI devices are detected automatically by the system.

## Starting the server
```bash
# Normal mode:
node server.js

# Development mode (auto-reload):
node --watch server.js
```

The server starts at `http://localhost:3000`, and the WebSocket is on port 3000.

## Containerization (Docker)
```bash
docker build -t midirouter .
docker run --privileged -p 3000:3000 midirouter
```

The `Dockerfile` and `docker/etc/supervisord.conf` provide a basic configuration.

## Device data structure

### device_maps/*.json
MIDI device descriptions for dynamic rendering of the UI controls:
- `arturia_microfreak.json`
- `korg_nts1.json`  
- `modal_craft_synth_v2.json`
- `preenfm2.json`
- `waldorf_blofeld.json`

Format:
```json
{
    "name": "NTS-1",
    "controls": [
        {"cc": 20, "label": "PITCH BEND", "min": -8192, "max": 8191},
        {"cc": 37, "label": "BANK SELECT", "min": 0, "max": 127}
    ]
}
```

### Automatic lookup of mapping schemas
When there is no local JSON, the server makes a request to the GitHub API:
```
https://api.github.com/search/code?q=...
```
