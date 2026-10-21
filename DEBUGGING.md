# DEBUGGING & KNOWN ISSUES

## Common errors and fixes

### 1. `open /dev/snd/seq failed: Permission denied`
**Cause:** the user is not in the `audio` or `plugdev` group.
**Fix:**
```bash
sudo usermod -aG audio $USER
sudo usermod -aG plugdev $USER
# Log out and back in! (logout/login)
```

### 2. ALSA UMP Mode — ports are not visible through `aconnect`
**Symptom:** `aconnect -o` shows only `Midi Through`, even though the modules are loaded.
**Cause:** ALSA 1.2+ runs in Universal MIDI Ports mode; legacy endpoints are hidden.
**Fix:**
```bash
# Create the UMP-disable config:
sudo bash -c 'echo "options snd-seq enable_ump=0" > /etc/modprobe.d/snd-seq-ump.conf'
# A system reboot is required!
```

### 3. `ERR_MODULE_NOT_FOUND: Cannot find package 'ws'`
**Cause:** `node_modules` is excluded from git and is not installed locally.
**Fix:**
```bash
npm install
```

### 4. The server does not stop on Ctrl-C
**Cause:** the worker blocks exit, or the WebSocket connections are not closed.
**Diagnosis:** pressing `ctrl-c` several times before it stops.
**Fix:** in `server.js` the `cleanup()` method must shut the worker down correctly:
```js
process.on('SIGINT', async () => {
    console.log('[SERVER] Shutting down...');
    if (worker) {
        worker.postMessage({ type: 'shutdown' });
        // Check: if the worker has not exited within 3 s — terminate
        await new Promise(resolve => setTimeout(resolve, 3000));
        if (!worker.exited) {
            console.log('[SERVER] Worker did not exit gracefully — terminating');
            worker.terminate();
        }
    }
    server.close();
    process.exit(0);
});
```

### 5. `Cannot create route: invalid outputId undefined`
**Cause:** `_createRoute()` checked `this.routes.has(outputId)` instead of `this.outputs.has(outputId)`.
**Fix:** replace the check with validation that the port exists in outputs.

### 6. Duplicate UI cards for devices
**Cause:** `loadDevices()` loaded ALL JSON files from `data/devices/`, and `renderDynamicControls()` did not clear the container before rendering.
**Fix:**
- Remove the JSON loader from controller-ui.js
- Rewrite `_updateDeviceList()` to filter real devices
- Clear `devices-container.innerHTML = ''` before rendering

### 7. Duplicate MIDI event handlers (handler duplication)
**Cause:** the watchdog called `_enumeratePorts()` every 5 seconds, adding new `midiIn.on('message', ...)` handlers without removing the old ones.
**Fix:** remove the watchdog from the main loop entirely. Handlers are attached once, when the port is opened.

### 8. False routes from synthesizer CC knobs
**Cause:** during auto-connect the server caught any MIDI message, including CC (0xBx) from turning the knobs on the synthesizers.
**Fix:** filter `(statusByte & 0xF0) === 0x90` — accept only note ON.

### 9. Auto-connect runs twice
**Cause:** an automatic start on the `ready` event AND a manual button in the frontend.
**Fix:** remove the "Auto-connect" button from the UI and keep only the automatic start.

### 10. External clock master silent after a device replug
**Symptom:** the clock master is selected in the UI (e.g. NTS-1), the device sends clock, but the router tempo stays at the internal value (e.g. 120 BPM) and clips do not follow the master.
**Cause:** the router's RtMidi input for the device stays "open", but the kernel dropped its ALSA subscription when the device was unplugged. RtMidi subscribes only in `openPort()`, so nothing receives the clock. Before the fix only *outputs* had a subscription watchdog.
**Diagnosis:**
```bash
aseqdump -p "NTS-1"        # does the device send Clock? (~24 per beat)
aconnect -l                # device port must show "Connecting To: <RtMidi Input client>"
```
If the device has no `Connecting To:` into an `RtMidi Input Client`, the input is dead.
**Fix:** `_verifyInputConnections()` in `worker-midi.js` checks every open input in the hot-plug loop and reopens stale inputs (logs `Input lost ALSA subscription`). Parsing lives in `alsa-subscriptions.js`; tests in `test/input-subscription.test.js`.
**Workaround before the fix:** `systemctl --user restart midirouter.service`, then re-select the master in the UI (the selection is not persisted across restarts).

## MIDI device diagnostics

### NTS-1 sends clock but ribbon notes are not recorded

The original NTS-1 supports ribbon-keyboard note transmission over USB MIDI;
its 3.5 mm MIDI connector is an input. See Korg's
[MIDI connectivity guide](https://cdn.korg.com/us/support/download/files/40b4cf13fa40a3f9f821559b794dd9f5.pdf)
and [MIDI implementation chart](https://cdn.korg.com/us/support/download/files/8b4225f3349d609272fcf7ac868212cc.pdf).
Clock messages alone do not establish that the instrument sends note messages.

On the Raspberry Pi, inspect the instrument directly:

```bash
aseqdump -l
aseqdump -p 20:0  # example: replace 20:0 with the NTS-1 source port listed above
```

Touch and release the ribbon while monitoring. Look for `Note on` and `Note off`
(or Note On with velocity zero), alongside Clock. If notes are absent here,
the router has no note events to record; investigate the instrument/USB MIDI
path. This check does not require changing the clock master.

If notes appear, record an empty pad after its count-in. Incoming performance
notes from every input now enter the recording path, including the clock
master and synths with no controller profile. Previously this path required
membership in `controllerInputs`, so stale registration could accept a synth's
clock while discarding its notes. The clock-master filter applies only to
timing and transport messages. Recording still rejects notes before its
scheduled start; notes from other inputs remain recordable under an NTS-1 clock.

Software regression coverage: `test/synth-master-recording.test.js` exercises
master and non-master notes, both release encodings, the count-in gate, clock
continuity, and subscription recovery without controller registration.

### Checking that the ALSA modules are loaded
```bash
lsmod | grep snd_seq
# Should show: snd_seq_dummy, snd_seq_virmidi, snd_seq_midi, ...
```

### Checking ports
```bash
aconnect -o          # Output ports
aconnect -i          # Input ports
aconnect -l          # All connections
```

### Checking through RtMidi (Node.js)
The script `test-midi-detection.js`:
```bash
node test-midi-detection.js
# Shows all ports visible through @julusian/midi
```

### Viewing sequencer devices
```bash
cat /proc/asound/seq/devices
```

## Server debug modes
```bash
# With logging:
node server.js 2>&1 | tee midirouter.log

# Auto-reload on changes:
node --watch server.js
```
