import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';

test('Overdub preserves existing notes and records the new layer at live cycle phase', (t) => {
    const daw = new DAWEngine({ tempo: 120 });
    daw.loopLenBeats = 4;
    daw._globalCycleLocked = true;
    daw.tracks[0].clips[0].notes.push({ channel: 1, note: 64, velocity: 100, start: 0, dur: 0.25 });

    const armTime = performance.now();
    daw.startTransport();
    daw._playAnchorTime = armTime - 1000; // live phase is beat 2 at arming
    daw.setRecordMode('overdub');
    t.after(() => daw.stopTransport());

    const result = daw.triggerPad(0, 0, armTime);
    assert.equal(result.action, 'overdub');
    daw.recordEvent(0x90, 67, 90, armTime + 250); // new note at live beat 2.5
    daw.recordEvent(0x80, 67, 0, armTime + 500);
    assert.equal(daw.triggerPad(0, 0, armTime + 750).action, 'record-stop');

    const notes = daw.tracks[0].clips[0].notes;
    assert.equal(notes.length, 2, 'Overdub must retain the old note and add one new note');
    assert.equal(notes[0].note, 64);
    assert.equal(notes[1].note, 67);
    assert.equal(notes[1].start, 2.5, 'new layer is aligned to the live global phase');
    assert.equal(daw.loopLenBeats, 4, 'Overdub must not redefine the locked shared cycle');
});
