// ---------------------------------------------------------------------------
// Regression: invalid numeric control inputs (tempo, meter, metronome notes)
// must not corrupt engine state or fire side-effect callbacks.
//
// Contract under test:
//   - setTempo('nope')            -> tempo stays unchanged; MIDI-clock and
//                                     metronome-tempo callbacks NOT invoked
//   - setMetronomeBeatsPerMeasure(null) -> meter stays unchanged; meter cb NOT
//   - setMetronomeNote(NaN)       -> note state unchanged, no side effects
//   - setMetronomeAccentNote('bad')     -> accent note state unchanged
//
// Known defects this locks down (from current daw.js):
//   setTempo: Math.max(20, Math.min(300, 'nope')) === NaN → tempo = NaN;
//             _midiClock.setTempo(NaN) poisons clock bpm;
//             _onMetronomeTempo(NaN) fires with corrupted value.
//   setMetronomeBeatsPerMeasure: Math.max(1, Math.min(16, null)) === 1 →
//             silently clamps meter down from e.g. 4 to 1 and fires the
//             meter callback with the wrong value.
//   setMetronomeNote(NaN): Math.max(0, Math.min(127, NaN)) === NaN →
//             _metronomeNote becomes NaN (poisoned note state).
//   setMetronomeAccentNote('bad'): same pattern → _metronomeAccentNote = NaN.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';

/**
 * Create a DAWEngine with all external side-effect callbacks stubbed so
 * tests can assert whether (and with what arguments) they were invoked.
 */
function makeStubbedDAW(opts = {}) {
    const daw = new DAWEngine(opts);

    const calls = {
        onMetronomeTempo: [],
        onMetronomeMeter: [],
        onMetronomeStart: [],
        onMetronomeStop: [],
        onEvent: [],
    };

    // Stub the metronome tempo callback (fired by setTempo).
    daw._onMetronomeTempo = (...args) => calls.onMetronomeTempo.push(args);
    // Stub the meter callback (fired by setMetronomeBeatsPerMeasure).
    daw._onMetronomeMeter = (...args) => calls.onMetronomeMeter.push(args);
    // Stub start/stop so no timers are created during tests.
    daw._onMetronomeStart = (...args) => calls.onMetronomeStart.push(args);
    daw._onMetronomeStop = () => {};
    // Capture MIDI events (e.g. clock ticks, metronome clicks).
    daw._onEvent = (...args) => calls.onEvent.push(args);

    return { daw, calls };
}

// ===========================================================================
// setTempo — invalid input
// ===========================================================================

test('setTempo with a non-numeric string leaves tempo unchanged and fires no callbacks', () => {
    const { daw, calls } = makeStubbedDAW({ tempo: 120 });

    // Capture the MIDI clock's bpm before the call.
    const clockBpmBefore = daw._midiClock.bpm;

    daw.setTempo('nope');

    // Tempo must remain a finite number and equal the previous value.
    assert.ok(Number.isFinite(daw.tempo),
        `tempo must stay finite after invalid input, got: ${daw.tempo}`);
    assert.equal(daw.tempo, 120,
        'tempo must be unchanged by invalid input');

    // MIDI clock bpm must not have been poisoned.
    assert.ok(Number.isFinite(daw._midiClock.bpm),
        `MIDI clock bpm must stay finite, got: ${daw._midiClock.bpm}`);
    assert.equal(daw._midiClock.bpm, clockBpmBefore,
        'MIDI clock bpm must be unchanged by invalid setTempo');

    // The metronome-tempo callback must NOT have been invoked.
    assert.equal(calls.onMetronomeTempo.length, 0,
        '_onMetronomeTempo must not fire for invalid tempo input');
});

test('setTempo with null leaves tempo unchanged and fires no callbacks', () => {
    const { daw, calls } = makeStubbedDAW({ tempo: 120 });

    const clockBpmBefore = daw._midiClock.bpm;

    daw.setTempo(null);

    assert.ok(Number.isFinite(daw.tempo),
        `tempo must stay finite after null input, got: ${daw.tempo}`);
    assert.equal(daw.tempo, 120,
        'tempo must be unchanged by null input');
    assert.equal(daw._midiClock.bpm, clockBpmBefore,
        'MIDI clock bpm must be unchanged by null setTempo');
    assert.equal(calls.onMetronomeTempo.length, 0,
        '_onMetronomeTempo must not fire for null tempo input');
});

test('setTempo with NaN leaves tempo unchanged and fires no callbacks', () => {
    const { daw, calls } = makeStubbedDAW({ tempo: 120 });

    const clockBpmBefore = daw._midiClock.bpm;

    daw.setTempo(NaN);

    assert.ok(Number.isFinite(daw.tempo),
        `tempo must stay finite after NaN input, got: ${daw.tempo}`);
    assert.equal(daw.tempo, 120,
        'tempo must be unchanged by NaN input');
    assert.equal(daw._midiClock.bpm, clockBpmBefore,
        'MIDI clock bpm must be unchanged by NaN setTempo');
    assert.equal(calls.onMetronomeTempo.length, 0,
        '_onMetronomeTempo must not fire for NaN tempo input');
});

// ===========================================================================
// setMetronomeBeatsPerMeasure — invalid input
// ===========================================================================

