# Device connection (Device Mapping)

## Mapping by device name
USB-MIDI devices are bound to routes by a **stable name**, not by a temporary port index. This keeps the routes when:
- Hot-plugging (reconnecting the USB cable)
- Rebooting the system
- The order in which devices are connected changes

### How ALSA/RtMidi works
| Parameter | Description |
|----------|----------|
| **Device name** | Stable, for example "Korg nanoKONTROL2 MIDI 1", "NTS-1 digital kit KBD/KNOB" |
| **Port index** | Temporary number (0, 1, 2...), changes on hot-plug or restart |

### Implementation in the worker
```js
// Worker-midi.js — constructor:
this.nameToPortId = new Map();   // deviceName → portId
this.portIdToName = new Map();   // portId → deviceName (reverse mapping)

// _enumeratePorts() — storing the name→portId link:
for (const newPort of realInputs) {
    const deviceName = newPort.name;  // stable device name
    
    this.inputs.set(deviceName, midiIn);       // the key is the name, not the index!
    this.nameToPortId.set(deviceName, deviceName);
    this.portIdToName.set(deviceName, deviceName);
    
    console.log(`[WORKER] Input added: ${deviceName} (index: ${newPort.index})`);
}

// Update on hot-plug (the index changed):
if (currentIndex !== newPort.index) {
    // Remove the old handler, close the port
    existingRtMidiIn.closePort();
    
    // Open the new port with the same portId (device name)
    const midiIn = new midi.Input();
    midiIn.openPort(newPort.index, 'midirouter-in');
    
    this.inputs.set(deviceName, midiIn);  // same key — the name!
}
```

## Route data structure
```js
this.routes = new Map();   // deviceName → [{ outputId, channels }]
// channels = null (default) → all MIDI channels
// channels = [1] or [1,3] → filtering by the specified channels
// Example:
// "Launchkey Mini MK3 MIDI Port" → [
//   { outputId: "NTS-1 digital kit SOUND", channels: null },
//   { outputId: "Craft Synth 2.0", channels: [2] }
// ]
```

**Creating routes:**
- **Auto-connect (discovery):** `channels = null` — all key presses reach the connected synthesizer regardless of the controller's MIDI channel.
- **Manual UI:** the user selects a channel through the dropdown (`ALL / CH1–CH16`) on the port card; the route gets an array of channels for filtering.

## Hot-plug handling
When the port index changes:
1. `_enumeratePorts()` detects the device with the new index
2. The old handler is removed (`inp.off('message', inp._handler)`)
3. The port is closed (`inp.closePort()`)
4. The new port is opened with the same portId (device name)
5. The handler is attached again

## Dynamic device maps
Devices may have descriptions in JSON format for controlling parameters:

```json
{
    "name": "NTS-1",
    "controls": [
        {"cc": 20, "label": "PITCH BEND", "min": -8192, "max": 8191},
        {"cc": 37, "label": "BANK SELECT", "min": 0, "max": 127}
    ]
}
```

Files are stored in `device_maps/`:
- `arturia_microfreak.json`
- `korg_nts1.json`
- `modal_craft_synth_v2.json`
- `preenfm2.json`
- `waldorf_blofeld.json`

### Automatic lookup of mapping schemas
When there is no local JSON match, the server makes a request to the GitHub API:
```
https://api.github.com/search/code?q=...
```

## Device normalization (`_deviceBase()`)
During auto-connect the worker normalizes port names by removing the function suffixes:

| Full port name | `_deviceBase()` → base name |
|------------------|-------------------------------|
| "Launchkey Mini MK3 MIDI Port" | "Launchkey Mini MK3" |
| "Launchkey Mini MK3 DAW Port" | "Launchkey Mini MK3" |
| "NTS-1 digital kit KBD/KNOB" | "NTS-1 digital kit" |
| "NTS-1 digital kit SOUND" | "NTS-1 digital kit" |
| "Craft Synth 2.0" | "Craft Synth 2.0" |

**Principle:** outputs whose base name matches any input's base are excluded from the discovery targets — this prevents pinging the controller's ports instead of the synthesizers.

## Typical device names
| Device | Name in the system |
|------------|---------------|
| Launchkey Mini MK3 MIDI Port | "Launchkey Mini MK3 MIDI Port" |
| NTS-1 digital kit KBD/KNOB | "NTS-1 digital kit KBD/KNOB" |
| Craft Synth 2.0 | "Craft Synth 2.0" |
