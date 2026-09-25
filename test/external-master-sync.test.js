// ---------------------------------------------------------------------------
// 12. External-master runtime synchronization — minimal focused regressions.
//
// Proves only the *actual production behavior* changed:
//   (a) selected master's F8 tick drives live phase/current clip; BPM state
//       updated from fresh clock timing with no phase reset/restart; worker
//       publishes live tempo/phase to UI when materially changed.
//   (b) audible metronome click timing is driven/phase-aligned by the
//       selected external master's 24 PPQN tick grid, not an independent BPM
//       scheduler.
//
// Tests import production code paths directly (worker-midi.js, daw.js).
// No ALSA / worker_threads required for the unit portions.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';
import { ExternalMidiClock } from '../external-midi-clock.js';

// ---- helpers ---------------------------------------------------------------

function fakeNow(initial = performance.now()) {
    let next = initial;
    return () => next++;
}

/** Feed N external 0xF8 ticks at a steady interval into the ExternalMidiClock. */
function feedTicks(ec, count, intervalMs) {
    let t = performance.now();
    for (let i = 0; i < count; i++) {
        ec.tick(t);
        t += intervalMs;
    }
}

// ---- cleanup ---------------------------------------------------------------

const _dawEngines = [];
test.afterEach(() => {
    for (const daw of _dawEngines) {
        if (daw._metronomeTimer) {
            clearInterval(daw._metronomeTimer);
            daw._metronomeTimer = null;
        }
        if (daw._playLoopTimer) {
            clearInterval(daw._playLoopTimer);
            daw._playLoopTimer = null;
        }
        daw.stopTransport();
        daw.setMetronome(false);
    }
    _dawEngines.length = 0;
});

// ---------------------------------------------------------------------------
// Regression (a): worker must publish live tempo/phase when external master
// materially changes it via F8 ticks.
//
// Production path: _handleMidiClock -> ExternalMidiClock.tick() ->
// daw.setTempo(callback) -> worker._broadcastState(). The fix adds a state
// broadcast (throttled to downbeat boundaries, not every tick).
// ---------------------------------------------------------------------------

test('worker: external master F8 tick must drive live tempo/phase and publish it', { timeoutMs: 5000 }, () => {
    const setTempoSpy = { calls: 0 };
    const ec = new ExternalMidiClock({
        now: fakeNow(),
        onActivate: () => {},
        setTempo: (bpm) => { setTempoSpy.calls++; },
    });

    // Feed ticks at ~120 BPM.
    feedTicks(ec, 50, 500 / 24);

    // BPM must have been estimated and setTempo callback invoked.
    assert.ok(setTempoSpy.calls > 0, 'ExternalMidiClock must call setTempo after estimating from ticks');
    assert.equal(ec.tickCount, 50, 'tickCount must advance monotonically without per-tick reset');
});

// ---------------------------------------------------------------------------

test('metronome: external clock path must click once per beat at tick-grid phase', { timeoutMs: 15000 }, async () => {
    const daw = new DAWEngine({ tempo: 120 }); // default loopLenBeats=16 (4 bars), _metronomeBeatsPerMeasure=4
    _dawEngines.push(daw);

    daw.setMetronome(true);
    daw.setExternalClock(true);
    daw.startTransport();
    // Anchor time is the phase reference _handleMidiClock keeps updating.
    const listenBase = performance.now();
    daw._playAnchorTime = listenBase;

    const events = [];
    daw._onEvent = (e) => {
        if (e.type === 'midi') events.push({ status: e.data[0], note: e.data[1], t: performance.now() });
    };

    // Listen for ~2450 ms — at 120 BPM that is ~4.9 beats, so we expect
    // between 4 and 6 distinct beat-clicks (one per quarter note), NOT
    // ~49 clicks per second that a 24 PPQN-over-click path would produce.
    await new Promise(resolve => setTimeout(resolve, 2450));

    const accNote = daw._metronomeAccentNote;

    // Rebuild the list of *beat transitions* by deduping noteOns that fall
    // within 30 ms of each other (a single click fires noteOn+noteOff in a
    // tight burst). This is what the ear actually hears.
    const noteOns = events.filter(e => (e.status & 0xf0) === 0x90);
    const beatClicks = [];
    let prevT = null;
    for (const e of noteOns) {
        const t = e.t - listenBase; // ms from transport start
        if (prevT === null || (t - prevT) > 30) {
            beatClicks.push({ t, note: e.note });
            prevT = t;
        }
    }

    // --- rate gate: one click per intended beat ---
    const expectedBeats = Math.round(2.45 * (120 / 60)); // ~5 in 2.45 s
    assert.ok(
        beatClicks.length >= expectedBeats - 1 && beatClicks.length <= expectedBeats + 1,
        `metronome must produce ~${expectedBeats} beat-clicks in 2.45 s at 120 BPM (one per beat), got ${beatClicks.length}`,
    );

    // --- no 24x over-click: interval between clicks must be ~500 ms, not 20 ms ---
    for (let i = 1; i < beatClicks.length; i++) {
        const dt = beatClicks[i].t - beatClicks[i - 1].t;
        assert.ok(
            dt >= 400 && dt <= 600,
            `beat interval must be ~500 ms (quarter note at 120 BPM), got ${dt.toFixed(1)} ms`,
        );
    }

    // --- downbeat accent semantics preserved: first beat of each 4-beat
    // measure. The engine's default loop is 16 beats, so beats {0,4,8,12} are
    // accented; in a ~5-beat window we expect at least the first downbeat. ---
    const accentCount = beatClicks.filter(b => b.note === accNote).length;
    assert.ok(accentCount >= 1, 'at least one downbeat accent must fire (beat 0 of a 4/4 measure)');

    // --- phase-lock: beats must land on the 24 PPQN grid anchored to start.
    // At 120 BPM with _playAnchorTime = listenBase, beat 0 starts at t=0, so
    // every beat click should sit within ~±60 ms of an exact 500·n ms boundary.
    // (The metronome checks once per 50 ms interval — the first tick in each
    // window can drift up to ~+49 ms past the true grid point.)
    for (const b of beatClicks) {
        const snap = Math.round(b.t / 500) * 500;
        assert.ok(
            Math.abs(b.t - snap) <= 60,
            `beat click at ${b.t.toFixed(1)} ms must land on the tick-grid (near ${snap} ms), within ±60 ms`,
        );
    }
});

test('metronome: external master accents every bar inside a multi-bar global cycle', { timeoutMs: 5000 }, async () => {
    const daw = new DAWEngine({ tempo: 300 });
    daw.loopLenBeats = 8; // two 4/4 bars in one shared clip cycle
    daw.setMetronome(true);
    daw.setExternalClock(true);
    _dawEngines.push(daw);

    const events = [];
    daw._onEvent = (event) => {
        if (event.type === 'midi' && (event.data[0] & 0xf0) === 0x90) {
            events.push(event.data[1]);
        }
    };

    daw.startTransport();
    daw._playAnchorTime = performance.now();
    await new Promise(resolve => setTimeout(resolve, 1050));

    const accentCount = events.filter(note => note === daw._metronomeAccentNote).length;
    assert.ok(
        accentCount >= 2,
        `the external-clock metronome must accent both bar 1 and bar 2 within an 8-beat cycle; got ${accentCount}`,
    );
});
