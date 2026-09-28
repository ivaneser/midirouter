import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';

test('Overdub preserves existing notes and records the new layer at live cycle phase', (t) => {
    const daw = new DAWEngine({ tempo: 120 });
    daw.loopLenBeats = 4;
    daw._globalCycleLocked = true;
    daw.tracks[0].clips[0].notes.push({ channel: 1, note: 64, velocity: 100, start: 0, dur: 0.25 });

    const armTime = performance.now();
    daw.setRecordMode('overdub');
    daw.startTransport();
    // Anchor the live global phase so transport starts at beat 1 and arming
    // happens exactly on beat 2 (1000 ms per beat at 120 BPM).
    daw._playAnchorTime = armTime - 1000;
    t.after(() => {
        daw.stopTransport();
    });

    // Arm mid-bar at live beat 2; the take must not capture any incoming MIDI
    // before the next bar boundary (beat 4). The old note is preserved.
    const result = daw.triggerPad(0, 0, armTime);
    assert.equal(result.action, 'overdub');

    // Incoming Note On/Off before startTime (before beat 4) must not enter the take.
    daw.recordEvent(0x90, 67, 90, armTime + 250); // live beat 2.5 (< startTime beat 4)
    daw.recordEvent(0x80, 67, 0, armTime + 500);   // live beat 3.0 (< startTime beat 4)

    // Note On after the assigned start (beat 4) must be captured at local position 0.5.
    daw.recordEvent(0x90, 67, 90, armTime + 1250); // live beat 4.5 -> clip-relative 0.5
    // Note Off after the assigned start (beat 4) must give dur 0.5.
    daw.recordEvent(0x80, 67, 0, armTime + 1500);   // live beat 5.0 -> local 1.0

    assert.equal(daw.triggerPad(0, 0, armTime + 2000).action, 'record-stop-stopped',
        'Overdub stop leaves the clip stopped with all layers kept');

    const notes = daw.tracks[0].clips[0].notes;
    assert.equal(notes.length, 2, 'Overdub must retain the old note and add one new note');
    assert.equal(notes[0].note, 64);
    assert.equal(notes[1].note, 67);
    // The new layer is aligned to the live global phase: it started at beat 4.5,
    // which is clip-relative 0.5 because recording start was snapped to beat 4.
    assert.equal(notes[1].start, 0.5, 'new layer must be captured at local position 0.5');
    assert.equal(notes[1].dur, 0.5, 'new layer duration must be 0.5 beats');
    // The old note remains first; the new layer is sorted after it.
    assert.ok(notes[1].start >= notes[0].start, 'new layer must sort after the old note');
    assert.equal(daw.loopLenBeats, 4, 'Overdub must not redefine the locked shared cycle');
});
