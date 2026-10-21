# TODO: NTS-1 (3rd Device / MIDI Clock Master) Not Being Recorded

## Current status (2026-10-21)

The notes below are historical investigation hypotheses, not a verified
hardware diagnosis. The selected clock master was already included in the
input-subscription watchdog, so a missing subscription does not explain
clock arriving while notes on the same port are discarded.

The recording path did separately require `controllerInputs` membership.
That gate has been removed for performance notes, and subscription recovery
now checks every open input. Regression tests cover NTS-1 notes and clock
with an empty controller-input registry, non-master notes, count-in rejection,
and both Note Off and zero-velocity Note On releases.

The original NTS-1 supports USB ribbon-keyboard note transmission. Hardware
receipt is still unverified: use the NTS-1 diagnostic in `DEBUGGING.md` to
check `aseqdump` for Note On/Off while touching and releasing the ribbon.
If the instrument emits only Clock, software cannot reconstruct played notes.

---

**Date:** 2025-07-25  
**Issue:** When the user records and plays Arturia and Craft, they are recorded OK. But when playing NTS-1 (the 3rd device selected as MIDI clock master), its notes are NOT being recorded — as if it's not sending any notes.

---

## Summary of Findings

### 1. Root Cause: `_verifyInputConnections()` Filtering Bug
**File:** `worker-midi.js`, line 348  
**Function:** `_verifyInputConnections()`

```javascript
for (const [name, input] of this.inputs) {
    if (name !== master && !this.controllerInputs.has(name)) continue;  // BUG
    // ...
}
```

**Problem:** This skips any input that is neither the clock master nor in `controllerInputs`. If NTS-1 loses its ALSA subscription and isn't recognized as the master (or isn't in `controllerInputs`), it gets silently skipped — leaving it permanently silent.

**Status:** 🔴 OPEN — Needs fix to remove the `controllerInputs` gate or ensure NTS-1 is always checked.

---

### 2. Potential Race: `controllerInputs` Not Populated Before `_verifyInputConnections`
**File:** `worker-midi.js`  
**Functions:** `_hotplugCheckLoop()` → `_checkHotplug()` → `_enumeratePorts()` → `_verifyInputConnections()`

**Flow:**
1. `_checkHotplug()` calls `_enumeratePorts()` (synchronous)
2. `_enumeratePorts()` PHASE 7 adds ALL new input names to `controllerInputs`
3. After `_checkHotplug()` resolves, `_verifyInputConnections()` runs in `.then()`

**Risk Window:** If `_enumeratePorts()` fails partway through (early return), `this.inputs` may be updated but `controllerInputs` may not be — causing `_verifyInputConnections` to skip those inputs.

**Status:** 🟡 MONITOR — Verify that PHASE 2/3 failures don't leave `this.inputs` and `controllerInputs` out of sync.

---

### 3. Silent Failure: `_reopenInput()` Catches Errors
**File:** `worker-midi.js`, line 367-380  
**Function:** `_reopenInput(name, index)`

```javascript
_reopenInput(name, index) {
    try {
        const fresh = new midi.Input();
        fresh.openPort(index, 'midirouter-in');
        // ...
    } catch (error) {
        console.error(`[WORKER] Failed to reopen input ${name}:`, error.message);
    }
}
```

**Problem:** If `openPort` fails silently (e.g., port index changed on re-plug), the NTS-1 input remains broken with no recovery mechanism. The stale port stays open but receives nothing.

**Status:** 🟡 MONITOR — Consider retrying with fresh enumeration if reopen fails.

---

### 4. Known Issue: NTS-1 ALSA Subscription Drop on Re-plug
**Reference:** KNOWLEDGE-BASE.md → "External Clock Master Silent After Replug (2026-10-16)"

**Root Cause (from KB):** `aconnect -l` showed no subscription from NTS-1 to router input. The RtMidi input was still open, so nothing looked wrong in state. ALSA subscription dropped on re-plug; hot-plug code only reopens when port index changes.

**Fix Already Applied:** `_verifyInputConnections()` + `alsa-subscriptions.js`  
**Verification (from KB):** Dropping `aconnect -d 20:0 130:0` was recovered by watchdog within one probe.