test('setMetronomeBeatsPerMeasure with null leaves meter unchanged and fires no callback', () => {
    const { daw, calls } = makeStubbedDAW({ tempo: 120 });
    // Default meter is 4; set it explicitly for clarity.
    daw._metronomeBeatsPerMeasure = 4;

    daw.setMetronomeBeatsPerMeasure(null);

    assert.ok(Number.isInteger(daw._metronomeBeatsPerMeasure),
        `meter must stay an integer after null input, got: ${daw._metronomeBeatsPerMeasure}`);
    assert.equal(daw._metronomeBeatsPerMeasure, 4,
        'meter must be unchanged by null input');
    assert.equal(calls.onMetronomeMeter.length, 0,
        '_onMetronomeMeter must not fire for invalid meter input');
});

test('setMetronomeBeatsPerMeasure with a non-numeric string leaves meter unchanged and fires no callback', () => {
    const { daw, calls } = makeStubbedDAW({ tempo: 120 });
    daw._metronomeBeatsPerMeasure = 4;

    daw.setMetronomeBeatsPerMeasure('bad');

    assert.ok(Number.isInteger(daw._metronomeBeatsPerMeasure),
        `meter must stay an integer after string input, got: ${daw._metronomeBeatsPerMeasure}`);
    assert.equal(daw._metronomeBeatsPerMeasure, 4,
        'meter must be unchanged by invalid string input');
    assert.equal(calls.onMetronomeMeter.length, 0,
        '_onMetronomeMeter must not fire for invalid meter input');
});

test('setMetronomeBeatsPerMeasure with NaN leaves meter unchanged and fires no callback', () => {
    const { daw, calls } = makeStubbedDAW({ tempo: 120 });
    daw._metronomeBeatsPerMeasure = 4;

    daw.setMetronomeBeatsPerMeasure(NaN);

    assert.ok(Number.isInteger(daw._metronomeBeatsPerMeasure),
        `meter must stay an integer after NaN input, got: ${daw._metronomeBeatsPerMeasure}`);
    assert.equal(daw._metronomeBeatsPerMeasure, 4,
        'meter must be unchanged by NaN input');
    assert.equal(calls.onMetronomeMeter.length, 0,
        '_onMetronomeMeter must not fire for NaN meter input');
});

// ===========================================================================
// setMetronomeNote — invalid input
// ===========================================================================

test('setMetronomeNote with NaN leaves note state unchanged', () => {
    const { daw } = makeStubbedDAW({ tempo: 120 });
    // Default metronome note is 57 (A3).
    const expectedNote = 57;
    assert.equal(daw._metronomeNote, expectedNote, 'precondition: default note is 57');

    daw.setMetronomeNote(NaN);

    assert.ok(Number.isFinite(daw._metronomeNote),
        `metronome note must stay finite after NaN input, got: ${daw._metronomeNote}`);
    assert.equal(daw._metronomeNote, expectedNote,
        'metronome note must be unchanged by NaN input');
});

test('setMetronomeNote with a non-numeric string leaves note state unchanged', () => {
    const { daw } = makeStubbedDAW({ tempo: 120 });
    const expectedNote = 57;

    daw.setMetronomeNote('bad');

    assert.ok(Number.isFinite(daw._metronomeNote),
        `metronome note must stay finite after string input, got: ${daw._metronomeNote}`);
    assert.equal(daw._metronomeNote, expectedNote,
        'metronome note must be unchanged by invalid string input');
});

test('setMetronomeNote with null leaves note state unchanged', () => {
    const { daw } = makeStubbedDAW({ tempo: 120 });
    const expectedNote = 57;

    daw.setMetronomeNote(null);

    assert.ok(Number.isFinite(daw._metronomeNote),
        `metronome note must stay finite after null input, got: ${daw._metronomeNote}`);
    assert.equal(daw._metronomeNote, expectedNote,
        'metronome note must be unchanged by null input');
});

// ===========================================================================
// setMetronomeAccentNote — invalid input
// ===========================================================================

test('setMetronomeAccentNote with a non-numeric string leaves accent note state unchanged', () => {
    const { daw } = makeStubbedDAW({ tempo: 120 });
    // Default accent note is 60 (C4).
    const expectedAccent = 60;
    assert.equal(daw._metronomeAccentNote, expectedAccent, 'precondition: default accent is 60');

    daw.setMetronomeAccentNote('bad');

    assert.ok(Number.isFinite(daw._metronomeAccentNote),
        `accent note must stay finite after string input, got: ${daw._metronomeAccentNote}`);
    assert.equal(daw._metronomeAccentNote, expectedAccent,
        'accent note must be unchanged by invalid string input');
});

test('setMetronomeAccentNote with NaN leaves accent note state unchanged', () => {
    const { daw } = makeStubbedDAW({ tempo: 120 });
    const expectedAccent = 60;

    daw.setMetronomeAccentNote(NaN);

    assert.ok(Number.isFinite(daw._metronomeAccentNote),
        `accent note must stay finite after NaN input, got: ${daw._metronomeAccentNote}`);
    assert.equal(daw._metronomeAccentNote, expectedAccent,
        'accent note must be unchanged by NaN input');
});

test('setMetronomeAccentNote with null leaves accent note state unchanged', () => {
    const { daw } = makeStubbedDAW({ tempo: 120 });
    const expectedAccent = 60;

    daw.setMetronomeAccentNote(null);

    assert.ok(Number.isFinite(daw._metronomeAccentNote),
        `accent note must stay finite after null input, got: ${daw._metronomeAccentNote}`);
    assert.equal(daw._metronomeAccentNote, expectedAccent,
        'accent note must be unchanged by null input');
});
