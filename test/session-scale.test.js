import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';
import { MIDIRouterWorker } from '../worker-midi.js';

const note = (n, start = 0) => ({ note: n, start, dur: 1, velocity: 100, channel: 1 });

test('selecting a scale refits every clip of every track', () => {
    const daw = new DAWEngine();
    daw.tracks[0].clips[0].notes = [note(61), note(64, 2)];
    daw.tracks[2].clips[0].notes = [note(66), { ...note(70, 1), channel: 3 }];
    assert.equal(daw.setScale(0, 'major'), true);
    assert.deepEqual(daw.tracks[0].clips[0].notes.map(n => n.note), [60, 64]);
    assert.deepEqual(daw.tracks[2].clips[0].notes.map(n => n.note), [67, 69]);
    assert.equal(daw.tracks[2].clips[0].notes[1].channel, 3, 'note channels are kept');
});

test('no scale leaves notes alone, and an unknown scale or root is refused', () => {
    const daw = new DAWEngine();
    daw.tracks[0].clips[0].notes = [note(61)];
    assert.equal(daw.setScale(0, null), true);
    assert.equal(daw.tracks[0].clips[0].notes[0].note, 61);
    assert.equal(daw.setScale(0, 'nope'), false);
    assert.equal(daw.setScale(12, 'major'), false);
    assert.equal(daw.setScale(-1, 'major'), false);
});

test('correctNote follows the session scale and root', () => {
    const daw = new DAWEngine();
    assert.equal(daw.correctNote(61), 61);
    daw.setScale(2, 'major');            // D major: C# is in the scale, C is not
    assert.equal(daw.correctNote(61), 61);
    assert.equal(daw.correctNote(60), 59);   // C sits between B (the 6th) and C# (the 7th): the calmer 6th wins
});

test('the scale is part of the state and of saved sessions', () => {
    const daw = new DAWEngine();
    daw.setScale(9, 'minor');
    const state = daw.getState();
    assert.equal(state.scaleRoot, 9);
    assert.equal(state.scaleId, 'minor');
    const other = new DAWEngine();
    other.loadData(JSON.parse(JSON.stringify(daw.toData())));
    assert.equal(other._scaleRoot, 9);
    assert.equal(other._scaleId, 'minor');
    const old = new DAWEngine();
    old.setScale(5, 'major');
    const data = daw.toData();
    delete data.scale;
    old.loadData(data);
    assert.equal(old._scaleId, null, 'a session saved without a scale clears it');
});

function workerWith(daw) {
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = daw;
    return worker;
}

test('incoming notes are corrected, and each note-off releases the note that was sounded', () => {
    const daw = new DAWEngine();
    daw.setScale(0, 'major');
    const worker = workerWith(daw);
    assert.equal(worker._correctIncomingNote('LPK', 1, 61, true), 60);   // C# -> C
    daw.setScale(0, null);                                                // scale removed while the key is held
    assert.equal(worker._correctIncomingNote('LPK', 1, 61, false), 60, 'the note-off matches the note-on');
    assert.equal(worker._correctIncomingNote('LPK', 1, 61, true), 61, 'no scale: untouched');
    assert.equal(worker._correctIncomingNote('LPK', 1, 61, false), 61);
    assert.equal(worker._correctIncomingNote('LPK', 1, 99, false), 99, 'a stray note-off is not corrected');
});
