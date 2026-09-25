import test from 'node:test';
import assert from 'node:assert/strict';
import { MIDIRouterWorker } from '../worker-midi.js';
import { DAWEngine } from '../daw.js';

test('external-clock pad launch follows the shared cycle phase, not clip start', () => {
    const sent = [];
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = new DAWEngine({ tempo: 120 });
    worker.daw.loopLenBeats = 4;
    worker.daw.tracks[0].clips[0] = {
        length: 16,
        notes: [
            { channel: 1, note: 60, velocity: 90, start: 0, dur: 0.25 },
            { channel: 1, note: 62, velocity: 90, start: 1.5, dur: 0.25 },
        ],
    };
    worker.daw.setRecordMode('none');
    worker.outputs = new Map([['test-synth', {
        sendMessage: (bytes) => sent.push([...bytes]),
    }]]);
    worker.controllerEngine = { isExcludedOutput: () => false };
    worker._trackPlayTimers = new Map();
    worker._ledGlow = new Map();
    worker._sendFeedback = () => {};
    worker._broadcastState = () => {};
    worker._clearStaleRecordingFeedback = () => {};
    worker._externalClockActive = true;
    worker._externalMidiClock = { tickCount: 36 };

    const result = worker._triggerPad(0, 0, performance.now());
    assert.equal(result.action, 'play');
    worker._tickExternalClipPlayback(36);
    assert.deepEqual(sent.filter((bytes) => (bytes[0] & 0xf0) === 0x90).map((bytes) => bytes[1]), [62],
        'note at beat 1.5 is due on the current transport tick; beat-0 note is not');

    worker._tickExternalClipPlayback(96);
    assert.deepEqual(sent.filter((bytes) => (bytes[0] & 0xf0) === 0x90).map((bytes) => bytes[1]), [62, 60],
        'beat-0 note is due at the next shared-cycle boundary');
    worker._stopTrackPlayback(0);
});
