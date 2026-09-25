import test from 'node:test';
import assert from 'node:assert/strict';
import { MIDIRouterWorker } from '../worker-midi.js';
import { DAWEngine } from '../daw.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('internal-clock pad launch inherits transport phase and wraps on the shared cycle', async (t) => {
    const sent = [];
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = new DAWEngine({ tempo: 120 });
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

    const triggeredAt = performance.now();
    worker.daw._playAnchorTime = triggeredAt - 750;
    const result = worker._triggerPad(0, 0, triggeredAt);
    assert.equal(result.action, 'play');

    await sleep(80);
    const noteOnsAtLaunch = sent.filter(({ bytes }) => (bytes[0] & 0xf0) === 0x90);
    assert.deepEqual(noteOnsAtLaunch.map(({ bytes }) => bytes[1]), [62],
        'phase-1.5 event plays at launch; phase-0 event must wait for global wrap');

    await sleep(1500);
    const noteOnsAfterWrap = sent.filter(({ bytes }) => (bytes[0] & 0xf0) === 0x90);
    assert.deepEqual(noteOnsAfterWrap.map(({ bytes }) => bytes[1]), [62, 60],
        'phase-0 event plays when the shared 4-beat cycle wraps');
});
