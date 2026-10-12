// ---------------------------------------------------------------------------
// Global cycle alignment for non-4/4 meters (RED phase).
//
// Contract: when the meter is 3/4, a first replace-recording that spans ~6
// beats must lock the global cycle to 6 beats (one full bar of the current
// meter), not hardcode 4/4. The clip length and daw.loopLenBeats must both
// equal 6 after the take is finalized.
//
// Uses only public DAWEngine APIs: setTempo, setMetronomeBeatsPerMeasure,
// setRecordMode, triggerPad, recordEvent, getState. Deterministic synthetic
// timestamps (performance.now() offsets); no transport start, no audio, no
// worker involvement.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';

test('3/4 meter: first replace take spanning 6 beats locks a 6-beat global cycle', async () => {
    const daw = new DAWEngine({ tempo: 120 }); // 500 ms per quarter-note beat
    const base = performance.now();
    const msPerBeat = 500;

    // Set the meter to 3/4 before any recording.
    daw.setMetronomeBeatsPerMeasure(3);
    daw.setRecordMode('replace');

    // Start a replace recording into slot (0, 0).
    const armResult = daw.triggerPad(0, 0, base);
    assert.equal(armResult.action, 'record', 'triggerPad must start a replace recording');
    assert.ok(daw.recording, 'a replace recording must be active in slot (0,0)');

    // Note-on at clip-relative beat 4 (= base + 2000 ms).
    const tOn = base + 4 * msPerBeat;
    daw.recordEvent(0x90, 60, 100, tOn);
    // Note-off at clip-relative beat 4.5 (= base + 2250 ms).
    const tOff = base + 4.5 * msPerBeat;
    daw.recordEvent(0x80, 60, 0, tOff);

    // Finalize the take via triggerPad at clip-relative beat 6 (= base + 3000 ms).
    const stopResult = daw.triggerPad(0, 0, base + 6 * msPerBeat);
    assert.equal(stopResult.action, 'record-stop-stopped', 'Replace mode: take finalizes and the clip stays stopped');

    const clip = daw.tracks[0].clips[0];
    assert.ok(clip.notes.length > 0, 'the clip must contain the recorded note');

    // The take spans ~6 beats (start beat 0 -> stop beat 6). In 3/4 meter a full
    // bar is 3 beats, so ceil(6/3)*3 = 6 beats. The global cycle and clip length
    // must both be exactly 6 — not the hardcoded 4/4 value of 8.
    assert.equal(
        clip.length,
        6,
        `clip length must equal 6 beats (one full 3/4 bar pair) for a ~6-beat take in 3/4 meter; got ${clip.length}`,
    );
    assert.equal(
        daw.loopLenBeats,
        6,
        `loopLenBeats must be 6 (aligned to the 3/4 meter), not the hardcoded 8 from 4/4; got ${daw.loopLenBeats}`,
    );
});
