import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';

test('default layout has 2 clips per track', () => {
    const daw = new DAWEngine();
    assert.equal(daw.slotsPerTrack, 2);
    assert.ok(daw.tracks.every((t) => t.clips.length === 2));
});

test('removeLastClip drops the last clip and keeps the others', () => {
    const daw = new DAWEngine({ trackCount: 2 });
    daw.addClip(0);
    const first = daw.tracks[0].clips[0];
    assert.equal(daw.removeLastClip(0), 2);
    assert.equal(daw.tracks[0].clips.length, 2);
    assert.equal(daw.tracks[0].clips[0], first);
});

test('removeLastClip refuses the only clip of a track', () => {
    const daw = new DAWEngine({ trackCount: 2 });
    daw.removeLastClip(0);
    assert.equal(daw.tracks[0].clips.length, 1);
    assert.equal(daw.removeLastClip(0), -1);
    assert.equal(daw.tracks[0].clips.length, 1);
});

test('removeLastClip stops playback of the removed clip', () => {
    const daw = new DAWEngine({ trackCount: 2 });
    daw.clipState[0] = 1;
    daw.removeLastClip(0);
    assert.equal(daw.clipState[0], -1);
});

test('removeTrack removes the track and shifts later tracks and playing state', () => {
    const daw = new DAWEngine({ trackCount: 3 });
    daw.tracks[2].clips[0].notes.push({ channel: 3, note: 60, velocity: 90, start: 0, dur: 0.5 });
    daw.clipState = [-1, 0, 1];
    assert.equal(daw.removeTrack(1), true);
    assert.equal(daw.tracks.length, 2);
    assert.equal(daw.tracks[1].clips[0].notes.length, 1);
    assert.deepEqual(daw.clipState, [-1, 1]);
});

test('removeTrack keeps at least one track', () => {
    const daw = new DAWEngine({ trackCount: 1 });
    assert.equal(daw.removeTrack(0), false);
    assert.equal(daw.tracks.length, 1);
});

test('removeTrack of the recording track stops the take; later recording index shifts', () => {
    const daw = new DAWEngine({ trackCount: 3 });
    daw.recording = { track: 2, slot: 0, mode: 'record', notes: [], noteStarts: new Map(), startBeat: 0, startTime: 0 };
    daw.removeTrack(1);
    assert.equal(daw.recording.track, 1);
});