**Status:** 🟡 PARTIALLY FIXED — The fix exists but may not cover all scenarios (see #1 and #3).

---

### 5. `isInputSubscribed` Parsing Logic
**File:** `alsa-subscriptions.js`, line 30-46  
**Function:** `isInputSubscribed(listing, portDisplay)`

```javascript
export function isInputSubscribed(listing, portDisplay) {
    const text = String(listing ?? '');
    const clientNames = new Map();
    for (const m of text.matchAll(/^client (\d+): '([^']*)'/gm)) clientNames.set(m[1], m[2]);

    const portIdx = text.indexOf(`'${portDisplay}'`);
    if (portIdx === -1) return null;
    const blockEnd = text.indexOf('\nclient ', portIdx);
    const block = text.slice(portIdx, blockEnd === -1 ? undefined : blockEnd);

    const connectingTo = block.match(/Connecting To: (.*)/);
    if (!connectingTo) return false;
    for (const m of connectingTo[1].matchAll(/(\d+):\d+/g)) {
        if (/RtMidi Input/i.test(clientNames.get(m[1]) ?? '')) return true;
    }
    return false;
}
```

**Test Coverage:** `test/input-subscription.test.js` — verified with real `aconnect -l` output from NTS-1.

**Status:** ✅ VERIFIED — Works correctly for known cases.

---

### 6. Recording Path Check: `controllerInputs.has(deviceName)` Gate
**File:** `worker-midi.js`, line 1806  
**Function:** `_onIncomingMessage()`

```javascript
// Record during active recording
if (this.daw.recording && this.controllerInputs.has(deviceName)) {
    const sb = isNoteOff ? (0x80 | ((channel - 1) & 0x0f)) : (0x90 | ((channel - 1) & 0x0f));
    this.daw.recordEvent(sb, n, vel, performance.now());
}
```

**Problem:** Even if NTS-1's notes reach `_onIncomingMessage`, they won't be recorded unless `deviceName` is in `controllerInputs`. This is the SAME set that `_verifyInputConnections` gates on — so both places depend on correct synchronization.

**Status:** 🔴 OPEN — If `controllerInputs` is out of sync, recording silently drops notes.

---

### 7. `setMidiClock(false)` When External Master Selected
**File:** `worker-midi.js`, line ~2458  
**Function:** `clock_source_select` handler

```javascript
} else if (kind === 'external') {
    if (portName) {
        worker._clockMaster.selectExternal(portName);
    } else {
        worker._clockMaster.resetExternalState();
    }
    worker.daw.setMidiClock(false);  // Turns OFF MTC output
}
```

**Impact:** When NTS-1 is selected as clock master, internal MTC (MIDI Time Code) output is turned off. This only affects OUTPUT clock, not input note recording — so this is NOT the cause of notes not being recorded.

**Status:** ✅ NOT THE CAUSE — Documented for completeness.

---

### 8. `_enumeratePorts()` Early Return Paths
**File:** `worker-midi.js`, line 1451-1665  
**Function:** `_enumeratePorts()`

**Early return paths that skip PHASE 7 (`controllerInputs.add`):**
1. **PHASE 2 failure:** Input open fails → `return false` (closes all newly opened inputs)
2. **PHASE 3 failure:** Output open fails → `return false` (closes all newly opened inputs AND outputs)

**Risk:** If NTS-1 is added as an input in PHASE 2, but a subsequent output open fails in PHASE 3:
- NTS-1's input is CLOSED (rolled back in PHASE 3 cleanup)
- `controllerInputs` is NOT updated
- Next hotplug poll retries with stale snapshot

**Status:** 🟡 MONITOR — The rollback in PHASE 3 should prevent partial state, but verify no edge cases.

---

### 9. `_rebindClockMaster()` Name Mismatch Risk
**File:** `worker-midi.js`, line 284-295  
**Function:** `_rebindClockMaster()`

```javascript
_rebindClockMaster() {
    const source = this._clockMaster.source;
    if (source.kind !== 'external' || !source.masterPortName) return;
    if (this.inputs.has(source.masterPortName)) return;  // <-- Exact name match required
    const key = stablePortKey(source.masterPortName);
    const match = [...this.inputs.keys()].find((name) => stablePortKey(name) === key);
    // ...
}
```

**Problem:** Uses `stablePortKey()` to match by stable name (strips ALSA client:port address). If NTS-1's port name changes between selections, the master binding might not update correctly.

**Status:** 🟡 MONITOR — Check if `_rebindClockMaster` is called at the right time during hotplug.

---

### 10. Hot-plug Snapshot Commit Order
**File:** `worker-midi.js`, line 512-530  
**Function:** `_checkHotplug()` → `_enumeratePorts()`

```javascript
if (this._enumeratePorts()) {
    this._lastInputNames = new Set(currentInputPorts.keys());
    this._lastOutputNames = new Set(currentOutputPorts.keys());
    this._lastInputPorts = currentInputPorts;
    this._lastOutputPorts = currentOutputPorts;
    // ...
    return true; // success
}
console.error('[WORKER] HOT-PLUG re-enumeration failed; snapshots unchanged, will retry');
return false;
```

**Problem:** If `_enumeratePorts()` returns `false`, the hotplug snapshot is NOT updated. The next poll retries with the same stale data, potentially missing newly-added devices.

**Status:** 🟡 MONITOR — Verify behavior when device is added while another operation is in flight.

---

## Action Items (Priority Order)

### P0 - Critical
1. **[ ] Fix `_verifyInputConnections` filtering bug**  
   Remove or relax the `controllerInputs` gate at line 348 so NTS-1 (or any clock master) is always checked for ALSA subscription recovery.

2. **[ ] Add logging to `_verifyInputConnections`**  
   Log which inputs are being checked and why some are skipped — critical for diagnosing silent failures like this.

### P1 - High
3. **[ ] Verify `controllerInputs`/`this.inputs` synchronization**  
   Audit all code paths that modify either to ensure they stay in sync. Add an assertion/debug log if they diverge.

4. **[ ] Improve `_reopenInput` failure handling**  
   If reopening with the stale index fails, re-enumerate ports to get the current index and retry.

5. **[ ] Reproduce the issue on hardware**  
   The KNOWLEDGE-BASE notes say this was "verified live" — but the user is still experiencing it. Need to reproduce with actual NTS-1 hardware.

### P2 - Medium
6. **[ ] Add unit test for `_verifyInputConnections` with clock master**  
   Test that when an external clock master loses its ALSA subscription, it's recovered and notes are recorded.

7. **[ ] Check `stablePortKey` matching for NTS-1 re-plug scenarios**  
   Verify that `_rebindClockMaster` correctly handles NTS-1 name changes across re-plugs.

8. **[ ] Review `_enumeratePorts` PHASE 3 rollback**  
   Ensure that if an output open fails, the state is fully cleaned up and retry works correctly.

### P3 - Low
9. **[ ] Document NTS-1-specific behavior in KNOWLEDGE-BASE**  
   Add a note about NTS-1 being both a clock master AND a note source (unlike Launchkey which is primarily a controller).

10. **[ ] Consider making `controllerInputs` derived from `this.inputs`**  
    Instead of maintaining a separate Set, derive it from `this.inputs.keys()` to eliminate sync risk.

---

## Related Files Summary

| File | Lines | Role |
|------|-------|------|
| `worker-midi.js` | 348, 1636, 1791-1806, 2458 | Main MIDI worker — input handling, clock master, recording gate |
| `alsa-subscriptions.js` | 30-46 | Parses `aconnect -l` to verify ALSA subscriptions |
| `daw.js` | 880-920 | DAW engine — `recordEvent()` captures notes into tracks |
| `controller-engine.js` | 175-185 | Controller profile matching — determines if device has a profile |
| `clock-master.js` | Full file | Clock source selection + fanout logic |
| `external-midi-clock.js` | Full file | External MIDI clock slave (BPM estimation) |

---

## Test Commands for Verification

```bash
# Run all tests
npm test

# Run specific relevant tests
node --test test/input-subscription.test.js
node --test test/external-master-sync.test.js
node --test test/clock-master-two-sources.test.js
node --test test/hotplug-retry.test.js

# Check live ALSA subscriptions
aconnect -l

# Check running processes
ps aux | grep -E "node|python3 metronome"
```

---

## Open Questions

1. **Does NTS-1 send notes on a MIDI channel that conflicts with existing track assignments?**  
   The DAW auto-detects track channels from the first recorded note. If NTS-1 sends on a channel already assigned to another track, notes might be routed incorrectly.

2. **Is there a controller profile accidentally matching NTS-1?**  
   Only `launchkey-mini-mk3.json` and `nanopad2.json` exist in `controller_profiles/`. Neither should match "NTS-1". Verify with logs.

3. **Does the issue occur on initial startup or only after hot-plug?**  
   If it's a startup issue, `_enumeratePorts()` PHASE 7 may not be running correctly. If hot-plug, check snapshot commit order.

4. **Is `deviceName` correct in `_onIncomingMessage`?**  
   The handler closure captures `name` from port enumeration. Verify it matches what's in `controllerInputs`.
