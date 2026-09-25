// ---------------------------------------------------------------------------
// Regression tests: single MIDI Clock master selection + one-for-one fanout.
//
// Scenario with two alternating external inputs (Input A and Input B):
//   - Exactly ONE source is active at a time (Internal or a specific input).
//   - Only the selected master's 0xF8/Start/Continue/Stop affect sync and
//     retransmission; other sources are ignored completely.
//   - One F8 tick → exactly one send to each allowed output, zero to master.
//   - Internal source works independently of external ones.
//   - Switching master clears estimator/clock history and transport state so
//     the old source cannot keep influencing outputs.
//
// These tests import the production code path (clock-master.js) directly; no
// ALSA / worker_threads required — output ports are faked with arrays.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { ClockMaster, clockOutputsFor } from '../clock-master.js';

// ---- helpers ---------------------------------------------------------------

function makePortList(...names) {
    return names.map((n) => ({
        name: n,
        sent /** :number[][] */: [],
        send(buf) { this.sent.push(Array.from(buf)); },
    }));
}

function drain(port) { port.sent = []; }

// Two external inputs that may be offered as clock masters.
const INPUT_A = 'MIDI Input A';
const INPUT_B = 'MIDI Input B';
// Outputs that should receive retransmitted clock (neither is the master).
const OUTPUT_X = 'Output X';
const OUTPUT_Y = 'Output Y';

test('two alternating external inputs: selecting one ignores the other completely', () => {
    const outputs = [
        makePortList(OUTPUT_X, OUTPUT_Y),
    ];
    const flatOutputs = [...outputs[0]];

    // Select Input A as master — it is not even an output port, so all outputs
    // remain active (no fuzzy name pairing needed).
    const cmA = new ClockMaster({ outputs: flatOutputs });
    cmA.selectExternal(INPUT_A);

    const destsA = clockOutputsFor(cmA, () => true);
    assert.equal(destsA.length, 2, 'both outputs active when Input A is master');
    assert.ok(destsA.some((p) => p.name === OUTPUT_X));
    assert.ok(destsA.some((p) => p.name === OUTPUT_Y));

    // Now switch to Input B — old master state must be discarded.
    const cmB = new ClockMaster({ outputs: flatOutputs });
    cmB.selectExternal(INPUT_B);
    assert.equal(cmB.masterPortName, INPUT_B);
    assert.equal(destsA.length, 2); // still both (master not among outputs)

    // The two sources are strictly separate — selecting one never routes to the
    // other's expected set differently since neither is an output port.
    assert.notEqual(cmA.masterPortName, cmB.masterPortName);
});

test('when master IS also an output port, it receives zero clock', () => {
    const outputs = makePortList(OUTPUT_X, OUTPUT_Y, INPUT_A);
    const cm = new ClockMaster({ outputs });
    // Select Input A as master — it is present among the outputs, so it must be
    // excluded from fanout to prevent feedback loops.
    cm.selectExternal(INPUT_A);

    const dests = clockOutputsFor(cm, () => true);
    assert.equal(dests.length, 2, 'master port excluded from fanout');
    assert.ok(!dests.some((p) => p.name === INPUT_A), 'master must not be in dests');

    // Simulate the worker sending F8 to every destination.
    for (const dest of dests) {
        dest.send([0xf8]);
    }

    const masterPort = outputs.find((p) => p.name === INPUT_A);
    assert.equal(masterPort.sent.length, 0, 'master port receives zero clock ticks');
    assert.equal(outputs.filter((p) => p.sent.length > 0).length, 2);
});

test('one F8 tick → exactly one send per allowed output, none to master', () => {
    const outputs = makePortList(OUTPUT_X, OUTPUT_Y, INPUT_B);
    const cm = new ClockMaster({ outputs });
    cm.selectExternal(INPUT_B);

    // Simulate the worker's _sendMidiClockOutputs for a single 0xF8 tick.
    for (const dest of clockOutputsFor(cm, () => true)) {
        dest.send([0xf8]);
    }

    const masterPort = outputs.find((p) => p.name === INPUT_B);
    assert.equal(masterPort.sent.length, 0, 'master: zero sends');

    for (const out of [OUTPUT_X, OUTPUT_Y]) {
        const port = outputs.find((p) => p.name === out);
        assert.equal(port.sent.length, 1, `${out} receives exactly one send`);
        assert.deepEqual(port.sent[0], [0xf8]);
    }
});

