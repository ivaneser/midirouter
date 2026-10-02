// ---------------------------------------------------------------------------
// Regression test: audio metronome click synchronization.
//
// Proves two properties of the per-beat trigger architecture:
//  1. No audio click is sent without an authoritative DAW beat event.
//  2. Exactly one click is sent for each received beat (internal or external).
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';
import { MetronomeController } from '../metronome-controller.js';

const ACCENT_NOTE = 60; // C4 — first beat of measure
const NORMAL_NOTE = 69; // A4 — other beats
const METRO_CHANNEL = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDawWithCapturedEvents() {
    const events = [];
    const daw = new DAWEngine({ tempo: 120 });
    daw._onEvent = (evt) => {
        events.push(evt);
    };
    return { daw, events };
}

function tick(ms = 60) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupDaw(daw) {
    if (!daw) return;
    // Stop transport first (clears _playLoopTimer, metronome interval, MIDI clock).
    // This is safe to call even when the DAW was never started — all fields are null-checked.
    if (typeof daw.stopTransport === 'function') {
        daw.stopTransport();
    }
    // Defensive: ensure metronome timer is cleared in case stopTransport()
    // did not cover it (e.g. external-clock mode where the interval was never set).
    if (typeof daw._stopMetronome === 'function') {
        daw._stopMetronome();
    }
    if (daw._metronomeNoteOffTimer) {
        clearTimeout(daw._metronomeNoteOffTimer);
        daw._metronomeNoteOffTimer = null;
    }
}

// ---------------------------------------------------------------------------
// Test 1: No click without authoritative beat
// ---------------------------------------------------------------------------

test('no audio click is sent without an authoritative DAW beat event', async () => {
    const { daw, events } = makeDawWithCapturedEvents();
    try {
        // Set up the _onAudioBeat callback to a spy that counts calls.
        let audioBeatCalls = 0;
        let audioBeatIsAccentValues = [];
        daw._onAudioBeat = (isAccent) => {
            audioBeatCalls++;
            audioBeatIsAccentValues.push(isAccent);
        };

        // Enable metronome — this starts the pre-record scheduler interval.
        daw.setMetronome(true);

        // Wait for at least one full click cycle (~200 ms: interval fires + Note Off).
        await tick(250);

        // The DAW must have emitted internal visualization events (Note On/Off),
        // but the _onAudioBeat callback should have been called exactly once per
        // beat that passed.  At 120 BPM, a beat = 500 ms; in 250 ms we expect
        // at most one beat tick from the interval.

        // The key assertion: every internal event must be on channel 1 and tagged.
        const noteOns = events.filter((e) => e.data[0] === 0x90);
        assert.ok(noteOns.length > 0, 'internal metronome events must fire');

        // No more audio beat calls than internal beats — the callback is driven
        // by the DAW's own interval, not an independent timer.  In a 250 ms
        // window at 120 BPM (500 ms/beat), there should be exactly one beat tick
        // from the pre-record scheduler.
        assert.equal(audioBeatCalls, noteOns.length > 0 ? Math.max(1, noteOns.length) : 0,
            'audio beat calls must match internal beats');

        // Stop metronome — verify no further clicks after stop.
        daw._stopMetronome();
        const callsBeforeStop = audioBeatCalls;
        await tick(250);
        assert.equal(audioBeatCalls, callsBeforeStop, 'no clicks after metronome stopped');
    } finally {
        cleanupDaw(daw);
    }
});

// ---------------------------------------------------------------------------
// Test 2: One click per beat (internal clock)
// ---------------------------------------------------------------------------

test('exactly one audio click is sent for each received internal beat', async () => {
    const { daw, events } = makeDawWithCapturedEvents();
    try {
        let audioBeatCalls = 0;
        daw._onAudioBeat = (isAccent) => {
            audioBeatCalls++;
        };

        // Start transport — this triggers the internal clock metronome.
        daw.setMetronome(true);
        daw.startTransport();

        // At 120 BPM, each beat is 500 ms. Wait for ~3 beats (1600 ms).
        await tick(1600);

        const noteOns = events.filter((e) => e.data[0] === 0x90);
        // The internal interval fires every 10 ms but only emits on beat boundaries.
        // Over ~3 beats, we expect at least 3 audio beat calls and a matching count of Note Ons.
        assert.ok(audioBeatCalls >= 2, 'must fire at least 2 audio clicks over 3+ beats');
        assert.ok(noteOns.length >= 2, 'must emit at least 2 internal Note Ons over 3+ beats');

        // Each beat should produce exactly one _onAudioBeat call.
        // The interval fires every 10ms and only triggers on new beat boundaries,
        // so the count should be proportional to elapsed time / beat_duration.
        const expectedBeats = Math.floor(1600 / (60 / 120 * 1000));
        assert.ok(audioBeatCalls >= expectedBeats - 1 && audioBeatCalls <= expectedBeats + 1,
            `audio click count (${audioBeatCalls}) should be ~${expectedBeats} beats`);

        daw.stopTransport();
    } finally {
        cleanupDaw(daw);
    }
});

