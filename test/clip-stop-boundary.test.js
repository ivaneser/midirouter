import test from 'node:test';
import assert from 'node:assert/strict';
import { MIDIRouterWorker } from '../worker-midi.js';
import { DAWEngine } from '../daw.js';

function setup(playback) {
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker._trackPlayTimers = new Map([[0, playback]]);
    worker._broadcastState = () => {};
    worker.daw = { clipState: [0], _secondsPerBeatMs: () => 500, _secondsPerBeat: () => 0.5 };
    worker.audioOffsetMs = -30;
    return worker;
}

test('internal stop waits for the clip loop end, with captured latency shift', () => {
    const now = performance.now();
    const playback = { originMs: now - 700, loopBeats: 8, msPerBeat: 500, audioOffsetMs: -30 };
    const worker = setup(playback);
    worker._queueClipStop(0, now);
    try {
        assert.equal(playback.stopAtMs, playback.originMs - 30 + 4000);
        assert.equal(worker.daw.clipState[0], 0);
        const timer = playback.stopTimer;
        worker._queueClipStop(0, now + 100);
        assert.equal(playback.stopTimer, timer, 'repeated stop request does not postpone the boundary');
    } finally { clearTimeout(playback.stopTimer); }
});

test('external stop fires at the next clip boundary and emits no new-loop notes', () => {
    const playback = { externalClock: true, startTick: 0, loopTicks: 96, pendingNoteOffs: new Map(), noteEvents: [] };
    const worker = setup(playback);
    worker.audioOffsetMs = 0;
    worker._externalMidiClock = { tickCount: 30 };
    worker._queueClipStop(0, performance.now());
    assert.equal(playback.stopAtTick, 96);
    let stopped = false;
    worker._finishClipStop = () => { stopped = true; };
    worker._tickExternalClipPlayback(95);
    assert.equal(stopped, false);
    worker._tickExternalClipPlayback(96);
    assert.equal(stopped, true);
});

test('switching slots queues until the source loop ends and launches at that boundary', () => {
    const now = performance.now();
    const playback = { slot: 0, originMs: now - 500, loopBeats: 4, msPerBeat: 500, audioOffsetMs: 0 };
    const worker = setup(playback);
    worker.daw.recordMode = 'none';
    worker.daw.tracks = [{ clips: [{}, {}] }];
    const result = worker._triggerPad(0, 1, now);
    assert.equal(result.action, 'switch-pending');
    assert.equal(worker.daw.clipState[0], 0);
    assert.equal(playback.nextClip.slot, 1);
    clearTimeout(playback.stopTimer);
    let launched;
    worker._stopTrackPlayback = () => worker._trackPlayTimers.delete(0);
    worker._triggerPad = (...args) => { launched = args; };
    worker._finishClipStop(0, playback);
    assert.deepEqual(launched, [0, 1, playback.stopAtMs, { boundarySwitch: true }]);
});

test('boundary recording starts immediately without another bar or count-in', () => {
    const daw = new DAWEngine();
    daw.playing = true;
    daw._globalCycleLocked = true;
    daw._playAnchorTime = performance.now() - 1000;
    const now = performance.now();
    daw.triggerPad(0, 1, now, { immediate: true });
    assert.equal(daw.recording.startTime, daw._pressTime(now));
    assert.equal(daw._countInRunning, false);
});
