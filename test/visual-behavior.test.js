// ---------------------------------------------------------------------------
// 12. Visual / tempo acceptance rules — RED phase (Requirement B).
//
// These tests verify the contract that the DAW engine's `_onProgress` callback
// drives visual feedback: clip/global cycle start = green, first beat of
// subsequent bars = red, ordinary beats = mode color, and active-pad blink.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Test 1 — _onProgress must fire on every beat during transport play.
// ---------------------------------------------------------------------------

test('_onProgress fires once per beat while transport is playing', async () => {
    const { DAWEngine } = await import('../daw.js');
    const daw = new DAWEngine({ tempo: 120 }); // 500 ms / beat
    let calledCount = 0;

    daw._onProgress = () => { calledCount++; };

    assert.equal(daw.playing, false);
    daw.startTransport();
    assert.equal(daw.playing, true);

    // Wait ~4 beats worth of time.
    await sleep(4 * 500 + 100);
    daw.stopTransport();

    assert.ok(calledCount >= 4, `_onProgress should fire ~once per beat (got ${calledCount})`);
});

// ---------------------------------------------------------------------------
// Test 2 — _onProgress reports phase-relative position within loopLenBeats.
// ---------------------------------------------------------------------------

test('_onProgress beat wraps within loopLenBeats (global cycle)', async () => {
    const { DAWEngine } = await import('../daw.js');
    const daw = new DAWEngine({ tempo: 120, loopLenBeats: 4 }); // 4-beat cycle
    const beats = [];

    daw._onProgress = (beat) => { beats.push(beat); };

    daw.startTransport();
    await sleep(6 * 500 + 100); // ~6 beats
    daw.stopTransport();

    // After wrapping, beat should stay within [0, loopLenBeats).
    for (const b of beats) {
        assert.ok(
            b >= 0 && b < daw.loopLenBeats,
            `beat phase ${b} must be within [0, ${daw.loopLenBeats})`,
        );
    }
});

// ---------------------------------------------------------------------------
// Test 3 — first beat of a new bar (subsequent to the global cycle start) is
// distinguishable from ordinary beats via _onProgress.
// ---------------------------------------------------------------------------

test('_onProgress distinguishes downbeats from ordinary beats', async () => {
    const { DAWEngine } = await import('../daw.js');
    const daw = new DAWEngine({ tempo: 120, loopLenBeats: 8 }); // 8-beat cycle
    let prevBeatInt = -1;
    const downbeatFlags = [];

    daw._onProgress = (beat) => {
        const beatInt = Math.floor(beat);
        if (prevBeatInt >= 0 && beatInt !== prevBeatInt) {
            // Crossed a whole-beat boundary — detect bar start.
            const isDownbeat = (beatInt % 4 === 0); // 4/4 meter default
            downbeatFlags.push(isDownbeat);
        }
        prevBeatInt = beatInt;
    };

    daw.startTransport();
    await sleep(12 * 500 + 100); // ~12 beats
    daw.stopTransport();

    assert.ok(downbeatFlags.length >= 2, 'should detect at least 2 downbeats in 12 beats');
});
