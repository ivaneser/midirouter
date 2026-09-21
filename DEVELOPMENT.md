# Development Notes — Known Issues & Next Steps

## Current State (post-session analysis)

### 🔴 Critical: ALSA Sequencer Resource Exhaustion
**Symptom:** `open /dev/snd/seq failed: Cannot allocate memory`

**Root cause:** Every call to `new midi.Input()` or `new midi.Output()` (RtMidi → ALSA backend) creates a **new ALSA sequencer client**. Linux/ALSA has a hard limit (~8 clients by default for non-root). The hot-plug detector runs every 2 seconds creating `new midi.Input()` + `new midi.Output()` — after ~16 seconds all ALSA slots are exhausted. Subsequent `_enumeratePorts()` calls fail, and previously opened ports in the worker thread stop working.

**Partial fix applied:** Reusing persistent `_enumIn`/`_enumOut` objects for hot-plug detection (instead of creating new ones). This stops the leak from the detector side.

**BUT:** The remaining leak is from `_enumeratePorts()` itself — when it opens new input/output ports it creates RtMidi objects. If opening fails mid-enumeration, old ports were being closed **before** new ones opened, leaving the system in a broken half-state.

**Fix applied:** Two-phase atomic enumeration (open all new first, then close old). This prevents partial state.

**Still needed:**
- ✅ **Back-off logic implemented**: exponential back-off 5s→30s on ALSA failures, resets to 5s on success.
- ✅ **Hot-plug interval reduced** to 5s default (was 2s), with back-off up to 30s.
- Consider using `ALSA_SEQ_MAX_CLIENTS` sysctl or running as root (not recommended).
- Alternative: switch from RtMidi ALSA Sequencer to ALSA Raw MIDI (no sequencer client limit, but no hot-plug naming).

---

### 🔴 Critical: `this.outputs` becomes empty → no synth routing
**Symptom:** `[MIDI RX]` messages arrive, but `[MIDI TX]` never appears.

**Root cause:** When hot-plug runs and `_enumeratePorts()` fails with ALSA error, the old outputs get removed (closed) but new ones fail to open. `this.outputs` becomes an empty Map. All subsequent MIDI messages have nowhere to route.

**Fix applied:** Two-phase enumeration with atomic commit — if any open fails, we abort and leave old ports untouched.

**Verification needed:** After the fix, check logs for `[WORKER] Input opened:` / `[WORKER] Output opened:` lines after hot-plug events. If ALSA is still exhausted from prior runs, a full service restart may be needed.

---

### 🟡 High: Metronome process double-ownership
**Symptom:** Metronome doesn't respond to controller Start/Stop, or behaves erratically.

**Root cause:** Two things try to own `metronome.py`:
1. `metronome.service` (systemd) — starts metronome.py as a standalone service
2. `metronome-controller.js` inside the worker — spawns its own `metronome.py` via `child_process.spawn`

This creates **two** metronome.py processes. The controller sends `start`/`stop`/`bpm` via stdin to **its** child, but systemd's copy is the one actually holding the ALSA audio device.

**✅ Fixed:** `metronome.service` ExecStart commented out + disabled via `systemctl disable`. The Node.js `metronome-controller.js` is now the sole owner of metronome.py. The metronome should be **only** owned by Node.js `metronome-controller.js`, which starts it as a child process when the worker initializes. The systemd unit should only manage `midirouter.service` (which starts server.js → worker-midi.js → metronome.py as a child).

---

### 🟡 High: DAW Port Note 12 (C-1) mis-handled as clip trigger
**Symptom:** When Launchkey enters DAW mode, it sends `noteOn ch16 n12 v127`. This is **not** a session pad — it's the DAW mode activation handshake. Our code routes it to `_handleControllerNote`, which tries to trigger a clip for track/slot mapped to note 12.

**✅ Fixed:** Added filter `if (bytes[1] < 20) return;` in the DAW Port note handler — ignores control notes 0-19 including note 12 (C-1 DAW mode handshake).

```javascript
if (isNoteOn || isNoteOff) {
    if (bytes[1] < 20) {
        console.log(`[DAW] Ignoring control note ${bytes[1]} on DAW Port`);
        return;
    }
    // ... clip handling
}
```

---

### 🟡 High: nanoPAD auto-learn blocked by `isSessionPadRange >= 60`
**Symptom:** nanoPAD notes don't auto-map to clip slots.

