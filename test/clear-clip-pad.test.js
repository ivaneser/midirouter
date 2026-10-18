import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';
import { MIDIRouterWorker } from '../worker-midi.js';

function makeWorker(daw) {
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = daw;
    worker.outputs = new Map([['pad', {}]]);
    worker.controllerEngine = {
        padMappings: () => [],
        feedbackMessagesFor: (_name, t, s, state) => [[state, t, s]],
    };
    worker._trackPlayTimers = new Map();
    worker._ledGlow = new Map();
    worker._padLedSent = new Map();
    worker._lastActivated = null;
    worker._broadcastState = () => {};
    worker._sendFeedback = (t, s, state) => { worker.sent.push([t, s, state]); };
    worker.sent = [];
    return worker;
}

test('clearing a recorded pad sends its LED to the off state', () => {
    const daw = new DAWEngine();
    daw.setSlotsPerTrack(2);
    daw.setRecordMode('none');
    daw.triggerPad(0, 0, 1000);
    daw.recordEvent(0x90, 60, 100, 1000);
    daw.recordEvent(0x80, 60, 0, 1500);
    daw.triggerPad(0, 0, 1500);
    const worker = makeWorker(daw);
    worker._padLedSent.set('0:0', 'idle');

    worker.handleDawControl({ type: 'daw_clear_clip', trackIdx: 0, slot: 0 });
    assert.equal(daw.tracks[0].clips[0].notes.length, 0);
    assert.deepEqual(worker.sent.at(-1), [0, 0, 'off']);
});
