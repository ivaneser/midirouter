import test from 'node:test';
import assert from 'node:assert/strict';
import { ExternalMidiClock, estimateBpmFromHistory } from '../external-midi-clock.js';

// ---------------------------------------------------------------------------
// 3. Pure external MIDI Clock slave logic (extracted from worker-midi.js)
//    Testable in plain Node: no ALSA, no worker_threads, no metronome.
// ---------------------------------------------------------------------------

function fakeNow() {
    const start = performance.now();
    let i = 0;
    return () => start + i++ * 21; // ~21 ms / tick -> ~114 BPM (24*60/1000/0.021)
}

test('ExternalMidiClock activates on the first 0xF8 tick', () => {
    let activated = false;
    const now = fakeNow();
    const ec = new ExternalMidiClock({
        now,
        onActivate: () => { activated = true; },
        setTempo: () => { throw new Error('setTempo must not be called during activation'); },
    });

    assert.equal(ec.externalClockActive, false);
    ec.tick(now()); // 1st tick
    assert.equal(activated, true, 'onActivate must fire on the first tick');
    assert.equal(ec.externalClockActive, true);
});

test('0xF8 tick sequence at ~120 BPM estimates tempo close to 120', () => {
    // 120 BPM -> one quarter note = 500 ms -> 24 ticks / 500 ms
    // 21 ms/tick * 24 = 483 ms for the first quarter -> 60000/483 = 124.2 BPM (raw),
    // then smoothed with 0.75/0.25 weighting toward the steady state ~114.
    const times = [];
    let t = performance.now();
    for (let i = 0; i < 60; i++) {
        times.push(t);
        // jitter +-2 ms around the ideal 20.833 ms per tick at 120 BPM
        t += 20.833 + (Math.random() - 0.5) * 4;
    }

    let tempoCalled = 0;
    const ec = new ExternalMidiClock({
        now: () => performance.now(),
        onActivate: () => {},
        setTempo: (bpm) => { tempoCalled++; },
    });

    // Feed ticks one by one.
    for (const ts of times) {
        ec.tick(ts);
    }

    assert.equal(ec.externalClockActive, true);
    // 25+ ticks must have driven setTempo at least once.
    assert.ok(tempoCalled > 0, 'setTempo must be called after 25+ ticks');

    // After many ticks the smoothed tempo should sit reasonably close to 120.
    const est = ec.estimatedBpm;
    assert.ok(est >= 100 && est <= 130, `expected ~120 BPM, got ${est.toFixed(1)}`);
});

test('Fewer than 25 ticks do not produce a BPM estimate (insufficient history)', () => {
    const now = fakeNow();
    let setTempoCalled = false;
    const ec = new ExternalMidiClock({
        now,
        onActivate: () => {},
        setTempo: () => { setTempoCalled = true; },
    });

    // 24 ticks -> history.length == 24 -> below the threshold.
    for (let i = 0; i < 24; i++) ec.tick(now());
    assert.equal(setTempoCalled, false, 'setTempo must not be called with < 25 ticks');
    // State is still activated (activation happens on tick #1 regardless of history).
    assert.equal(ec.externalClockActive, true);
});

test('reset clears external clock state', () => {
    const now = fakeNow();
    let activated = false;
    let deactivated = false;
    const ec = new ExternalMidiClock({
        now,
        onActivate: () => { activated = true; },
        onDeactivate: () => { deactivated = true; },
        setTempo: () => {},
    });

    // 24 ticks at ~21 ms -> ~114 BPM (below the 120 target, but a valid estimate).
    for (let i = 0; i < 25; i++) ec.tick(now());
    assert.equal(activated, true);
    assert.equal(ec.externalClockActive, true);
    assert.ok(ec.estimatedBpm > 0, 'a smoothed BPM estimate must exist after 25 ticks');

    ec.reset();
    assert.equal(ec.externalClockActive, false);
    assert.equal(ec.tickCount, 0);
    assert.equal(ec.estimatedBpm, null);
    // reset itself does not re-activate or fire onDeactivate:
    assert.equal(activated, true);
    assert.equal(deactivated, false);
});

test('A fresh tick after reset reactivates external clock', () => {
    const now = fakeNow();
    let activated = 0;
    const ec = new ExternalMidiClock({
        now,
        onActivate: () => { activated++; },
        setTempo: () => {},
    });

    ec.tick(now());
    assert.equal(activated, 1);
    ec.reset();
    ec.tick(now());
    assert.equal(activated, 2, 'a tick after reset re-activates external clock');
});

test('estimateBpmFromHistory returns null for fewer than 25 samples', () => {
    const history = [100, 200, 300]; // ms timestamps
    assert.equal(estimateBpmFromHistory(history), null);
});

test('estimateBpmFromHistory computes BPM from the first of 25 samples', () => {
    // 25 samples -> 24 intervals. 120 BPM = 500 ms per quarter note.
    const base = performance.now();
    const history = [];
    for (let i = 0; i < 25; i++) history.push(base + i * 20); // 20 ms/tick -> 125 BPM raw
    const bpm = estimateBpmFromHistory(history);
    assert.ok(bpm != null && bpm > 0, 'must return a positive BPM value');
    // Raw estimate from 24 * 20ms = 480 ms quarter: 60000/480 = 125.
    assert.ok(Math.abs(bpm - 125) < 1);
});

test('estimateBpmFromHistory clamps out-of-range values to null', () => {
    // 1 ms/tick -> 60000 BPM (too fast) -> out of range.
    const fast = Array.from({ length: 25 }, (_, i) => i);
    assert.equal(estimateBpmFromHistory(fast), null);

    // 2000 ms/tick -> 3 BPM (too slow) -> out of range.
    const slow = Array.from({ length: 25 }, (_, i) => i * 2000);
    assert.equal(estimateBpmFromHistory(slow), null);
});

test('setTempo is called with the smoothed tempo, not the raw estimate', () => {
    // Feed two steady batches at different tick intervals.  Batch A runs at
    // exactly 20 ms/tick (raw ~125 BPM), batch B at exactly 21 ms/tick (raw ~119 BPM).
    const base = performance.now();
    const setTempoCalls = [];
    const ec = new ExternalMidiClock({
        now: () => performance.now(),
        onActivate: () => {},
        setTempo: (bpm) => { setTempoCalls.push(bpm); },
    });

    // 25 ticks at 20 ms/tick -> the first estimate is raw (~125 BPM, no prior to smooth with).
    for (let i = 0; i < 25; i++) ec.tick(base + i * 20);
    assert.equal(setTempoCalls.length, 1);
    const firstSetTempo = setTempoCalls[0];
    assert.ok(Math.abs(firstSetTempo - 125) < 1, `first setTempo ~125, got ${firstSetTempo.toFixed(1)}`);

    // Another 25 ticks at 21 ms/tick -> raw ~119 BPM, smoothed against the stored 125.
    for (let i = 0; i < 25; i++) ec.tick(base + 25 * 20 + i * 21);
    const secondSetTempo = setTempoCalls[setTempoCalls.length - 1];

    // The smoothed value must lie strictly between the prior (125) and the new raw (~119).
    assert.ok(secondSetTempo < firstSetTempo, 'smoothed tempo should move toward the new measurement');
    assert.ok(secondSetTempo > 119 && secondSetTempo < 125,
        `expected smoothed between 119 and 125, got ${secondSetTempo.toFixed(1)}`);
});
