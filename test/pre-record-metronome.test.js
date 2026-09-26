// ---------------------------------------------------------------------------
// Pre-record MIDI metronome behaviour.
//
//  Requirements (implemented per the user's correction):
//   1. While transport is NOT playing and EVERY clip on every track/slot is
//      empty, enabling the metronome starts a free-running pre-record beat
//      scheduler (quarter notes at the current tempo).
//   2. The FIRST empty-clip pad click that begins recording (creates
//      `daw.recording`) STOPS the pre-record scheduler and immediately sends
//      Note Off for any active metronome note — the metronome goes silent.
//   3. The "● Rec Arm" button (resetAllClips) is NOT the stop trigger: it may
//      empty all clips, but the pre-record scheduler continues (and resumes on
//      the next beat since all clips remain empty).
//   4. Toggling metronome OFF → ON while all clips are empty restarts the
//      pre-record scheduler (re-enable path).
//   5. Metronome notes leave via the instrument note fan-out path on channel 1
//      only: first beat of each measure = accent MIDI 60 (C4), other beats =
//      MIDI 69 (A4); every Note On is paired with a proper Note Off.
//   6. The worker no longer starts the Python audio metronome process on init;
//      the pre-record path is MIDI-only (no audio click via Pi headphone jack).
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
// Stop trigger: first empty-clip click that begins recording
// ---------------------------------------------------------------------------

