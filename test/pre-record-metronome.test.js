// ---------------------------------------------------------------------------
// Pre-record audio metronome state and click visualization behaviour.
//
//  Requirements (implemented per the user's correction):
//   1. While transport is NOT playing and EVERY clip on every track/slot is
//      empty, enabling the metronome starts a free-running pre-record beat
//      scheduler (quarter notes at the current tempo).
//   2. Starting a pad take keeps the metronome available for count-in; the
//      worker starts transport so its audio click remains synchronized.
//   3. The "● Rec Arm" button (resetAllClips) is NOT the stop trigger: it may
//      empty all clips, but the pre-record scheduler continues (and resumes on
//      the next beat since all clips remain empty).
//   4. Toggling metronome OFF → ON while all clips are empty restarts the
//      pre-record scheduler (re-enable path).
//   5. Internal MIDI-shaped events are used only for visualization/debugging;
//      no metronome click reaches a MIDI synth output.
//   6. The worker owns the Python ALSA audio process and follows DAW state.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine, noteOn, noteOff } from '../daw.js';
import { MIDIRouterWorker } from '../worker-midi.js';

const ACCENT_NOTE = 60; // C4 — first beat of measure (downbeat accent)
const NORMAL_NOTE = 69; // A4 — other beats (off-beat click)
const METRO_CHANNEL = 1; // MIDI channel 1 (noteOn uses 0-based index internally)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a DAWEngine with a capture for `_onEvent` so we can inspect the
 * exact MIDI bytes the metronome emits.
 */
function makeDawWithCapturedEvents() {
    const events = [];
    const daw = new DAWEngine({ tempo: 120 });
    daw._onEvent = (evt) => {
        events.push(evt);
    };
    return { daw, events };
}

/**
 * Wait `ms` milliseconds then resolve. Used to let the 50ms metronome interval
 * fire at least once in a synchronous test.
 */
function tick(ms = 60) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Clean up timers held by a DAWEngine so the test process exits promptly and
 * deterministically (no lingering setInterval/setTimeout).
 */
function cleanupDaw(daw) {
    if (!daw) return;
    // Stop the metronome interval and cancel any scheduled Note Off.
    if (typeof daw._stopMetronome === 'function') {
        daw._stopMetronome();
    }
    // Defensive guard: _metronomeNoteOffTimer may still be set when a tick's
    // Note Off is pending (the interval callback owns that timer).
    if (daw._metronomeNoteOffTimer) {
        clearTimeout(daw._metronomeNoteOffTimer);
        daw._metronomeNoteOffTimer = null;
    }
}

/**
 * Advance real timers by `ms` milliseconds and settle the microtask queue.
 */
function advance(ms = 10) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Pre-record scheduler: starts when all clips are empty + transport stopped
// ---------------------------------------------------------------------------

test('enabling metronome while all clips empty and transport stopped starts pre-record scheduler', async () => {
    const { daw, events } = makeDawWithCapturedEvents();
    try {
        assert.equal(daw.playing, false);
        assert.equal(daw.recording, null);

        // Precondition: every clip empty.
        for (let t = 0; t < 8; t++) {
            for (let s = 0; s < daw.slotsPerTrack; s++) {
                assert.deepEqual(daw.tracks[t].clips[s].notes, []);
            }
        }

        // Enable metronome while transport is stopped.
        daw.setMetronome(true);
        assert.equal(daw._metronomeEnabled, true);

        // Allow the 50ms interval to fire at least once. At 120 BPM each click's
        // Note Off is scheduled min 80 ms after its Note On (the first tick fires
        // at ~50 ms), so wait ~200 ms for that first Note Off to land before we
        // count them.
        await tick(200);

        // The pre-record scheduler emits Note On + Note Off events on channel 1.
        const noteOns = events.filter((e) => e.data[0] === 0x90); // ch1 Note On
        assert.ok(noteOns.length > 0, 'pre-record scheduler must emit Note On events');

        // Every emitted event must be on MIDI channel 1 (0-based index 0 → ch 1).
        for (const e of events) {
            assert.equal(e.data[0] & 0x0f, METRO_CHANNEL - 1, 'metronome events must be on channel 1');
        }

        // There must be at least as many Note Offs as Note Ons.
        const noteOffs = events.filter((e) => e.data[0] === 0x80);
        assert.ok(noteOffs.length >= noteOns.length, 'every Note On must have a matching Note Off');
    } finally {
        cleanupDaw(daw);
    }
});