**Root cause:** nanoPAD2 default factory mapping sends notes **36–51** (C1–D#2). My `isSessionPadRange = n >= 60` blocks all of them from being learned.

**✅ Fixed:** Removed `isSessionPadRange >= 60` gate. Auto-learn now uses device-name-based rules: Launchkey MIDI Port is never auto-learned; everything else (nanoPAD, DAW Port) can auto-learn. The keybed sends notes < 60 on `MIDI Port`, session pads send 112–127 on `DAW Port`.

```javascript
const isLaunchkeyKeybed = deviceName.toLowerCase().includes('launchkey') 
    && !deviceName.toLowerCase().includes('daw port');
if (isLaunchkeyKeybed) {
    // Never auto-learn; always route to synths
    return;
}
// Everything else (nanoPAD, DAW Port, other controllers) can auto-learn
```

---

### 🟠 Medium: `autoAssign = false` by default breaks zero-setup experience
**Symptom:** User plugs in Launchkey, presses pads — nothing happens (no clip slots assigned).

**Trade-off:** `autoAssign = true` causes musical notes to be captured. `autoAssign = false` means manual web-UI mapping only.

**✅ Fixed:** `autoAssign` set to `true` by default with device-specific rules applied in `_onIncomingMessage`.
- Launchkey `MIDI Port` (keybed) → NEVER auto-learn, always route to synths
- Launchkey `DAW Port` (session pads 112–127) → hard-mapped by `_applyDefaultPadMap`, no auto-learn needed
- nanoPAD / other drum pads → auto-learn to next free slot
- Keyboard controllers without DAW Port → auto-learn all notes (no note threshold)

---

### 🟠 Medium: Web UI `input-list`/`output-list` missing in HTML
**Fix applied:** Added MIDI Devices panel to `index.html`.

**Still needed:** The panel doesn't auto-refresh when hot-plug events arrive. The `DeviceManager.render()` is called on `devices` message, but after a hot-plug the server sends `hotplug-notification`, not `devices`. **✅ Fixed:** `app.js` now sends `get-devices` request on every `hotplug-notification`, keeping the Devices panel in sync.

---

### 🟠 Medium: `sendPanicNoteOff()` on every enumeration causes noise
**Symptom:** Brief blip/click in synths when devices are detected.

**Root cause:** `_enumeratePorts()` sends All Notes Off on all channels to all outputs every time. This is defensive but noisy.

**✅ Fixed:** `sendPanicNoteOff()` now called only on initial startup and when an input is removed — no more panic on output add or routine hot-plug.

---

### 🟢 Low: `unknown sys` spam from active sensing
**Symptom:** `sys unknown sys` logs every ~300ms from Launchkey DAW Port.

**Root cause:** Launchkey sends `0xFE` (Active Sensing) constantly. The label mapping doesn't handle it.

**Fix:** Already filtered (ignored) correctly. Just needs a quieter label:
```javascript
const name = label || (type >= 8 ? `sys  ${bytes[0] === 0xf8 ? 'clock' : bytes[0] === 0xfa ? 'start' : bytes[0] === 0xfb ? 'continue' : bytes[0] === 0xfc ? 'stop' : bytes[0] === 0xfe ? 'active_sense' : 'unknown'}` : `raw#${bytes.join(',')}`);
```

---

## Recommended Immediate Actions

1. ✅ **Two-phase enumeration** — tested via hot-plug/unplug cycles; verify no `Cannot allocate memory`.
2. ✅ **Disabled `metronome.service`** — Node.js owns the metronome child process exclusively.
3. ✅ **Fixed nanoPAD auto-learn** — removed `isSessionPadRange`, using device-name-based protection.
4. ✅ **Filtered DAW Port control notes** — ignoring notes < 20 on DAW Port.
5. ✅ **Added hot-plug backoff** — exponential back-off 5s→30s on ALSA failure.

## Long-term Architecture Questions

- Should we drop RtMidi/ALSA-Sequencer and use ALSA-Raw-MIDI for the router? Raw MIDI doesn't create sequencer clients, has no client limit, but loses port naming.
- Should hot-plug use `udev`/`inotify` on `/dev/snd/` instead of polling ALSA?
- Should the metronome be a Node.js native audio module (e.g., `speaker` + `web-audio-engine`) instead of Python subprocess?
