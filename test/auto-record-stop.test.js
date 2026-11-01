import test from 'node:test';
import assert from 'node:assert/strict';
import { MIDIRouterWorker } from '../worker-midi.js';
import { DAWEngine } from '../daw.js';

// With the loop length set by hand, a new clip stops recording by itself when that many bars are full.
function setup(t, { bars = 2 } = {}) {
    const timers = [];
    const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
    globalThis.setTimeout = (fn, delay) => { const timer = { fn, delay, cleared: false, unref() {} }; timers.push(timer); return timer; };
    globalThis.clearTimeout = timer => { if (timer) timer.cleared = true; };
    t.after(() => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; });
    const daw = new DAWEngine({ tempo: 120 });
    if (bars != null) daw.setMasterLoopBars(bars);
    daw.armTrack(0);
    daw.setRecordMode('none');
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = daw;
    worker._trackPlayTimers = new Map();
    worker._ledGlow = new Map();
    worker._refreshPadLeds = () => {};
    worker._syncPadClock = () => {};
    worker._clearStaleRecordingFeedback = () => {};
    worker._broadcastState = () => {};
    worker._startTrackPlayback = () => {};
    worker._stopTrackPlayback = () => {};
    return { worker, daw, timers };
}

test('a new clip under a manual loop length gets a stop timer at the end of that length', t => {
    const { worker, daw, timers } = setup(t, { bars: 2 });
    daw.triggerPad(0, 0, performance.now());
    daw.recording.startTime = performance.now();
    assert.equal(worker._scheduleAutoRecordingStop(), true);
    const stop = timers.at(-1);
    const wantMs = 2 * 4 * 0.5 * 1000;   // 2 bars of 4 beats at 120 BPM
    assert.ok(Math.abs(stop.delay - wantMs) < 60, `stops after ${stop.delay} ms, expected about ${wantMs}`);
    daw.recording.notes.push({ note: 60, start: 1, dur: 0.5, velocity: 100, channel: 1 });
    stop.fn();
    assert.equal(daw.recording, null, 'the take is finished');
    assert.equal(daw.tracks[0].clips[0].length, 8, 'the clip has the manual loop length');
});

test('no automatic stop without a manual loop length, or when a layer is added to a filled clip', t => {
    const free = setup(t, { bars: null });
    free.daw.triggerPad(0, 0, performance.now());
    assert.equal(free.worker._scheduleAutoRecordingStop(), false);

    const { worker, daw } = setup(t, { bars: 2 });
    daw.tracks[0].clips[0].notes.push({ start: 0, dur: 1, note: 60, velocity: 100, channel: 1 });
    daw.setRecordMode('overdub');
    daw.triggerPad(0, 0, performance.now());
    if (daw.recording) assert.equal(worker._scheduleAutoRecordingStop(), false);
});

test('new clips and added tracks get the manual loop length', () => {
    const daw = new DAWEngine({ tempo: 120 });
    daw.setMasterLoopBars(3);
    assert.ok(daw.tracks.every(track => track.clips.every(clip => clip.length === 12)));
});