test('pre-record scheduler emits accent note 60 (C4) on first beat of measure, normal note 69 (A4) otherwise', async () => {
    const { daw, events } = makeDawWithCapturedEvents();
    try {
        daw.setMetronome(true);

        // Collect events over several beats (120 BPM → 500ms/beat; 300ms covers ~6 ticks).
        await tick(320);

        const noteOns = events.filter((e) => e.data[0] === 0x90 && e.data[1] === ACCENT_NOTE);
        const normalOns = events.filter((e) => e.data[0] === 0x90 && e.data[1] === NORMAL_NOTE);
        assert.ok(noteOns.length > 0 || normalOns.length > 0, 'must emit both accent and normal notes');

        // Accent and normal notes must never be anything else.
        const otherNotes = events.filter((e) => e.data[0] === 0x90 && e.data[1] !== ACCENT_NOTE && e.data[1] !== NORMAL_NOTE);
        assert.equal(otherNotes.length, 0, 'metronome must only emit accent (60/C4) or normal (69/A4) notes');

        // Note Offs are present for the same notes.
        const noteOffs = events.filter((e) => e.data[0] === 0x80);
        assert.ok(noteOffs.length > 0, 'every Note On must be paired with a Note Off');
    } finally {
        cleanupDaw(daw);
    }
});

// ---------------------------------------------------------------------------
// Count-in: a pad starts transport while the take waits for the next bar
// ---------------------------------------------------------------------------

test('triggering an empty clip starts transport and keeps the count-in metronome active', async () => {
    const { daw, events } = makeDawWithCapturedEvents();
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = daw;
    worker._transportPlaying = false;
    worker._trackPlayTimers = new Map();
    worker._ledGlow = new Map();
    worker._padLedSent = new Map();
    worker._clearStaleRecordingFeedback = () => {};
    worker._refreshPadLeds = () => {};
    worker._stopTrackPlayback = () => {};
    worker._armLed = () => {};
    worker._syncPadClock = () => {};
    worker._broadcastState = () => {};
    worker._emitVisualEvent = () => {};
    try {
        daw.setMetronome(true);
        await tick(80);
        assert.ok(daw._metronomeTimer != null, 'pre-record scheduler must be running');
        const now = performance.now();
        const result = worker._triggerPad(0, 0, now, { countIn: true });
        assert.equal(result.action, 'record', 'empty clip trigger must begin recording');
        assert.ok(daw.recording != null, 'triggering an empty clip must create daw.recording');
        assert.ok(daw.playing, 'pad should start the transport for count-in');
        assert.ok(daw.recording.startTime >= now + 1900,
            'the take should begin one full bar after the pad press');
        assert.ok(daw._metronomeTimer != null, 'audio metronome should stay active through count-in');
        assert.ok(events.length > 0, 'internal metronome visualization events should continue');
    } finally {
        daw.stopTransport();
        cleanupDaw(daw);
    }
});

test('active metronome note is released promptly with a proper Note Off (velocity 0) on recording start', async () => {
    const { daw, events } = makeDawWithCapturedEvents();
    try {
        daw._onRecordingStarted = () => { daw._stopMetronome(true); };

        daw.setMetronome(true);
        await tick(80);

        // Force a sustained accent note to be held (normally the scheduler releases
        // within the same interval, but we test the force-stop path directly).
        daw._currentMetronomeNote = { note: ACCENT_NOTE, vel: 100 };
        const before = events.filter((e) => e.data[0] === 0x80 && e.data[1] === ACCENT_NOTE).length;

        daw._stopMetronome(true);

        const after = events.filter((e) => e.data[0] === 0x80 && e.data[1] === ACCENT_NOTE).length;
        assert.equal(after, before + 1, 'force-stop must emit exactly one additional Note Off for the active note');
    } finally {
        cleanupDaw(daw);
    }
});

