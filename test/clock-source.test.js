import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';
import { ExternalMidiClock, estimateBpmFromHistory } from '../external-midi-clock.js';

// ---------------------------------------------------------------------------
// 4. Clock source / status indicator — DAW engine side
//    Verifies that `clockSource` and `midiClockOutputActive` in the DAW state
//    are correct for every transport/toggle configuration, so the frontend
//    indicator updates properly on: external clock activates, goes silent/
//    times out, transport starts/stops, or internal clock is toggled.
// ---------------------------------------------------------------------------

test('DAWEngine clockSource is "none" when idle (transport stopped)', () => {
    const daw = new DAWEngine({ tempo: 120 });
    assert.equal(daw.getClockSource(), 'none');
    assert.equal(daw.isMidiClockOutputActive(), false);

    const state = daw.getState();
    assert.equal(state.clockSource, 'none');
    assert.equal(state.midiClockOutputActive, false);
});

test('DAWEngine clockSource is "internal" when transport plays with MIDI Clock enabled', () => {
    const daw = new DAWEngine({ tempo: 120 });
    assert.equal(daw.getMidiClockState(), true); // enabled by default
    daw.startTransport();

    assert.equal(daw.getClockSource(), 'internal');
    assert.equal(daw.isMidiClockOutputActive(), true);

    const state = daw.getState();
    assert.equal(state.clockSource, 'internal');
    assert.equal(state.midiClockEnabled, true);
    assert.equal(state.midiClockOutputActive, true);

    daw.stopTransport();
});

test('DAWEngine clockSource is "none" when transport stops (was internal)', () => {
    const daw = new DAWEngine({ tempo: 120 });
    daw.startTransport();
    assert.equal(daw.getClockSource(), 'internal');

    daw.stopTransport();
    assert.equal(daw.getClockSource(), 'none');
    assert.equal(daw.isMidiClockOutputActive(), false);
});

test('DAWEngine clockSource stays "none" when MIDI Clock is disabled and transport plays', () => {
    const daw = new DAWEngine({ tempo: 120 });
    daw.setMidiClock(false);
    assert.equal(daw.getMidiClockState(), false);

    daw.startTransport();
    // Transport running but clock output disabled -> not a clock master.
    assert.equal(daw.getClockSource(), 'none');
    assert.equal(daw.isMidiClockOutputActive(), false);

    const state = daw.getState();
    assert.equal(state.clockSource, 'none');
    assert.equal(state.midiClockEnabled, false);
    assert.equal(state.midiClockOutputActive, false);

    daw.stopTransport();
});

test('DAWEngine clockSource switches to "external" when external clock activates', () => {
    const daw = new DAWEngine({ tempo: 120 });
    assert.equal(daw.getClockSource(), 'none');

    // External clock takes over — internal clock pauses.
    daw.setExternalClock(true);
    assert.equal(daw.getClockSource(), 'external');
    assert.equal(daw.isMidiClockOutputActive(), false); // output stops during external

    const state = daw.getState();
    assert.equal(state.clockSource, 'external');

    // When external clock deactivates (e.g. silent times out), internal resumes
    // if transport is playing and MIDI Clock is enabled.
    daw.setExternalClock(false);
    assert.equal(daw.getClockSource(), 'none'); // transport not running
});

test('DAWEngine clockSource returns to "internal" after external clock deactivates while playing', () => {
    const daw = new DAWEngine({ tempo: 120 });
    daw.startTransport();
    assert.equal(daw.getClockSource(), 'internal');

    // Simulate external clock taking over.
    daw.setExternalClock(true);
    assert.equal(daw.getClockSource(), 'external');

    // External clock goes silent / deactivates (mirrors the timeout path).
    daw.setExternalClock(false);
    // Transport is still playing and MIDI Clock is enabled -> internal resumes.
    assert.equal(daw.getClockSource(), 'internal');
    assert.equal(daw.isMidiClockOutputActive(), true);

    daw.stopTransport();
});

test('DAWEngine clockSource stays "none" after external deactivates while transport stopped', () => {
    const daw = new DAWEngine({ tempo: 120 });
    daw.setExternalClock(true);
    daw.setExternalClock(false);
    assert.equal(daw.getClockSource(), 'none');
});

test('DAWEngine toggling MIDI Clock while playing updates source correctly', () => {
    const daw = new DAWEngine({ tempo: 120 });
    daw.startTransport();
    assert.equal(daw.getClockSource(), 'internal');

    // Disable MIDI Clock -> no longer a clock master.
    daw.setMidiClock(false);
    assert.equal(daw.getClockSource(), 'none');
    assert.equal(daw.isMidiClockOutputActive(), false);

    // Re-enable while still playing -> internal resumes.
    daw.setMidiClock(true);
    assert.equal(daw.getClockSource(), 'internal');
    assert.equal(daw.isMidiClockOutputActive(), true);

    daw.stopTransport();
});

// ---------------------------------------------------------------------------
// 5. External tempo notification threshold & worker state refresh behavior
//    Verify the TEMPO_CHANGE_THRESHOLD throttle in external-midi-clock.js and
//    that setTempo is NOT called on every tick, plus the onTempoChange callback
//    contract used by the worker's broadcast path.
// ---------------------------------------------------------------------------

