# Auto-connect

## Goal
Automatically detect MIDI controllers and synthesizers and create routes by pressing a key on the controller — without manual actions in the interface. Supports **several controllers**, each of which connects to all available synthesizers.

## How it works

### 1. Initiation
Auto-connect starts **automatically** when the server starts, after the ports are detected (the `ready` event):

```js
// server.js: ready handler
case 'ready':
    if (!this.autoConnectStarted) {
        this.autoConnectStarted = true;
        console.log('[SERVER] MIDI initialized — starting auto-connect...');
        setTimeout(() => this.startAutoConnect(), 200);
    }
    break;
```

**Duplicate protection:** the server tracks the `discoveryActive` flag and does not start another sweep if discovery is already active. The worker also checks `this.discoveryState.active`.

### 2. Device classification
The worker collects all unrouted (without routes) input and output ports:

- **All unrouted inputs** — become controllers
- **Unrouted outputs, excluding ports of the same physical devices** — become targets

```js
// Normalize the port name → base device name
_deviceBase(name) {
    let n = name.trim();
    n = n.replace(/\s+(MIDI|DAW)\s+Port$/i, '');      // "Launchkey DAW Port" → "Launchkey"
    n = n.replace(/\s+(KBD\/?KNOB|SOUND)$/i, '');     // "NTS-1 KBD/KNOB" → "NTS-1"
}

// Filter the targets: exclude outputs whose base matches any input's base
const allInputBases = new Set(allInputs.map(c => _deviceBase(c.name)));
for (const controller of allInputs) {
    const targets = allOutputs
        .filter(o => o.id !== controller.id && !allInputBases.has(_deviceBase(o.name)))
        .map(o => o.id);  // only synths, not the controller's ports
}
```

**Example:** the Launchkey Mini MK3 has two ports (`MIDI Port`, `DAW Port`). Both are excluded from the targets for all controllers. The remaining targets: NTS-1 SOUND, Craft Synth 2.0.

### 3. Synth sweep (ping sequence)
For each target device a sequence of **5 notes** is run with an interval of **1 second**:

```js
_pingSynth(targetId, controllerId):
    sentCount = 0, maxPings = 5
    
    pingOnce():
        if sentCount >= 5:
            → timeout, move on to the next synth for this controller
            _nextSynthForController(controllerId)
            
        _sendTestNoteToOutput(targetId)   // C4 (0x90 0x3C 0x7F) + note off after 100 ms
        sentCount++
        
        timer = setTimeout(pingOnce, 1000)  # next note after 1 s
```

### 4. Waiting for note ON from the controllers
During the ping the worker filters the incoming MIDI messages:

```js
// _routeMessage() while discovery is active:
controllerState = discoveryState.controllers.get(inputPortId)

if (!controllerState):
    → not an active controller, ignore
    
statusByte = message[0]
isNoteOn = (statusByte & 0xF0) === 0x90 && message[2] > 0

if (!isNoteOn):
    → ignore (CC from knobs, note off, etc.)
    
if inputPortId in controllers:
    → create a route controller → synth at the current index
    → send a double confirmation note
    → _nextSynthForController(inputPortId)
```

**Important:** the filter `(statusByte & 0xF0) === 0x90` keeps only note on (0x90-0x9F). CC messages (0xB0-0xBF) are ignored — they can come from turning the knobs on the synthesizers.

### 5. Connection confirmation
When a note ON is received:
1. The current ping timer is stopped
2. A route `input → output` is created through `_createRoute()` — **channel = null (all channels)**
3. A double confirmation note is sent (`_sendConfirmationNote()`) — two C4 notes 200 ms apart
4. The target synth is marked as connected in `connectedTargets`
5. Move on to the next synth for this controller

> **Important:** discovery routes do not filter by MIDI channel — all key presses reach all connected synthesizers regardless of the controller's channel. Channel filtering is available only through the manual UI selector (dropdown `ALL / CH1–CH16`) for each route.

