// ---------------------------------------------------------------------------
// Regression: ALSA port index change with unchanged port name.
//
// Contract: when a MIDI input's ALSA port *index* changes while its *name*
// stays the same (e.g. after an unplugged/replugged device), `_checkHotplug`
// must detect the change, attempt a full re-enumeration, and — critically —
// NOT commit the new inventory snapshot when re-enumeration fails. The next
// poll retries; only after a successful re-enumeration does the snapshot
// advance to the new index.
//
// Known defect this locks down: `_checkHotplug` currently compares port *names*
// only (via `Set` membership). An index-only change produces identical name
// sets, so no hot-plug is detected, no re-enumeration is attempted, and the
// stale snapshot (old index) is left in place forever.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { MIDIRouterWorker } from '../worker-midi.js';

/**
 * Create a worker instance WITHOUT invoking the constructor, so no ALSA
 * hardware probes, audio devices, or timers are started. The prototype is
 * used directly; all state the test needs is seeded manually.
 */
function makeBareWorker() {
    const w = Object.create(MIDIRouterWorker.prototype);

    // Stub enumeration objects as plain sentinels — no ALSA clients created.
    w._enumIn  = { __stub: 'input' };
    w._enumOut = { __stub: 'output' };

    // `_filterPorts` returns a fixed inventory for each direction.
    // The input's *index* is what changes between polls; its name stays put.
    let currentIndex = 1;
    w._currentInputIndex = () => currentIndex;
    w._setCurrentInputIndex = (i) => { currentIndex = i; };

    w._filterPorts = function (_device, direction) {
        if (direction === 'in') {
            return [{ name: 'Fake MIDI Input', index: this._currentInputIndex() }];
        }
        return []; // no outputs in this scenario
    }.bind(w);

    // Seed the "previous" inventory snapshot: one input at index 1.
    w._lastInputNames  = new Set(['Fake MIDI Input']);
    w._lastOutputNames = new Set();
    w._lastInputPorts  = new Map([['Fake MIDI Input', 1]]);
    w._lastOutputPorts = new Map();

    // Disable auto-routing so no mapping rebuild is triggered.
    w._autoRouteOnHotplug = false;

    // `_enumeratePorts` fails twice, then succeeds (counts calls).
    let enumCalls = 0;
    w._enumeratePorts = function () {
        enumCalls++;
        return enumCalls >= 3; // fail on call 1 and 2, succeed on call 3
    };

    // Stub `_rebuildMappings` — no-op.
    w._rebuildMappings = function () {};

    return { worker: w, getState: () => ({ enumCalls }) };
}

test('index-only change with failed re-enumeration retries and does not advance snapshot', async () => {
    const { worker } = makeBareWorker();

    // --- Poll 1: index changes from 1 → 2; re-enumeration fails (call #1) ---
    worker._setCurrentInputIndex(2);

    const result1 = await worker._checkHotplug();
    assert.equal(result1, false,
        'first poll must report failure when re-enumeration is rejected');

    // The snapshot must NOT have advanced: previous index 1 is preserved.
    assert.equal(worker._lastInputPorts.get('Fake MIDI Input'), 1,
        'snapshot must retain the old index (1) after a failed re-enumeration');

    // --- Poll 2: same inventory; re-enumeration fails again (call #2) ---
    const result2 = await worker._checkHotplug();
    assert.equal(result2, false,
        'second poll must also report failure (re-enumeration still rejected)');

    assert.equal(worker._lastInputPorts.get('Fake MIDI Input'), 1,
        'snapshot must still retain the old index (1) after second failure');

    // --- Poll 3: same inventory; re-enumeration succeeds (call #3) ---
    const result3 = await worker._checkHotplug();
    assert.equal(result3, true,
        'third poll must succeed once re-enumeration is accepted');

    // The snapshot must now advance to the new index.
    assert.equal(worker._lastInputPorts.get('Fake MIDI Input'), 2,
        'snapshot must advance to the new index (2) after successful re-enumeration');
});
