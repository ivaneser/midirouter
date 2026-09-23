import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine, noteOn, noteOff } from '../daw.js';
import { SESSION_PAD_NOTES, isSessionPad, padNoteForIndex } from '../launchkey.js';

test('Launchkey Session notes cover both eight-pad rows', () => {
    assert.deepEqual(SESSION_PAD_NOTES, [112, 113, 114, 115, 116, 117, 118, 119,
        96, 97, 98, 99, 100, 101, 102, 103]);
    assert.equal(padNoteForIndex(8), 96);
    assert.equal(isSessionPad(96, 1), true);
    assert.equal(isSessionPad(96, 16), false);
    assert.equal(isSessionPad(120, 1), false);
});

test('a held note records quarter-note timing, velocity and MIDI channel', () => {
    const daw = new DAWEngine();
    assert.equal(daw.slotsPerTrack, 2);
    daw.setRecordMode('replace');
    assert.equal(daw.triggerPad(0, 1, 1000).action, 'record');
    daw.recordEvent(0x90, 60, 103, 1000);
    daw.recordEvent(0x80, 60, 0, 1500);
    assert.equal(daw.triggerPad(0, 1, 1500).action, 'record-stop');
    const note = daw.tracks[0].clips[1].notes[0];
    assert.deepEqual(note, { channel: 1, note: 60, velocity: 103, start: 0, dur: 1 });
    assert.deepEqual(noteOn(note.channel - 1, note.note, note.velocity), [0x90, 60, 103]);
    assert.deepEqual(noteOff(note.channel - 1, note.note), [0x80, 60, 0]);
    assert.equal(daw.clipState[0], 1);
});

test('empty and out-of-range clips cannot enter playing state', () => {
    const daw = new DAWEngine();
    assert.equal(daw.triggerPad(0, 0, 0).action, 'empty');
    assert.equal(daw.triggerPad(0, 2, 0).action, 'invalid');
    assert.equal(daw.clipState[0], -1);
});

test('finalizing a held note preserves a sounding velocity', () => {
    const daw = new DAWEngine();
    daw.setRecordMode('replace');
    daw.triggerPad(0, 0, 1000);
    daw.recordEvent(0x90, 64, 90, 1000);
    daw.triggerPad(0, 0, 1100);
    assert.equal(daw.tracks[0].clips[0].notes[0].velocity, 90);
});
