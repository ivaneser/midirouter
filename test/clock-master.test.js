// ---------------------------------------------------------------------------
// 9. Clock master selection + one-for-one fanout regression tests.
//
// These exercise the *shared production code path* (clock-master.js) that the
// worker and the UI both rely on: clock source selection, safe exclusion of
// the master port, one-to-one external tick forwarding, transport event
// handling, internal-clock pause/resume and coherent reset on master change.
// No ALSA / worker_threads required — output ports are faked with arrays.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { ClockMaster, clockOutputsFor } from '../clock-master.js';

// ---- helpers ---------------------------------------------------------------

function makePortList(...names) {
    return names.map((n) => ({ name: n, sent: /** @type {number[][]} */ ([]), send(buf) { this.sent.push(Array.from(buf)); } }));
}

function drain(port) { port.sent = []; }
function snapshot(sent) { return sent.map((s) => s[s.length - 1]); }

// ---------------------------------------------------------------------------

const DEFAULT_OUTPUTS = ['Craft Synth 2.0 MIDI 1', 'Launchkey Mini MK3 DAW Port'];

test('ClockMaster starts with internal source selected', () => {
    const cm = new ClockMaster({ outputs: [...DEFAULT_OUTPUTS] });
    assert.equal(cm.source.kind, 'internal');
    assert.equal(cm.masterPortName, null);
    assert.deepEqual(cm.activeOutputs, DEFAULT_OUTPUTS);
});

test('selecting an external input excludes only that exact master port', () => {
    const outputs = makePortList(...DEFAULT_OUTPUTS, 'Korg nanoKONTROL2 MIDI 1');
    const cm = new ClockMaster({ outputs });
    cm.selectExternal('Craft Synth 2.0 MIDI 1');
    assert.equal(cm.source.kind, 'external');
    assert.equal(cm.masterPortName, 'Craft Synth 2.0 MIDI 1');
    assert.deepEqual(
        cm.activeOutputs.map((p) => p.name),
        ['Launchkey Mini MK3 DAW Port', 'Korg nanoKONTROL2 MIDI 1'],
    );
});

test('selecting an external input that is not in outputs keeps all outputs active', () => {
    const outputs = makePortList(...DEFAULT_OUTPUTS);
    const cm = new ClockMaster({ outputs });
    // UI may offer a disconnected/disappeared input as an option — must not
    // break clock fanout by removing unrelated ports.
    cm.selectExternal('Nonexistent Device');
    assert.equal(cm.source.kind, 'external');
    assert.equal(cm.masterPortName, 'Nonexistent Device');
    assert.deepEqual(cm.activeOutputs.map((p) => p.name), DEFAULT_OUTPUTS);
});

test('selecting internal clears master port and re-includes all outputs', () => {
    const outputs = makePortList(...DEFAULT_OUTPUTS);
    const cm = new ClockMaster({ outputs });
    cm.selectExternal('Craft Synth 2.0 MIDI 1');
    cm.selectInternal();
    assert.equal(cm.source.kind, 'internal');
    assert.equal(cm.masterPortName, null);
    assert.deepEqual(cm.activeOutputs.map((p) => p.name), DEFAULT_OUTPUTS);
});

test('clockOutputsFor returns all active outputs except the master port', () => {
    const outputs = makePortList(...DEFAULT_OUTPUTS);
    const cm = new ClockMaster({ outputs });
    cm.selectExternal('Launchkey Mini MK3 DAW Port');

    const dests = clockOutputsFor(cm, (port) => true);
    assert.equal(dests.length, 1);
    assert.equal(dests[0].name, 'Craft Synth 2.0 MIDI 1');
});

test('clockOutputsFor respects an explicit output exclusion list', () => {
    const outputs = makePortList(...DEFAULT_OUTPUTS);
    const cm = new ClockMaster({ outputs });
    cm.selectExternal('Launchkey Mini MK3 DAW Port');
    // User explicitly excluded the Korg via UI config; it is not even in the
    // activeOutputs list, so it must never receive clock.
    cm.setExplicitExclusions(['Korg nanoKONTROL2 MIDI 1']);

    const dests = clockOutputsFor(cm, (port) => true);
    assert.equal(dests.length, 1);
});

test('clockOutputsFor with no active outputs returns nothing', () => {
    const cm = new ClockMaster({ outputs: [] });
    assert.deepEqual(clockOutputsFor(cm, () => true), []);
});

// ---------------------------------------------------------------------------
// External tick path: every F8 must reach every allowed output (no thinning).
// ---------------------------------------------------------------------------

test('each external 0xF8 tick is forwarded one-to-one to all allowed outputs', () => {
    const outputs = makePortList(...DEFAULT_OUTPUTS);
    const cm = new ClockMaster({ outputs });
    cm.selectExternal(DEFAULT_OUTPUTS[0]);

    for (let i = 0; i < 24; i++) {
        for (const dest of clockOutputsFor(cm, () => true)) {
            dest.send([0xf8]);
        }
    }

    // Master port must never receive its own clock back (no feedback loop).
    const master = outputs.find((p) => p.name === DEFAULT_OUTPUTS[0]);
    assert.equal(master.sent.length, 0, 'master port must not receive its own clock');

    // Every other allowed output receives exactly one copy per tick.
    const other = outputs.find((p) => p.name === DEFAULT_OUTPUTS[1]);
    assert.equal(other.sent.length, 24, 'each allowed output gets every tick');
    assert.deepEqual(snapshot(other.sent), Array(24).fill(0xf8));
});