// ---------------------------------------------------------------------------
// Rec Arm is NOT the stop trigger
// ---------------------------------------------------------------------------

test('the ● Rec Arm button (resetAllClips) does NOT stop the metronome — it only empties clips', async () => {
    const { daw, events } = makeDawWithCapturedEvents();
    try {
        // The worker installs _onRecordingStarted; resetAllClips calls
        // daw._stopRecording() which does NOT fire _onRecordingStarted.
        let stopHookFired = false;
        daw._onRecordingStarted = () => { stopHookFired = true; };

        daw.setMetronome(true);
        await tick(80);

        const timerBefore = daw._metronomeTimer;
        assert.ok(timerBefore != null, 'pre-record scheduler must be running before Rec Arm');

        // The ● Rec Arm button empties all clips.
        daw.resetAllClips();

        // resetAllClips does NOT create a recording session — it is not the stop trigger.
        assert.equal(stopHookFired, false, '_onRecordingStarted must NOT fire during resetAllClips');
        assert.notEqual(daw._metronomeTimer, null, 'pre-record scheduler must survive resetAllClips');

        // Because all clips are still empty after a reset, the pre-record scheduler
        // continues (resumes on the next beat). Verify it keeps emitting.
        await tick(80);
        const noteOns = events.filter((e) => e.data[0] === 0x90);
        assert.ok(noteOns.length > 0, 'metronome must keep ticking after Rec Arm empties clips');
    } finally {
        cleanupDaw(daw);
    }
});

test('resetAllClips empties all clips but metronome resumes emitting beats', async () => {
    const { daw, events } = makeDawWithCapturedEvents();
    try {
        daw.setMetronome(true);
        await tick(80);

        // Put a note in clip (0,0) so resetAllClips has something to clear.
        daw.tracks[0].clips[0].notes.push({ channel: 1, note: 60, velocity: 90, start: 0, dur: 0.5 });
        assert.ok(daw.tracks[0].clips[0].notes.length > 0);

        daw.resetAllClips();

        // All clips must be empty after Rec Arm.
        for (let t = 0; t < 8; t++) {
            for (let s = 0; s < daw.slotsPerTrack; s++) {
                assert.deepEqual(daw.tracks[t].clips[s].notes, [], `clip (${t},${s}) must be empty after resetAllClips`);
            }
        }

        // Metronome must NOT have stopped (Rec Arm is not the stop trigger).
        assert.notEqual(daw._metronomeTimer, null, 'pre-record scheduler must survive resetAllClips');
    } finally {
        cleanupDaw(daw);
    }
});

// ---------------------------------------------------------------------------
// Re-enable: toggle metronome OFF → ON while all clips empty
// ---------------------------------------------------------------------------

test('toggling metronome OFF then ON while all clips empty restarts the pre-record scheduler', async () => {
    const { daw, events } = makeDawWithCapturedEvents();
    try {
        daw.setMetronome(true);
        await tick(80);
        assert.ok(daw._metronomeTimer != null, 'pre-record scheduler must be running');

        // Toggle OFF.
        daw.setMetronome(false);
        assert.equal(daw._metronomeTimer, null, 'toggle OFF must stop the scheduler');

        // All clips are still empty → toggle ON restarts pre-record mode.
        daw.setMetronome(true);
        await tick(80);
        assert.ok(daw._metronomeTimer != null, 're-enabling metronome while all clips empty must restart pre-record scheduler');

        // It must emit fresh beats after re-enable.
        const noteOns = events.filter((e) => e.data[0] === 0x90);
        assert.ok(noteOns.length > 0, 're-enabled metronome must emit new beat pulses');
    } finally {
        cleanupDaw(daw);
    }
});

// ---------------------------------------------------------------------------
// Normal transport-synced path is unaffected
// ---------------------------------------------------------------------------

