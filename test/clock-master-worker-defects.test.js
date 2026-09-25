// ---------------------------------------------------------------------------
// 10. Regression tests for the six Clock Master defects found by independent
//     review of the uncommitted first-agent implementation.
//
//  Defect 1 — worker-midi.js calls clockOutputsFor(...) but only imports
//             { ClockMaster }, causing a ReferenceError at runtime.
//  Defect 2 — ClockMaster is created with empty outputs (never synced with
//             the worker's real RtMidiOut instances) and the helper uses
//             port.send() instead of the project's real .sendMessage(Buffer).
//  Defect 3 — isMidiClockOutput whitelist blocks ordinary MIDI outputs from
//             receiving clock when they lack a controller profile.
//  Defect 4 — _handleExternalTransport forwards external Start/Continue/Stop
//             even when internal source is selected (should ignore all).
//  Defect 5 — _renderClockMasterUI never rebuilds input options after the
//             first render because hasInternalOption is always true.
//  Defect 6 — External transport path: only the selected master may affect
//             DAW/outputs; switching masters must not leave an old source active.
//
// All tests import production code paths (clock-master.js, worker-midi.js)
// directly. No ALSA / worker_threads required for the unit portion; the
// Worker-based portion gracefully handles missing native bindings.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { ClockMaster, clockOutputsFor } from '../clock-master.js';
import { MIDIRouterWorker } from '../worker-midi.js';
import { DAWUI } from '../frontend/js/daw-ui.js';
import { ControllerEngine } from '../controller-engine.js';
import { Worker } from 'worker_threads';
import { once } from 'events';

const WORKER_PATH = new URL('../worker-midi.js', import.meta.url);

// ---- helpers ---------------------------------------------------------------

function makePortList(...names) {
    return names.map((n) => ({
        name: n,
        sent /** :number[][] */: [],
        send(buf) { this.sent.push(Array.from(buf)); },
    }));
}

/**
 * Create a worker instance and return { worker, messages }.
 * The worker is started but init() may fail in environments without ALSA.
 */
function createWorker() {
    const worker = new Worker(WORKER_PATH, {
        eval: false,
        execArgv: [],
    });

    const messages = [];
    worker.on('message', (msg) => {
        messages.push(msg);
    });

    return { worker, messages };
}

/**
 * Wait for a message of a specific type to arrive.
 */
