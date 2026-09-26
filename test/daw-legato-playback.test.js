import test from 'node:test';
import assert from 'node:assert/strict';
import { MIDIRouterWorker } from '../worker-midi.js';
import { DAWEngine } from '../daw.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('internal-clock pad launch inherits transport phase and wraps on the clip\'s own loop', async (t) => {
    const sent = [];
    const worker = Object.create(MIDIRouterWorker.prototype);
    // 240 BPM (250 ms per beat) keeps the long 16-beat clip wrap fast in tests.
    worker.daw = new DAWEngine({ tempo: 240 });
    worker.daw.loopLenBeats = 4;
    worker.daw.tracks[0].clips[0] = {
        length: 16,
        notes: [
            { channel: 1, note: 60, velocity: 90, start: 0, dur: 0.1 },
            { channel: 1, note: 62, velocity: 90, start: 1.5, dur: 0.1 },
        ],
    };
    worker.daw.setRecordMode('none');
    worker.daw.startTransport();
    worker.outputs = new Map([['test-synth', {
        sendMessage: (bytes) => sent.push({ bytes: [...bytes], at: performance.now() }),
    }]]);
    worker.controllerEngine = { isExcludedOutput: () => false };
    worker._trackPlayTimers = new Map();
    worker._ledGlow = new Map();
    worker._sendFeedback = () => {};
    worker._broadcastState = () => {};
    t.after(() => {
        worker._stopTrackPlayback(0);
        worker.daw.stopTransport();
    });

    // Launch at live transport phase 1.5 (1.5 beats = 375 ms into the cycle).
    const triggeredAt = performance.now();
    worker.daw._playAnchorTime = triggeredAt - 375;
    const result = worker._triggerPad(0, 0, triggeredAt);
    assert.equal(result.action, 'play');

    await sleep(80);
    const noteOnsAtLaunch = sent.filter(({ bytes }) => (bytes[0] & 0xf0) === 0x90);
    assert.deepEqual(noteOnsAtLaunch.map(({ bytes }) => bytes[1]), [62],
        'phase-1.5 event plays at launch; phase-0 event must wait for the clip wrap');

    // The clip loops on its OWN 16-beat length: the beat-0 event fires only
    // 14.5 beats after launch (3625 ms at 240 BPM), not at the 4-beat global cycle.
    await sleep(3750);
    const noteOnsAfterWrap = sent.filter(({ bytes }) => (bytes[0] & 0xf0) === 0x90);
    assert.deepEqual(noteOnsAfterWrap.map(({ bytes }) => bytes[1]), [62, 60],
        'phase-0 event plays when the clip\'s own 16-beat loop wraps');
});

// Launchkey Play button contract: Play is a transport toggle. Pressing it
// while playback is running must STOP the transport (and all clip playback);
// pressing it while stopped must start it.
test('Launchkey Play toggles: stops running playback, starts when stopped', () => {
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = new DAWEngine({ tempo: 120 });
    worker.daw.tracks[0].clips[0] = {
        length: 4,
        notes: [{ channel: 1, note: 60, velocity: 90, start: 0, dur: 0.25 }],
    };
    worker.daw.setRecordMode('none');
    worker.outputs = new Map();
    worker.controllerEngine = { isExcludedOutput: () => false };
    worker._trackPlayTimers = new Map();
    worker._ledGlow = new Map();
    worker._sendFeedback = () => {};
    worker._broadcastState = () => {};
    worker._transportPlaying = false;

    // Phase 1: transport stopped -> Play press starts it.
    worker._handleProfileTransport('play', true);
    assert.equal(worker.daw.playing, true, 'Play press while stopped must start transport');
    assert.equal(worker._transportPlaying, true);

    // Phase 2: launch a clip so running playback exists.
    worker._triggerPad(0, 0, performance.now());
    assert.equal(worker._trackPlayTimers.size, 1, 'clip must be playing');

    // Phase 3: transport running -> Play press stops it and all clips.
    worker._handleProfileTransport('play', true);
    assert.equal(worker.daw.playing, false, 'Play press while running must stop transport');
    assert.equal(worker._transportPlaying, false);
    assert.equal(worker._trackPlayTimers.size, 0, 'all clip playback must stop');
    assert.equal(worker.daw.clipState[0], -1, 'clip playing state must be cleared');

    worker.daw.stopTransport();
});