### 6. Finishing discovery
```js
_nextSynthForController(controllerId):
    controllerState.currentTargetIdx++
    
    if connectedTargets.size == targets.length:
        → all targets connected, remove the controller from discoveryState.controllers
        
    if controllers.size == 0:
        → all controllers finished, _endDiscovery()
        
    else:
        → continue the ping cycle from the next synth
```

## Discovery states

### `discoveryState` structure
| Field | Description |
|------|----------|
| `active` | true during the sweep of all controllers |
| `controllers` | Map<controllerId, {targets, connectedTargets, currentTargetIdx}> — state of each controller |
| `unroutedCounters` | Message counter for unrouted inputs (for fallback discovery) |

### State transitions
```
[START] → discoveryState.active = true
           ↓
    [PING CYCLE] ← sweep all targets in a circle
           ↓
    [NOTE ON received] → create a route, move on to the next target
           ↓
    [ALL TARGETS CONNECTED] → controllers.delete(controllerId)
           ↓
    [NO CONTROLLERS LEFT] → _endDiscovery() → active = false
```

## Fallback auto-discovery (without auto-connect)
If a device sends MIDI without a route and discovery was not started manually:
1. The first 3 messages are sent to the client for visualization
2. After **5 seconds** without a route — a default route is created to the first available output port

## Commands
```js
// Sending the auto-connect command (from the UI or automatically):
server.worker.postMessage({ type: 'auto-connect' });

// Server response to the client when finished:
{ "type": "discovery-complete" }
```

## Typical test scenarios

### Scenario 1: one controller → several synthesizers
1. Start the server → automatic sweep of all unrouted outputs
2. Press a key on the Launchkey during the ping of the first synth → route created
3. Press again → route to the second synth
4. Check the log: `received note ON from Launchkey → connecting to Korg NTS-1`

### Scenario 2: several controllers → several synthesizers
1. Each unrouted input becomes a separate controller
2. Each controller sweeps all unrouted outputs
3. Pressing on each controller creates a route to the next available synth

### Scenario 3: protection against an endless ping
1. If a synth does not respond — a timeout after 5 attempts
2. Move on to the next synth instead of looping
3. Discovery finishes when all controllers are handled

### Scenario 4: multi-port device (Launchkey)
1. The Launchkey Mini MK3 is detected as two input ports (`MIDI Port`, `DAW Port`) and two output ports
2. `_deviceBase()` normalizes both ports to one base name → both are excluded from the targets
3. Discovery pings only NTS-1 SOUND and Craft Synth 2.0
4. Pressing a key on any channel of the Launchkey creates a route to all connected synthesizers (no channel filtering)

## Errors and debugging

| Situation | Cause | Fix |
|----------|---------|---------|
| Endless sweep | Outdated `_nextSynth()` without an `allConnected` check | Fixed: a completion check for each controller |
| False routes from CC knobs | Filter not applied | `(statusByte & 0xF0) === 0x90` keeps only note ON |
| Duplicate auto-connect | Several calls to `startAutoConnect()` | `discoveryActive` flags in the server and the worker |
| "Cannot create route: invalid outputId" | Port not found in `this.outputs` | Check `outputs.has(outputId)` before creating the route |

## Comparison of the old and new architecture

### Before the fix (single controller)
```
discoveryState: {
    waitingForInput: "Launchkey",  // UNAMBIGUOUS!
    unroutedOutputs: ["NTS-1", "Craft"],
    currentOutputIndex: 0          // one index for everyone
}

_nextSynth():
    index++ → _pingAllSynths()  // always loops!
```

### After the fix (multi-controller)
```
discoveryState: {
    controllers: Map {
        "Launchkey": { targets: ["NTS-1", "Craft"], connectedTargets: Set{}, currentTargetIdx: 0 },
        "AbletonPush2": { targets: ["NTS-1", "Craft"], connectedTargets: Set{}, currentTargetIdx: 0 }
    }
}

_nextSynthForController("Launchkey"):
    index++ → check allConnected → if so, remove from the Map
    _endDiscovery() when all controllers are finished
```