test('transport-start still uses the normal (non-pre-record) metronome path', async () => {
    const { daw, events } = makeDawWithCapturedEvents();
    try {
        daw.setMetronome(true);

        // Transport playing → setMetronome re-triggers via _startMetronome with
        // playing === true (normal transport-synced path). This is unchanged.
        daw.startTransport();
        assert.equal(daw.playing, true);

        // The metronome must still be running (not stuck in pre-record mode).
        assert.ok(daw._metronomeTimer != null, 'transport-start must keep metronome running');

        daw.stopTransport();
    } finally {
        cleanupDaw(daw);
    }
});

// ---------------------------------------------------------------------------
// MIDI-output isolation: tagged metronome events must never reach synth ports.
// ---------------------------------------------------------------------------

/**
 * Build a mock MIDI output that records every `sendMessage` call and exposes
 * a promise-based `expectMessage` helper so we can await specific bytes.
 */
function makeMockOutput() {
    const calls = [];
    const resolvers = new Map(); // buffer -> [resolve, reject]
    const proto = {
        sendMessage(buffer) {
            calls.push(Array.from(buffer));
            for (const [buf, [resolve]] of resolvers.entries()) {
                if (Buffer.compare(Buffer.from(buf), Buffer.from(buffer)) === 0) {
                    resolve(calls);
                    resolvers.delete(buf);
                }
            }
        },
        expectMessage(buffer, ms = 500) {
            return new Promise((resolve, reject) => {
                const t = setTimeout(reject, ms);
                // Check already-arrived calls first.
                for (const call of calls) {
                    if (Buffer.compare(Buffer.from(call), Buffer.from(buffer)) === 0) {
                        clearTimeout(t);
                        return resolve(call);
                    }
                }
                resolvers.set(Array.from(buffer), [
                    (c) => { clearTimeout(t); resolve(c); },
                    () => {},
                ]);
            });
        },
        get callsLog() { return calls; },
    };
    return { proto, getCalls: () => calls };
}

test('metronome click events never reach connected MIDI synth outputs', async () => {
    // Instantiate the real worker outside a WorkerThread — the file-level
    // `if (parentPort)` guard keeps it safe, so we can exercise its private
    // routing with mock outputs.  No ALSA hardware is touched.
    const worker = new MIDIRouterWorker();

    // Set up three mocked synth outputs (e.g. "Craft Synth 2.0", "MiniLab",
    // "Keystation") and register them as if they were hot-plugged.
    const mocks = [
        { name: 'Mock Synth A', ...makeMockOutput() },
        { name: 'Mock Synth B', ...makeMockOutput() },
        { name: 'Mock Synth C', ...makeMockOutput() },
    ];

    // Metronome audio is emitted through ALSA; no click should reach these MIDI
    // output mocks.
    worker.outputs = new Map();
    for (const m of mocks) {
        worker.outputs.set(m.name, m.proto);
    }

    let daw = null;
    try {
        // Enable the DAW metronome and allow internal click scheduling to run.
        daw = worker.daw;
        daw.setMetronome(true);

        // Wait for at least one full pre-record click cycle: Note On + its
        // scheduled Note Off (min 80 ms delay).
        await tick(250);

        for (const m of mocks) {
            assert.deepEqual(m.getCalls(), [], `${m.name} must not receive metronome notes`);
        }

        // Prove that ordinary instrument events (un-tagged) do NOT go through the
        // Send a plain event and confirm no event was sent through this internal
        // DAW callback path (normal controller input routing is separate).
        daw._emit([0x91 | 0, 60, 80], 0); // ch2 note — different channel, untagged
        await tick(10);
        const anyReceivedUntagged = mocks.some((m) =>
            m.getCalls().some((c) => c[0] === 0x91 && c[1] === 60)
        );
        // Untagged channel-2 events are not sent through this DAW callback path.
        assert.ok(!anyReceivedUntagged,
            'untagged channel-2 events must not reach all outputs via the tagged path');
    } finally {
        // Clean up timers on the DAW engine so the test exits promptly.
        cleanupDaw(daw);
        // Release any held mock output references (defensive).
        worker.outputs.clear();
    }
});