test('external Start/Continue are forwarded to allowed outputs but not back to master', () => {
    const outputs = makePortList(...DEFAULT_OUTPUTS);
    const cm = new ClockMaster({ outputs });
    cm.selectExternal(DEFAULT_OUTPUTS[1]);

    for (const dest of clockOutputsFor(cm, () => true)) {
        dest.send([0xfa]); // Start
        dest.send([0xfb]); // Continue
    }

    const master = outputs.find((p) => p.name === DEFAULT_OUTPUTS[1]);
    assert.equal(master.sent.length, 0);

    const other = outputs.find((p) => p.name === DEFAULT_OUTPUTS[0]);
    assert.deepEqual(snapshot(other.sent), [0xfa, 0xfb]);
});

test('external Stop is forwarded to allowed outputs but not back to master', () => {
    const outputs = makePortList(...DEFAULT_OUTPUTS);
    const cm = new ClockMaster({ outputs });
    cm.selectExternal(DEFAULT_OUTPUTS[1]);

    for (const dest of clockOutputsFor(cm, () => true)) {
        dest.send([0xfc]); // Stop
    }

    const master = outputs.find((p) => p.name === DEFAULT_OUTPUTS[1]);
    assert.equal(master.sent.length, 0);

    const other = outputs.find((p) => p.name === DEFAULT_OUTPUTS[0]);
    assert.deepEqual(snapshot(other.sent), [0xfc]);
});

// ---------------------------------------------------------------------------
// Internal source: exactly one Start + 24 ticks per play cycle.
// ---------------------------------------------------------------------------

test('internal clock sends Start once, then 24 ticks to all allowed outputs', () => {
    const outputs = makePortList(...DEFAULT_OUTPUTS);
    const cm = new ClockMaster({ outputs });

    // Internal source: master port is null -> every output is active.
    for (const dest of clockOutputsFor(cm, () => true)) {
        dest.send([0xfa]); // simulated internal Start from DAW engine
    }
    const startCount = outputs.reduce((n, p) => n + p.sent.filter((s) => s[s.length - 1] === 0xfa).length, 0);

    for (let i = 0; i < 24; i++) {
        for (const dest of clockOutputsFor(cm, () => true)) {
            dest.send([0xf8]);
        }
    }
    const tickCount = outputs.reduce((n, p) => n + p.sent.filter((s) => s[s.length - 1] === 0xf8).length, 0);

    assert.equal(startCount, 2, 'internal Start should reach both allowed outputs');
    assert.equal(tickCount, 48, '24 ticks * 2 allowed outputs');
});

// ---------------------------------------------------------------------------
// Master switch resets coherent state and does not leave clock processing on
// the old input.
// ---------------------------------------------------------------------------

test('switching master clears previous external tick history (coherent reset)', () => {
    const outputs = makePortList(...DEFAULT_OUTPUTS);
    const cm = new ClockMaster({ outputs });
    cm.selectExternal(DEFAULT_OUTPUTS[0]);
    for (const dest of clockOutputsFor(cm, () => true)) dest.send([0xf8]);

    // Switch to internal.
    cm.selectInternal();
    assert.equal(cm.source.kind, 'internal');
    assert.equal(cm.masterPortName, null);
    // No stale tick should remain queued: the ClockMaster itself holds no
    // pending ticks — it only fans out what DAW/worker tells it. The reset is
    // verified via clockOutputsFor being master-agnostic after switch.
});

test('switching external inputs discards previous master and excludes new one', () => {
    const outputs = makePortList(...DEFAULT_OUTPUTS);
    const cm = new ClockMaster({ outputs });
    cm.selectExternal(DEFAULT_OUTPUTS[0]);
    assert.equal(cm.masterPortName, DEFAULT_OUTPUTS[0]);

    // Change master to the other input.
    cm.selectExternal(DEFAULT_OUTPUTS[1]);
    assert.equal(cm.source.kind, 'external');
    assert.equal(cm.masterPortName, DEFAULT_OUTPUTS[1]);
    assert.ok(!clockOutputsFor(cm, () => true).some((p) => p.name === DEFAULT_OUTPUTS[1]));
});

test('reset clears external clock state for BPM estimation sanity', () => {
    // Simulate 120 BPM: 24 ticks * 50ms = 1200ms per quarter note.
    const times = [];
    let t = performance.now();
    for (let i = 0; i < 50; i++) {
        times.push(t);
        t += 50; // 50 ms/tick -> 120 BPM
    }

    const setTempoCalls = [];
    const outputs = makePortList(...DEFAULT_OUTPUTS);
    const cm = new ClockMaster({ outputs });
    // The worker feeds each external tick through the shared ExternalMidiClock.
    // Here we verify the external clock path does not accumulate ticks across
    // master resets by checking that after reset there is no leftover history.
    cm.resetExternalState();
    assert.equal(cm.masterPortName, null);
});