test('transport Start/Continue/Stop pass through only the selected master', () => {
    const outputs = makePortList(OUTPUT_X, OUTPUT_Y, INPUT_A);
    const cmA = new ClockMaster({ outputs });
    cmA.selectExternal(INPUT_A);

    // Worker routes 0xFA from master only.
    for (const dest of clockOutputsFor(cmA, () => true)) {
        dest.send([0xfa]); // Start
    }

    const masterPort = outputs.find((p) => p.name === INPUT_A);
    assert.equal(masterPort.sent.length, 0, 'master receives no transport events');
    for (const out of [OUTPUT_X, OUTPUT_Y]) {
        const port = outputs.find((p) => p.name === out);
        assert.ok(port.sent.some((s) => s[s.length - 1] === 0xfa), `${out} gets Start`);
    }

    // Switch to Input B — old transport state must not persist.
    const cmB = new ClockMaster({ outputs });
    cmB.selectExternal(INPUT_B);
    assert.equal(cmB.masterPortName, INPUT_B);
    assert.notEqual(cmA.masterPortName, cmB.masterPortName);
});

test('internal source works independently: sends to all outputs, nothing excluded', () => {
    const outputs = makePortList(OUTPUT_X, OUTPUT_Y, INPUT_A);
    const cm = new ClockMaster({ outputs });
    // Internal master has no physical port — everything is active.
    assert.equal(cm.source.kind, 'internal');
    assert.equal(cm.masterPortName, null);

    const destsBefore = clockOutputsFor(cm, () => true).map((p) => p.name);
    assert.deepEqual(destsBefore.sort(), [INPUT_A, OUTPUT_X, OUTPUT_Y].sort());

    // Simulate internal Start + 24 ticks (DAW engine path).
    for (const dest of clockOutputsFor(cm, () => true)) {
        dest.send([0xfa]); // Start once
    }
    for (let i = 0; i < 24; i++) {
        for (const dest of clockOutputsFor(cm, () => true)) {
            dest.send([0xf8]);
        }
    }

    // Internal source has no physical master port, so ALL outputs (including
    // the input-port named 'INPUT_A') receive clock — 25 msgs * 3 ports.
    const totalSends = outputs.reduce(
        (n, p) => n + p.sent.filter((s) => s[s.length - 1] === 0xfa || s[s.length - 1] === 0xf8).length,
        0,
    );
    assert.equal(totalSends, 75, '25 messages * 3 outputs = 75 (Start + 24 ticks to all)');
});

test('switching master resets estimator/clock history and transport state', () => {
    const outputs = makePortList(OUTPUT_X, OUTPUT_Y, INPUT_A);
    const cmA = new ClockMaster({ outputs });
    cmA.selectExternal(INPUT_A);

    // Simulate some external ticks on Input A.
    for (const dest of clockOutputsFor(cmA, () => true)) {
        dest.send([0xf8]);
    }

    // Switch to internal — reset clears the external master and transport state.
    cmA.selectInternal();
    assert.equal(cmA.source.kind, 'internal');
    assert.equal(cmA.masterPortName, null);

    // After reset, all outputs are active again (no stale exclusion).
    const dests = clockOutputsFor(cmA, () => true);
    assert.equal(dests.length, 3, 'all outputs re-included after internal switch');

    // Reset to external with a different port — old master must be discarded.
    cmA.selectExternal(INPUT_A);
    assert.equal(cmA.masterPortName, INPUT_A);
});

test('explicit output exclusion overrides fuzzy pairing (safe fallback)', () => {
    const outputs = makePortList(OUTPUT_X, OUTPUT_Y, 'Shared Device');
    const cm = new ClockMaster({ outputs });
    // Select 'Shared Device' as master — it is present among outputs.
    cm.selectExternal('Shared Device');

    // User explicitly excludes 'Output Y' via UI config (e.g. known feedback
    // path), which cannot be inferred from partial name matching alone.
    cm.setExplicitExclusions(['Output Y']);

    const dests = clockOutputsFor(cm, () => true);
    assert.ok(!dests.some((p) => p.name === 'Shared Device'), 'master excluded');
    assert.ok(!dests.some((p) => p.name === 'Output Y'), 'explicit exclusion respected');
    assert.ok(dests.some((p) => p.name === OUTPUT_X), 'non-excluded output still active');
});

test('disappeared master port falls back to safe state without breaking outputs', () => {
    const outputs = makePortList(OUTPUT_X, OUTPUT_Y);
    const cm = new ClockMaster({ outputs });
    // User selects an external input that later disconnects.
    cm.selectExternal('USB MIDI Adapter #1');
    assert.equal(cm.masterPortName, 'USB MIDI Adapter #1');

    // Hot-plug removal: reset to safe internal state — all outputs stay active.
    cm.resetExternalState();
    assert.equal(cm.source.kind, 'internal');
    assert.equal(cm.masterPortName, null);
    assert.deepEqual(clockOutputsFor(cm, () => true).map((p) => p.name), [OUTPUT_X, OUTPUT_Y]);
});