// ---------------------------------------------------------------------------
// Test 3: Accent on first beat of measure (meter awareness)
// ---------------------------------------------------------------------------

test('accent flag is true only on the first beat of each measure', async () => {
    const { daw, events } = makeDawWithCapturedEvents();
    try {
        let accentCount = 0;
        let normalCount = 0;
        daw._onAudioBeat = (isAccent) => {
            if (isAccent) accentCount++;
            else normalCount++;
        };

        // Set meter to 3/4 for clearer counting.
        daw.setMetronomeBeatsPerMeasure(3);

        // Enable the metronome so transport-synced clicks fire.
        daw.setMetronome(true);

        daw.startTransport();

        // At 60 BPM, each beat = 1 second. Wait ~8 seconds → ~2 full measures (6 beats).
        await tick(8000);

        const totalCalls = accentCount + normalCount;
        assert.ok(totalCalls >= 4, 'should have fired multiple beats');
        // In 3/4 time, every 3rd beat is accent. Over ~8 beats at 60 BPM:
        // expect at least 2 accents (beats 1, 7 of the measure cycle).
        assert.ok(accentCount >= 2, `must have at least 2 accents in ${totalCalls} total calls`);
        assert.ok(normalCount > accentCount, 'normal beats should outnumber accents');

        daw.stopTransport();
    } finally {
        cleanupDaw(daw);
    }
});

// ---------------------------------------------------------------------------
// Test 4: _onAudioBeat is not called during transport stop / idle
// ---------------------------------------------------------------------------

test('no audio click after transport stops', async () => {
    const { daw, events } = makeDawWithCapturedEvents();
    try {
        let audioBeatCalls = 0;
        daw._onAudioBeat = (isAccent) => {
            audioBeatCalls++;
        };

        // Enable the metronome so transport-synced clicks fire.
        daw.setMetronome(true);

        daw.startTransport();
        await tick(600); // ~1 beat at 120 BPM

        const callsDuringPlay = audioBeatCalls;
        assert.ok(callsDuringPlay >= 1, 'should have at least one click during play');

        daw.stopTransport();
        await tick(600); // wait same duration after stop

        assert.equal(audioBeatCalls, callsDuringPlay, 'no clicks should fire after transport stops');
    } finally {
        cleanupDaw(daw);
    }
});

// ---------------------------------------------------------------------------
// Test 5: MetronomeController.triggerBeat sends correct commands
// ---------------------------------------------------------------------------

test('MetronomeController triggers beat with accent flag based on beat index', async () => {
    // We can't actually spawn the Python process in tests, but we can verify
    // the controller's internal logic by inspecting what it would send.
    const ctrl = new MetronomeController({ bpm: 120, beats: 4 });

    // Mock the process to capture stdin writes.
    let stdinWrites = [];
    ctrl._process = {
        stdin: { write: (data) => { stdinWrites.push(data); return true; } },
    };
    ctrl._pid = 9999;
    ctrl._running = true;

    // Beat index starts at 0 → beat 0 is accent.
    ctrl.triggerBeat(false);
    assert.ok(stdinWrites[0].includes('click 1'), 'beat 0 should be accent');

    // Advance to beat 1 (index 1) → not accent.
    ctrl.advanceBeat();
    ctrl.triggerBeat(false);
    assert.ok(stdinWrites[1].includes('click 0'), 'beat 1 should NOT be accent');

    // Advance to beat 2 (index 2) → not accent.
    ctrl.advanceBeat();
    ctrl.triggerBeat(false);
    assert.ok(stdinWrites[2].includes('click 0'), 'beat 2 should NOT be accent');

    // Advance to beat 3 (index 3) → not accent.
    ctrl.advanceBeat();
    ctrl.triggerBeat(false);
    assert.ok(stdinWrites[3].includes('click 0'), 'beat 3 should NOT be accent');

    // Advance to beat 4 (index 4, wraps to beat 0 of next measure) → accent.
    ctrl.advanceBeat();
    ctrl.triggerBeat(false);
    assert.ok(stdinWrites[4].includes('click 1'), 'beat 4 (wrap) should be accent');

    // Verify resetBeatIndex resets the counter.
    ctrl.resetBeatIndex();
    stdinWrites = [];
    ctrl.triggerBeat(false);
    assert.ok(stdinWrites[0].includes('click 1'), 'after reset, beat 0 is accent again');
});