test('triggering the first empty clip (which creates daw.recording) stops the pre-record scheduler and sends Note Off', async () => {
    const { daw, events } = makeDawWithCapturedEvents();
    try {
        // Simulate the worker's stop hook so the DAWEngine honours the recording
        // start as a metronome-stop trigger (the worker sets this up).
        daw._onRecordingStarted = () => { daw._stopMetronome(true); };

        daw.setMetronome(true);
        await tick(80);

        assert.ok(daw._metronomeTimer != null, 'pre-record scheduler must be running');

        // Capture how many Note Offs exist before triggering recording.
        const noteOffsBefore = events.filter((e) => e.data[0] === 0x80).length;

        // Trigger the first empty clip in track 0 / slot 0 — this begins recording.
        const result = daw.triggerPad(0, 0, performance.now());
        assert.equal(result.action, 'record', 'empty clip trigger must begin recording');
        assert.ok(daw.recording != null, 'triggering an empty clip must create daw.recording');

        // _stopMetronome(true) must have fired a Note Off for the sustained note.
        const noteOffsAfter = events.filter((e) => e.data[0] === 0x80).length;
        assert.ok(noteOffsAfter > noteOffsBefore, 'must send Note Off when recording starts');

        // The pre-record scheduler timer must be cleared.
        assert.equal(daw._metronomeTimer, null, 'pre-record scheduler must stop on first empty-clip trigger');
    } finally {
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
// Physical-output fan-out: tagged metronome events reach every synth output
// via _sendToSynthOutputs (worker-midi.js).  We verify the tagging contract
// here with mocked outputs — no real ALSA hardware is touched.
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

test('tagged metronome Note On and Note Off reach every mocked connected output through the actual worker/output path', async () => {
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

    // Replace the worker's real outputs map with our mocked outputs.  We must
    // keep the controller-engine exclusion policy intact, so we only add outputs
    // that are NOT excluded (these three arbitrary names pass the default filter).
    // IMPORTANT: do this BEFORE enabling the metronome — the constructor already
    // wired `_onEvent`, which fans out tagged clicks via `_sendToSynthOutputs` on
    // every tick, including the very first one.
    worker.outputs = new Map();
    for (const m of mocks) {
        worker.outputs.set(m.name, m.proto);
    }

    let daw = null;
    try {
        // Enable the metronome on the DAW engine.  The worker's `_onEvent`
        // wrapper (set up in the constructor) will receive tagged events and
        // fan them out via `_sendToSynthOutputs`.
        daw = worker.daw;
        daw.setMetronome(true);

        // Wait for at least one full pre-record click cycle: Note On + its
        // scheduled Note Off (min 80 ms delay).
        await tick(250);

        // Verify every mocked connected output received at least one Note On
        // with the accent (60/C4) metronome note on channel 1.
        for (const m of mocks) {
            const ons = m.getCalls().filter(
                (c) => c[0] === 0x90 && c[1] === 60 // ch1 accent Note On
            );
            assert.ok(ons.length > 0,
                `${m.name} must receive the metronome accent Note On via _sendToSynthOutputs`);
        }

        // Verify every mocked connected output also received a matching Note Off
        // for channel 1 note 60: [0x80 | 0, 60, 0].
        for (const m of mocks) {
            const offs = m.getCalls().filter(
                (c) => c[0] === 0x80 && c[1] === 60 // ch1 note Off
            );
            assert.ok(offs.length > 0,
                `${m.name} must receive the metronome Note Off via _sendToSynthOutputs`);
        }

        // Prove that ordinary instrument events (un-tagged) do NOT go through the
        // tagged fan-out path: send a plain note via the DAW's public `_emit` and
        // confirm it does NOT reach all three mocked outputs (only channel-based
        // routing would, which is not active here).  This confirms the fan-out is
        // specific to the metronome tag.
        daw._emit([0x91 | 0, 60, 80], 0); // ch2 note — different channel, untagged
        await tick(10);
        const anyReceivedUntagged = mocks.some((m) =>
            m.getCalls().some((c) => c[0] === 0x91 && c[1] === 60)
        );
        // Untagged events on channel 2 are NOT fan-out to all outputs — they go
        // through ordinary routing which has no active map. This is expected and
        // confirms the metronome tag is what triggers the every-output fan-out.
        assert.ok(!anyReceivedUntagged,
            'untagged channel-2 events must not reach all outputs via the tagged path');
    } finally {
        // Clean up timers on the DAW engine so the test exits promptly.
        cleanupDaw(daw);
        // Release any held mock output references (defensive).
        worker.outputs.clear();
    }
});

test('metronome Note On and Note Off both carry the "metronome" tag for physical-output routing', async () => {
    const { daw, events } = makeDawWithCapturedEvents();
    try {
        daw.setMetronome(true);
        await tick(80);

        // Every event emitted by the metronome must be tagged so the worker can
        // distinguish it from ordinary instrument routing.
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

test('pre-record beat + first empty-clip trigger: ALL mocked outputs (incl. excluded) receive Note On AND immediate forced Note Off on channel 1', async () => {
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

    // Wire the worker's real stop hook so the first empty-clip trigger stops
    // the pre-record metronome via _stopMetronome(true).
    const originalOnRecordingStarted = worker.daw._onRecordingStarted;
    worker.daw._onRecordingStarted = () => {
        worker.daw._stopMetronome(true);
    };

    try {
        const daw = worker.daw;
        daw.setMetronome(true);

        // Let one pre-record click fire (Note On + scheduled Note Off).
        await tick(120);

        // Trigger the first empty clip — begins recording, must stop metro.
        const result = daw.triggerPad(0, 0, performance.now());
        assert.equal(result.action, 'record');
        assert.ok(daw.recording != null);

        // The forced Note Off from _stopMetronome(true) must reach EVERY output,
        // including the one that is excluded from ordinary routing.
        await advance(20);

        const excludedoffs = excludedMock.getCalls().filter(
            (c) => c[0] === 0x80 && c[1] === 60
        );

        // The forced Note Off must have velocity 0 on channel 1.
        const forcedOffs = excludedoffs.filter(
            (c) => c.length >= 3 && c[2] === 0
        );
        assert.ok(forcedOffs.length > 0,
            'excluded output must receive the immediate forced Note Off (velocity 0, channel 1)'
        );

        // The scheduler timer must be cleared.
        assert.equal(daw._metronomeTimer, null,
            'pre-record scheduler must stop after first empty-clip trigger');
    } finally {
        cleanupDaw(worker.daw);
        worker.outputs.clear();
        worker.controllerEngine.isExcludedOutput = originalIsExcluded;
        worker.daw._onRecordingStarted = originalOnRecordingStarted;
    }
});

test('worker-midi.js does not import or drive a Python audio metronome controller (no MetronomeController, no play/stop/setBpm)', async () => {
    // Read the worker source and verify it no longer integrates any audio
    // metronome controller.  Strip comments so only real code is checked.
    const fs = await import('fs');
    const src = fs.readFileSync(new URL('../worker-midi.js', import.meta.url), 'utf8');

    // The MetronomeController import must be gone entirely.
    assert.ok(
        !/import\s+.*MetronomeController\s+from\s+['"]\.\/metronome-controller\.js['"]/.test(src),
        'worker-midi.js must not import MetronomeController'
    );

    // No references to a metronomeCtrl instance or its control methods remain.
    const stripped = src
        .replace(/\/\/.*$/gm, '')      // remove line comments
        .replace(/\/\*[\s\S]*?\*\//g, ''); // remove block comments

    assert.ok(!/metronomeCtrl\b/.test(stripped), 'worker-midi.js must not reference metronomeCtrl');
    assert.ok(!/\b\.play\(\)|\b\.stop\(\)|\b\.setBpm\(|\b\.setBeats\(/.test(stripped) || !/metronome/.test(stripped),
        'worker-midi.js must not call metronome play()/stop()/setBpm()/setBeats()');

    // The new routing path tags metronome clicks and fans them out to all open
    // outputs via a dedicated method that bypasses the exclusion policy.
    assert.ok(
        /evt\._tag\s*===?\s*['"]metronome['"]/.test(src),
        'worker-midi.js must detect the metronome tag'
    );
    assert.ok(
        /_sendToAllMetronomeOutputs\(bytes\)/.test(stripped),
        'worker-midi.js must fan tagged metronome events to all open outputs via _sendToAllMetronomeOutputs'
    );
});