test('ExternalMidiClock does not call setTempo for sub-threshold tempo drift', () => {
    // 120 BPM -> ideal 20.833 ms/tick. Feed ticks with tiny jitter that keeps
    // the smoothed estimate well within the 0.5% threshold after the first
    // broadcast, so setTempo should not fire repeatedly.
    const base = performance.now();
    const setTempoCalls = [];
    let tempoChangeCount = 0;

    const ec = new ExternalMidiClock({
        now: () => performance.now(),
        onActivate: () => {},
        setTempo: (bpm) => { setTempoCalls.push(bpm); },
        onTempoChange: () => { tempoChangeCount++; },
    });

    // 49 ticks at exactly 20.833 ms/tick -> steady 120 BPM, no drift.
    for (let i = 0; i < 49; i++) {
        ec.tick(base + i * 20.833);
    }

    // First broadcast happens on the first valid estimate (~tick #25).
    assert.ok(setTempoCalls.length >= 1, 'first setTempo must fire');

    // With zero drift, subsequent broadcasts should NOT happen because each
    // changePct is ~0%, below the 0.5% threshold. Count calls after first.
    const subsequent = setTempoCalls.length - 1;
    assert.ok(subsequent < 3,
        `expected few/no subsequent setTempo with zero drift, got ${subsequent}`);
});

test('ExternalMidiClock re-emits tempo when estimate crosses the 0.5% threshold', () => {
    const base = performance.now();
    const setTempoCalls = [];

    // Start at 120 BPM (20.833 ms/tick).
    const ec = new ExternalMidiClock({
        now: () => performance.now(),
        onActivate: () => {},
        setTempo: (bpm) => { setTempoCalls.push(bpm); },
    });

    // 25 ticks at 120 BPM -> first estimate ~120.
    for (let i = 0; i < 25; i++) {
        ec.tick(base + i * 20.833);
    }
    const firstCallCount = setTempoCalls.length;

    // Then switch to a distinctly faster rate (~130 BPM, ~19 ms/tick). The
    // smoothed estimate will drift toward 130 and cross 0.5% relative to the
    // stored 120 prior, triggering a new broadcast.
    const offset = base + 25 * 20.833;
    for (let i = 0; i < 25; i++) {
        ec.tick(offset + i * 19);
    }

    assert.ok(setTempoCalls.length > firstCallCount,
        'setTempo must re-fire when estimate crosses the threshold');

    const last = setTempoCalls[setTempoCalls.length - 1];
    assert.ok(last > 120, `expected tempo > 120 after faster ticks, got ${last.toFixed(1)}`);
});

test('ExternalMidiClock onTempoChange fires alongside setTempo', () => {
    const base = performance.now();
    let tempoChangeCount = 0;

    const ec = new ExternalMidiClock({
        now: () => performance.now(),
        onActivate: () => {},
        setTempo: () => {},
        onTempoChange: () => { tempoChangeCount++; },
    });

    // Feed enough ticks to get the first estimate and a drift.
    for (let i = 0; i < 50; i++) {
        ec.tick(base + i * 21);
    }

    assert.ok(tempoChangeCount > 0, 'onTempoChange must fire when tempo is broadcast');
});

test('ExternalMidiClock first valid estimate always broadcasts (count === 0 path)', () => {
    const base = performance.now();
    let setTempoCalled = false;

    // Use a rate that gives exactly the threshold crossing on the first
    // estimate to confirm the count === 0 path fires even with no prior.
    const ec = new ExternalMidiClock({
        now: () => performance.now(),
        onActivate: () => {},
        setTempo: () => { setTempoCalled = true; },
    });

    // 25 ticks -> first valid estimate, _tempoBroadcastCount === 0 path.
    for (let i = 0; i < 25; i++) {
        ec.tick(base + i * 20);
    }

    assert.equal(setTempoCalled, true, 'first estimate must always broadcast via setTempo');
});

test('ExternalMidiClock reset clears _tempoBroadcastCount so next estimate re-broadcasts', () => {
    const base = performance.now();
    let setTempoCount = 0;

    const ec = new ExternalMidiClock({
        now: () => performance.now(),
        onActivate: () => {},
        setTempo: () => { setTempoCount++; },
    });

    for (let i = 0; i < 25; i++) ec.tick(base + i * 20);
    const afterFirst = setTempoCount;

    ec.reset();

    // After reset, a fresh 25-tick batch must trigger the count === 0 path again.
    for (let i = 0; i < 25; i++) ec.tick(base + 1000 + i * 20);
    assert.ok(setTempoCount > afterFirst, 'reset must allow a fresh broadcast');
});

test('estimateBpmFromHistory returns null for non-array input', () => {
    // @ts-expect-error intentional bad input
    assert.equal(estimateBpmFromHistory('not-an-array'), null);
    // @ts-expect-error intentional bad input
    assert.equal(estimateBpmFromHistory(null), null);
    // @ts-expect-error intentional bad input
    assert.equal(estimateBpmFromHistory({ length: 25 }), null);
});

test('estimateBpmFromHistory handles equal timestamps (zero quarterMs) as null', () => {
    const history = Array.from({ length: 25 }, () => 1000);
    assert.equal(estimateBpmFromHistory(history), null);
});
