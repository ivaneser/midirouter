// Clips must be phase-locked to the transport cycle: a take recorded while the
// transport is already playing stores its notes relative to the cycle start
// (beat 0), not to the bar where recording began.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';

test('take recorded mid-cycle keeps its position relative to the cycle start', () => {
    const daw = new DAWEngine({ tempo: 120 }); // 500 ms per beat
    daw.loopLenBeats = 16;
    daw._metronomeBeatsPerMeasure = 4;
    daw._globalCycleLocked = true;
    daw.playing = true;
    const T0 = 1000;
    daw._playAnchorTime = T0;

    // Press record at cycle beat 9.5 -> recording snaps to bar 3 (beat 12).
    daw.armRecording(0, 1, T0 + 9.5 * 500, {});
    assert.equal(daw.recording.startBeat, 12);
    assert.equal(daw.recording.originBeat, 0);

    // Play a note on cycle beat 12.25 (= bar 4, beat 2 of the cycle).
    const noteAt = (beat) => T0 + beat * 500;
    daw.recordEvent(0x90, 60, 100, noteAt(12.25));
    daw.recordEvent(0x80, 60, 0, noteAt(12.5));
    daw._stopRecording(12.5);

    const clip = daw.tracks[0].clips[1];
    assert.equal(clip.notes.length, 1);
    assert.equal(clip.notes[0].start, 12.25, 'note must stay at its cycle position, not shift by the start bar');
    assert.equal(clip.length, 16, 'clip covers the cycle up to the last note');
});
