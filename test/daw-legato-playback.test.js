import test from 'node:test';
import assert from 'node:assert/strict';
import { MIDIRouterWorker } from '../worker-midi.js';
import { DAWEngine } from '../daw.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('internal-clock pad launch waits for the next bar boundary and starts at beat 0', async (t) => {
    const sent = [];
    const worker = Object.create(MIDIRouterWorker.prototype);
    // 240 BPM: one beat is 250 ms, so a 4/4 bar spans 1000 ms.
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

    // Launch at live transport phase 1.5 (375 ms into the bar). A filled clip
    // launched mid-bar must not fire any note until the next bar boundary,
    // i.e. after 625 ms (the remainder of the current bar), and then start
    // from beat 0 of its own loop.
    const triggeredAt = performance.now();
    worker.daw._playAnchorTime = triggeredAt - 375;
    const result = worker._triggerPad(0, 0, triggeredAt);
    assert.equal(result.action, 'play');

    // No Note On may have been sent by the time we check (~80 ms in).
    await sleep(80);
    const noteOnsEarly = sent.filter(({ bytes }) => (bytes[0] & 0xf0) === 0x90);
    assert.deepEqual(noteOnsEarly.map(({ bytes }) => bytes[1]), [],
        'no note may fire before the next bar boundary');

    // ~700 ms after launch: past the bar boundary, only beat-0 (pitch 60).
    await sleep(700);
    const noteOnsAtBoundary = sent.filter(({ bytes }) => (bytes[0] & 0xf0) === 0x90);
    assert.deepEqual(noteOnsAtBoundary.map(({ bytes }) => bytes[1]), [60],
        'only the beat-0 event may have fired ~700 ms after launch');

    // Another ~400 ms later (clip phase ~1.5): pitch 62 must also be present.
    await sleep(400);
    const noteOnsAfter = sent.filter(({ bytes }) => (bytes[0] & 0xf0) === 0x90);
    assert.deepEqual(noteOnsAfter.map(({ bytes }) => bytes[1]), [60, 62],
        'beat-0 and beat-1.5 events must have fired after ~1.1 s');
});

// Regression: a filled clip triggered exactly on the transport downbeat
// (phase 0 modulo 4) must fire its beat-0 Note On immediately, not wait for
// the next bar boundary.
test('pad launch at exact downbeat fires beat-0 Note On immediately', async (t) => {
    const sent = [];
    const worker = Object.create(MIDIRouterWorker.prototype);
    // 240 BPM: one beat is 250 ms, so a 4/4 bar spans 1000 ms.
    worker.daw = new DAWEngine({ tempo: 240 });
    worker.daw.loopLenBeats = 4;
    worker.daw.tracks[0].clips[0] = {
        length: 16,
        notes: [{ channel: 1, note: 60, velocity: 90, start: 0, dur: 0.1 }],
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

    // Launch exactly on the downbeat: transport phase 0 (anchor at `now`).
    const triggeredAt = performance.now();
    worker.daw._playAnchorTime = triggeredAt;
    const result = worker._triggerPad(0, 0, triggeredAt);
    assert.equal(result.action, 'play');

    // The beat-0 Note On must arrive immediately — no full-bar wait.
    await sleep(80);
    const noteOns = sent.filter(({ bytes }) => (bytes[0] & 0xf0) === 0x90);
    assert.deepEqual(noteOns.map(({ bytes }) => bytes[1]), [60],
        'beat-0 Note On must fire immediately at an exact downbeat');
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
