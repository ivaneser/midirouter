// ---------------------------------------------------------------------------
// Regression tests written in RED before the production fix (TDD).
//
// 1. Launchkey Mini MK3 `recording` feedback must be flashing red bytes, not
//    static red.  The official Focusrite Launchkey MK3 Programmer's Reference
//    states:
//      - 0x9N = note on (static LED), 0x9N with channel 2 status 0x91 = flashing
//      - velocity 5 = Red
//    So `recording` must emit [145, $number, 5] (0x91 = flashing red), not
//    [144, $number, 5] (0x90 = static red).  This test fails against the
//    current profile until it is corrected.
//
// 2. Selected clock master fanout: when Launchkey Mini MK3 DAW Port is a slave
//    clock destination (its midiClockOutput matcher matches), every F8/FA/FB/FC
//    from the selected master must reach it — and the master port itself must
//    never receive its own clock back.  The current `_sendMidiClockOutputs`
//    applies `isExcludedOutput` blindly, which blocks Launchkey even though
//    `midiClockOutput` explicitly whitelists it as a clock destination.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { ControllerEngine } from '../controller-engine.js';
import { ClockMaster, clockOutputsFor } from '../clock-master.js';

const DEFAULT_OUTPUTS = ['Craft Synth 2.0 MIDI 1', 'Launchkey Mini MK3 DAW Port'];

// ---- helpers ---------------------------------------------------------------

function makePortList(...names) {
    return names.map((n) => ({ name: n, sent /** :number[][] */: [], send(buf) { this.sent.push(Array.from(buf)); } }));
}

// ---------------------------------------------------------------------------
// Test 1 — recording feedback must be flashing red bytes.
// ---------------------------------------------------------------------------

test('Launchkey `recording` feedback emits flashing red (0x91), not static red (0x90)', () => {
    const engine = ControllerEngine.fromDirectory('./controller_profiles');
    // We expect the Launchkey Mini MK3 profile to be loaded and active.
    assert.ok(engine.profileForInput('Launchkey Mini MK3 DAW Port'), 'launchkey-mini-mk3 profile must be loaded');

    // `feedbackMessagesFor` returns normalized LED byte arrays for a pad/track/slot/state.
    const msgs = engine.feedbackMessagesFor('Launchkey Mini MK3 DAW Port', 0, 0, 'recording');
    assert.ok(msgs.length > 0, 'recording state must produce feedback bytes');

    // The recording byte must be a flashing note-on (0x91 = channel 2 LED flash),
    // not a static note-on (0x90). Per the programmer's reference:
    // status 0x9N/channel 2 -> flashing; velocity 5 -> Red.
    const firstByte = msgs[0][0];
    assert.equal(firstByte, 0x91, 'recording feedback must start with 0x91 (flashing note-on), not 0x90 (static)');

    // Velocity must be 5 = Red.
    assert.equal(msgs[0][2], 5, 'recording velocity must be 5 (Red per the programmer reference)');
});

test('Launchkey `playing` feedback stays flashing green (0x91 channel 2, velocity 37)', () => {
    const engine = ControllerEngine.fromDirectory('./controller_profiles');
    const msgs = engine.feedbackMessagesFor('Launchkey Mini MK3 DAW Port', 0, 0, 'playing');
    assert.ok(msgs.length > 0, 'playing state must produce feedback bytes');

    // playing should already be the flashing green status byte (0x91).
    assert.equal(msgs[0][0], 0x91, 'playing feedback must use 0x91 (flashing)');
    assert.equal(msgs[0][2], 37, 'playing velocity must be 37 (Green per the programmer reference)');
});

// ---------------------------------------------------------------------------
// Test 2 — selected clock fanout includes midiClockOutput ports and excludes master.
// ---------------------------------------------------------------------------

test('clock fanout reaches Launchkey DAW port via midiClockOutput even though excludeOutputs blocks notes', () => {
    const engine = ControllerEngine.fromDirectory('./controller_profiles');
    assert.ok(engine.profileForInput('Launchkey Mini MK3 DAW Port'));

    // Confirm the policy split exists in this profile:
    //   - excludeOutputs matches Launchkey (blocks note/synth routing)
    //   - midiClockOutput matches Launchkey (whitelists clock routing)
    assert.equal(engine.isExcludedOutput('Launchkey Mini MK3 DAW Port'), true, 'Launchkey is excluded from ordinary output routing');
    assert.equal(engine.isMidiClockOutput('Launchkey Mini MK3 DAW Port'), true, 'Launchkey is whitelisted for MIDI clock output');

    const outputs = makePortList(...DEFAULT_OUTPUTS);
    const cm = new ClockMaster({ outputs });
    // Internal master: every candidate output should be reachable.
    cm.selectInternal();

    // The production predicate used in _sendMidiClockOutputs must let the
    // midiClockOutput-whitelisted Launchkey port through despite excludeOutputs.
    const dests = clockOutputsFor(cm, (port) => {
        return engine.isAllowedClockDestination(port.name);
    });

    // GREEN: `isAllowedClockDestination` lets the midiClockOutput-whitelisted
    // Launchkey DAW port through as a clock destination even though
    // excludeOutputs blocks it for ordinary note routing.
    assert.ok(dests.some((p) => p.name === 'Launchkey Mini MK3 DAW Port'), 'Launchkey DAW port must be a clock destination via midiClockOutput');
});

test('selected master port never receives its own clock back (master loop exclusion)', () => {
    const outputs = makePortList(...DEFAULT_OUTPUTS);
    const cm = new ClockMaster({ outputs });
    // Select the Launchkey DAW port as the external master.
    cm.selectExternal('Launchkey Mini MK3 DAW Port');

    const dests = clockOutputsFor(cm, () => true);
    assert.ok(!dests.some((p) => p.name === 'Launchkey Mini MK3 DAW Port'), 'master port must be excluded from fanout');

    // Simulate one F8 tick to every destination.
    for (const dest of dests) { dest.send([0xf8]); }

    const masterPort = outputs.find((p) => p.name === 'Launchkey Mini MK3 DAW Port');
    assert.equal(masterPort.sent.length, 0, 'master port must receive zero clock ticks — no feedback loop');

    // Craft Synth (non-master) receives exactly one copy.
    const synth = outputs.find((p) => p.name === 'Craft Synth 2.0 MIDI 1');
    assert.equal(synth.sent.length, 1, 'non-master output gets exactly one F8');
});