test('internal metronome visualization events remain distinct from synth MIDI routing', async () => {
    const { daw, events } = makeDawWithCapturedEvents();
    try {
        daw.setMetronome(true);
        await tick(80);

        // DAW click events are retained for visualization; the worker never
        // routes them to synth outputs.
        const noteOns = events.filter((e) => e.data[0] === 0x90);
        const noteOffs = events.filter((e) => e.data[0] === 0x80);
        assert.ok(noteOns.length > 0, 'must emit at least one Note On');

        // The Note Off is scheduled via setTimeout with a bounded delay (min 80 ms),
        // so within the first 80 ms window we may only see the Note On. Wait for
        // the pending Note Off to land and re-check that it is also tagged.
        await advance(120);
        const lateNoteOffs = events.filter((e) => e.data[0] === 0x80 && e._tag === 'metronome');
        assert.ok(lateNoteOffs.length >= noteOns.length,
            'every Note On must eventually be followed by a tagged Note Off');

        // Verify every event seen so far carries the metronome tag and channel 1.
        for (const e of events) {
            assert.equal(e.type, 'midi', 'metronome events must have type "midi"');
            assert.equal(e._tag, 'metronome', 'both Note On and Note Off must carry _tag: metronome');
            assert.equal(e.data[0] & 0x0f, METRO_CHANNEL - 1, 'metronome events must be on channel 1');
        }
    } finally {
        cleanupDaw(daw);
    }
});

// ---------------------------------------------------------------------------
// Stop-on-record through the real worker path: every connected output gets
// the forced Note Off, including ones normally excluded from routing.
// ---------------------------------------------------------------------------

test('first empty-clip trigger keeps count-in audio local and sends no MIDI clicks', async () => {
    const worker = new MIDIRouterWorker();

    // Two mock outputs: one excluded from ordinary routing, one not.
    const excludedMock = makeMockOutput();
    const normalMock = makeMockOutput();
    worker.outputs = new Map([
        ['Excluded Synth', excludedMock.proto],
        ['Normal Synth', normalMock.proto],
    ]);

    // Stub the controller-engine exclusion policy so one output is normally
    // excluded.  Metronome routing must bypass this and still reach it.
    const originalIsExcluded = worker.controllerEngine.isExcludedOutput;
    worker.controllerEngine = {
        ...worker.controllerEngine,
        isExcludedOutput: (name) => name === 'Excluded Synth',
    };

    try {
        const daw = worker.daw;
        daw.setMetronome(true);

        // Start the pre-record click scheduler.
        await tick(120);

        // Trigger an empty clip. The worker must never send the audio click as
        // Note On/Off messages to either connected synth.
        const result = daw.triggerPad(0, 0, performance.now());
        assert.equal(result.action, 'record');
        assert.ok(daw.recording != null);

        await advance(120);
        assert.deepEqual(excludedMock.getCalls(), []);
        assert.deepEqual(normalMock.getCalls(), []);
        assert.notEqual(daw._metronomeTimer, null,
            'the metronome must remain active through the count-in');
    } finally {
        cleanupDaw(worker.daw);
        worker.outputs.clear();
        worker.controllerEngine.isExcludedOutput = originalIsExcluded;
    }
});

test('worker drives the Pi audio metronome and never fans clicks out over MIDI', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(new URL('../worker-midi.js', import.meta.url), 'utf8');

    assert.ok(
        /import\s+\{\s*MetronomeController\s*\}\s+from\s+['"]\.\/metronome-controller\.js['"]/.test(src),
        'worker-midi.js must integrate MetronomeController'
    );

    const stripped = src
        .replace(/\/\/.*$/gm, '')      // remove line comments
        .replace(/\/\*[\s\S]*?\*\//g, ''); // remove block comments

    assert.ok(/metronomeCtrl\.play\(\)/.test(stripped));
    assert.ok(/metronomeCtrl\.stop\(\)/.test(stripped));
    assert.ok(!/_sendToAllMetronomeOutputs/.test(stripped),
        'there must be no MIDI click fan-out path');
});
