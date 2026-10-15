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
    assert.equal(daw.recording.originBeat, 12);

    // Play a note on cycle beat 12.25 (= bar 4, beat 2 of the cycle).
    const noteAt = (beat) => T0 + beat * 500;
    daw.recordEvent(0x90, 60, 100, noteAt(12.25));
    daw.recordEvent(0x80, 60, 0, noteAt(12.5));
    daw._stopRecording(12.5);

    const clip = daw.tracks[0].clips[1];
    assert.equal(clip.notes.length, 1);
    // Notes are stored from the take's start phase (bar 3 = beat 12), and the clip
    // plays from that phase, so the note lands on cycle beat 12.25 again.
    assert.equal(clip.phase, 12, 'clip starts at the cycle position where it was recorded');
    assert.equal(clip.notes[0].start, 0.25, 'note is relative to the start of the take');
    assert.equal(clip.length, 4, 'clip length is its own bars: take covers one bar here');
});

test('clip length is its own whole bars and it stores its start phase', () => {
    const daw = new DAWEngine({ tempo: 120 });
    daw.loopLenBeats = 20;          // a 5-bar global cycle
    daw._metronomeBeatsPerMeasure = 4;
    daw._globalCycleLocked = true;
    daw.playing = true;
    const T0 = 1000;
    daw._playAnchorTime = T0;
    const spb = 500;

    // A short take at cycle beat 4..6 (bar 2). Bar-snapping would give an 8-beat
    // clip, which repeats inside the 20-beat cycle and shifts its notes every loop.
    daw.armRecording(0, 0, T0 + 4 * spb, {});
    daw.recordEvent(0x90, 60, 100, T0 + 4.5 * spb);
    daw.recordEvent(0x80, 60, 0, T0 + 5 * spb);
    daw._stopRecording(6);

    const clip = daw.tracks[0].clips[0];
    assert.equal(clip.length, 4, 'clip length is its own bars, not the global cycle');
    assert.equal(clip.phase, 4, 'clip starts at beat 4 of the cycle');
    assert.equal(clip.notes[0].start, 0.5);
});