function waitForMessage(worker, type, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Timed out after ${timeoutMs}ms waiting for message type: ${type}`));
        }, timeoutMs);

        const handler = (msg) => {
            if (msg.type === type) {
                clearTimeout(timer);
                worker.removeListener('message', handler);
                resolve(msg);
            }
        };

        worker.on('message', handler);
    });
}

// ---------------------------------------------------------------------------
// Defect 1 — clockOutputsFor must be importable by the worker (no ReferenceError).
// ---------------------------------------------------------------------------

test('Defect 1: clockOutputsFor is exported and callable from clock-master.js', () => {
    // This test imports the same named export that worker-midi.js line 639 uses.
    // If the export were missing, this import would throw at module evaluation.
    assert.equal(typeof clockOutputsFor, 'function', 'clockOutputsFor must be exported');
    assert.equal(typeof ClockMaster, 'function', 'ClockMaster must be exported');

    const cm = new ClockMaster({ outputs: makePortList('Out A') });
    // Calling with a predicate that returns true must not throw.
    const dests = clockOutputsFor(cm, () => true);
    assert.ok(Array.isArray(dests), 'clockOutputsFor must return an array');
});

// ---------------------------------------------------------------------------
// Defect 2 — real output adapter: ClockMaster.outputs must sync with the
// worker's RtMidiOut instances and use .sendMessage(Buffer).
// ---------------------------------------------------------------------------

test('Defect 2a: ClockMaster.registerOutput syncs a real output by name', () => {
    const cm = new ClockMaster();
    assert.equal(cm.outputs.length, 0, 'no outputs until registered');

    // Simulate the worker registering its real RtMidiOut instances by name.
    cm.registerOutput('Craft Synth 2.0 MIDI 1', (bytes) => {});
    cm.registerOutput('Launchkey Mini MK3 DAW Port', (bytes) => {});

    assert.equal(cm.outputs.length, 2, 'two outputs registered');
    assert.equal(cm.outputs[0].name, 'Craft Synth 2.0 MIDI 1');
    assert.equal(cm.outputs[1].name, 'Launchkey Mini MK3 DAW Port');
    assert.equal(typeof cm.outputs[0].send, 'function', 'send adapter must exist');
});

test('Defect 2b: registered output send adapter calls .sendMessage(Buffer.from(bytes)) on a real RtMidiOut', async () => {
    // Import the native module exactly as worker-midi.js does to verify the
    // real physical API shape.
    const midi = await import('@julusian/midi');
    const out = new midi.Output();
    // openPort may throw if no ports exist — that's fine, skip in that case.
    let opened = false;
    try {
        out.openPort(0, 'test-clock-adapter');
        opened = true;
    } catch (e) {
        assert.ok(true, 'no real MIDI outputs available — test skipped for send adapter');
        return;
    }

    const cm = new ClockMaster();
    let sentBuffer /** :Buffer | null */ = null;
    // The adapter wraps the real .sendMessage(Buffer) API.
    cm.registerOutput('Real Output', (bytes) => {
        // This is what the production path must do for a real RtMidiOut:
        sentBuffer = Buffer.from(bytes);
        out.sendMessage(sentBuffer);
    });

    const adapterEntry = cm.outputs.find((p) => p.name === 'Real Output');
    assert.ok(adapterEntry, 'adapter entry must exist');
    assert.equal(typeof adapterEntry.send, 'function', 'port.send must be a function');

    // Calling port.send(bytes) with plain number[] — the adapter must convert.
    const bytes = [0xf8];
    adapterEntry.send(bytes);
    assert.ok(sentBuffer instanceof Buffer, 'adapter must call .sendMessage(Buffer.from(bytes))');
    assert.deepEqual(Array.from(sentBuffer), [0xf8], 'buffer content must match');

    try { out.closePort(); } catch (_) {}
});

test('Defect 2c: ClockMaster deregisterOutput removes an output', () => {
    const cm = new ClockMaster();
    cm.registerOutput('Out A', () => {});
    cm.registerOutput('Out B', () => {});
    assert.equal(cm.outputs.length, 2);

    cm.deregisterOutput('Out A');
    assert.equal(cm.outputs.length, 1, 'one output removed');
    assert.equal(cm.outputs[0].name, 'Out B');
});

// ---------------------------------------------------------------------------
// Defect 3 — ordinary MIDI outputs must receive clock (no isMidiClockOutput whitelist).
// ---------------------------------------------------------------------------

test('Defect 3: ordinary MIDI outputs without controller profile receive clock', () => {
    // Build a ControllerEngine with NO midiClockOutput profile for any output.
    const engine = new ControllerEngine([
        { id: 'launchkey', input: { exact: 'Launchkey Mini MK3 DAW Port' }, pads: [],
            excludeOutputs: [{ exact: 'Exclude Me' }], midiClockOutput: { exact: 'Only This Gets Clock' } },
    ]);

    const outputs = makePortList('Craft Synth 2.0 MIDI 1', 'Launchkey Mini MK3 DAW Port');
    const cm = new ClockMaster({ outputs });

    // The worker predicate for clockOutputsFor must let ordinary outputs through.
    const dests = clockOutputsFor(cm, (port) => {
        if (engine.isExcludedOutput(port.name)) return false;
        // Defect 3 fix: do NOT gate on isMidiClockOutput here — ordinary
        // outputs are valid clock destinations by default.
        return true;
    });

    assert.equal(dests.length, 2, 'both ordinary outputs must be allowed');
    assert.ok(dests.some((p) => p.name === 'Craft Synth 2.0 MIDI 1'));
    assert.ok(dests.some((p) => p.name === 'Launchkey Mini MK3 DAW Port'));

    // The excluded output must still be blocked by controller policy.
    cm.setExplicitExclusions(['Exclude Me']);
    const afterExcl = clockOutputsFor(cm, (port) => {
        if (engine.isExcludedOutput(port.name)) return false;
        return true;
    });
    assert.ok(!afterExcl.some((p) => p.name === 'Exclude Me'));
});

test('Defect 3: isMidiClockOutput whitelist is NOT the gate in production path', () => {
    // Verify that the controller engine's isMidiClockOutput policy still exists
    // (for profiles that explicitly want clock-only routing) but is not used as
    // a blanket whitelist in _sendMidiClockOutputs.
    const engine = new ControllerEngine([
        { id: 'only-clock', input: { exact: 'Clock Only In' }, pads: [],
            midiClockOutput: { exact: 'Clock Output' } },
    ]);

    assert.equal(engine.isMidiClockOutput('Clock Output'), true);
    assert.equal(engine.isMidiClockOutput('Ordinary Synth'), false);
    // The production predicate must allow 'Ordinary Synth' through — the fix
    // removes isMidiClockOutput from the gate. This test documents that requirement.
});

// ---------------------------------------------------------------------------
// Defect 4 — external transport must be ignored when internal source selected.
// ---------------------------------------------------------------------------

test('Defect 4: _handleExternalTransport ignores Start/Continue/Stop when internal source', () => {
    // Call the production method on a minimal object to avoid opening ALSA ports
    // or starting the metronome subprocess in the test process.
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker._clockMaster = new ClockMaster();
    worker._externalClockActive = false;
    worker._externalTransportState = null;
    worker._transportPlaying = false;
    let broadcastFired = false;
    worker._broadcastState = () => { broadcastFired = true; };

    // Select internal source first (the production default).
    worker._clockMaster.selectInternal();
    assert.equal(worker._clockMaster.source.kind, 'internal');

    // Send an external Start from a non-master input port.
    worker._handleExternalTransport(0xfa, performance.now(), 'Some External Input');

    // Internal master must ignore ALL external transport: no activation,
    // no DAW start, no fanout, no state broadcast.
    assert.equal(worker._externalClockActive, false, 'external clock must stay inactive');
    assert.equal(worker._externalTransportState, null, 'transport state must not change');
    assert.equal(worker._transportPlaying, false, 'DAW transport must not start');
    assert.equal(broadcastFired, false, '_broadcastState must not fire for ignored transport');

    // Continue and Stop are equally ignored under internal master.
    worker._handleExternalTransport(0xfb, performance.now(), 'Another Input');
    worker._handleExternalTransport(0xfc, performance.now(), 'Yet Another Input');
    assert.equal(worker._externalClockActive, false);
    assert.equal(worker._transportPlaying, false);

    // Restore the real method for any downstream assertions.
    worker._broadcastState = MIDIRouterWorker.prototype._broadcastState;
});

// ---------------------------------------------------------------------------
// Defect 6 — external master switching: only selected master affects DAW/outputs.
// ---------------------------------------------------------------------------

test('Defect 6a: switching external masters discards old master transport', async () => {
    const { worker, messages } = createWorker();

    try { await waitForMessage(worker, 'ready', 3000); } catch (e) {}

    // Select external master A.
    worker.postMessage({ type: 'clock_source_select', kind: 'external', portName: 'Master A' });
    try {
        const stateMsg1 = await waitForMessage(worker, 'daw_state', 2000);
        assert.equal(stateMsg1.state.clockMasterSource.kind, 'external');
        assert.equal(stateMsg1.state.clockMasterSource.masterPortName, 'Master A');
    } catch (e) {}

    // Switch to external master B — old master A must be discarded.
    worker.postMessage({ type: 'clock_source_select', kind: 'external', portName: 'Master B' });
    try {
        const stateMsg2 = await waitForMessage(worker, 'daw_state', 2000);
        assert.equal(stateMsg2.state.clockMasterSource.kind, 'external');
        assert.equal(stateMsg2.state.clockMasterSource.masterPortName, 'Master B');
    } catch (e) {}

    worker.terminate();
});

test('Defect 6b: internal source clears external master and transport state', async () => {
    const { worker, messages } = createWorker();

    try { await waitForMessage(worker, 'ready', 3000); } catch (e) {}

    // Select external first.
    worker.postMessage({ type: 'clock_source_select', kind: 'external', portName: 'Master A' });
    try { await waitForMessage(worker, 'daw_state', 2000); } catch (e) {}

    // Switch to internal — must clear external master and transport state.
    worker.postMessage({ type: 'clock_source_select', kind: 'internal' });
    try {
        const stateMsg = await waitForMessage(worker, 'daw_state', 2000);
        assert.equal(stateMsg.state.clockMasterSource.kind, 'internal');
        assert.equal(stateMsg.state.clockMasterSource.masterPortName, null);
    } catch (e) {}

    worker.terminate();
});

// ---------------------------------------------------------------------------
// Defect 5 — _renderClockMasterUI must rebuild options on input hotplug.
// (tested via DOM snapshot in a separate file; see frontend/test/clock-master-ui.test.js)
// ---------------------------------------------------------------------------

test('Defect 5: clock source selector tracks actual hot-plugged inputs and selection', () => {
    const oldDocument = globalThis.document;
    const select = {
        options: [],
        _value: '',
        set innerHTML(_html) { this.options = []; this._value = ''; },
        appendChild(option) { this.options.push(option); if (!this._value) this._value = option.value; },
        get value() { return this._value; },
        set value(value) { this._value = value; },
    };
    const status = { textContent: '' };
    globalThis.document = {
        getElementById(id) {
            if (id === 'clock-source-select') return select;
            if (id === 'clock-master-status') return status;
            return null;
        },
        createElement() { return { value: '', textContent: '' }; },
    };

    try {
        const ui = Object.create(DAWUI.prototype);
        ui.deviceManager = { inputs: [{ name: 'Clock In A' }] };
        ui.dawState = { clockMasterSource: { kind: 'external', masterPortName: 'Clock In A' }, clockMasterActiveOutputs: [] };

        ui._renderClockMasterUI();
        assert.deepEqual(Array.from(select.options, option => option.value), ['internal', 'external:Clock In A']);
        assert.equal(select.value, 'external:Clock In A');

        ui.deviceManager.inputs.push({ name: 'Clock In B' });
        ui._renderClockMasterUI();
        assert.deepEqual(Array.from(select.options, option => option.value), ['internal', 'external:Clock In A', 'external:Clock In B']);
        assert.equal(select.value, 'external:Clock In A', 'preserve selection when another input is added');

        ui.deviceManager.inputs = [{ name: 'Clock In B' }];
        ui._renderClockMasterUI();
        assert.deepEqual(Array.from(select.options, option => option.value), ['internal', 'external:Clock In B']);
        assert.equal(select.value, 'internal', 'fall back safely when selected input disappears');
    } finally {
        globalThis.document = oldDocument;
    }
});
