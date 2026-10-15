import test from 'node:test';
import assert from 'node:assert/strict';
import { MIDIRouterWorker } from '../worker-midi.js';
import { DAWEngine } from '../daw.js';

test('external-clock pad launch waits for the clip start phase and loops on the clip\'s own length', () => {
    const sent = [];
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = new DAWEngine({ tempo: 120 });
    worker.daw.loopLenBeats = 4;
    // Phase 0 = the clip was recorded from the start of the cycle.
    worker.daw.tracks[0].clips[0] = {
        length: 16,
        phase: 0,
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
    worker.audioLatencyMs = 0; // exact-tick timing; latency has its own test
    worker._externalMidiClock = { tickCount: 36 };
    const ons = () => sent.filter((bytes) => (bytes[0] & 0xf0) === 0x90).map((bytes) => bytes[1]);

    const result = worker._triggerPad(0, 0, performance.now());
    assert.equal(result.action, 'play');
    // Launched at tick 36 (beat 1.5 of the 4-beat cycle): the clip starts at its
    // phase, which is cycle beat 0 = tick 96. Nothing fires before that.
    worker._tickExternalClipPlayback(36);
    assert.deepEqual(ons(), [], 'nothing fires before the clip start phase');
    worker._tickExternalClipPlayback(96);
    assert.deepEqual(ons(), [60], 'the clip starts at its phase (beat 0 of the cycle)');
    worker._tickExternalClipPlayback(132);
    assert.deepEqual(ons(), [60, 62], 'beat 1.5 of the clip is 36 ticks later');
    // The clip repeats on its own 16-beat length (384 ticks), not on the 4-beat cycle.
    worker._tickExternalClipPlayback(96 + 384);
    assert.deepEqual(ons(), [60, 62, 60], 'the clip repeats after its own length');
    worker._stopTrackPlayback(0);
});

test('skipped F8 ticks must not leave pending note-offs hanging forever', () => {
    const sent = [];
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = new DAWEngine({ tempo: 120 });
    worker.daw.loopLenBeats = 4;
    worker.daw.tracks[0].clips[0] = {
        length: 16,
        notes: [
            { channel: 1, note: 60, velocity: 90, start: 0, dur: 0.25 },
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
    worker.audioLatencyMs = 0; // exact-tick timing; latency has its own test
    worker._externalMidiClock = { tickCount: 0 };

    // Start playback at tick 0 so the clip is anchored to the shared cycle.
    worker._startTrackPlayback(0, 0, performance.now());
    assert.equal(worker._trackPlayTimers.size, 1);

    // The note-on fires at localTick 0 (tickCount 0), with its note-off
    // scheduled for tick 6 (24PPQN * 0.25s). Advance to that exact tick.
    worker._tickExternalClipPlayback(0);
    sent.length = 0; // ignore the starter note-on, only count off events below

    worker._tickExternalClipPlayback(6);
    const afterScheduledOff = sent.filter((bytes) => (bytes[0] & 0xf0) === 0x80).length;
    assert.equal(afterScheduledOff, 1, 'note-off must fire at its scheduled tick');

    // Reset and replay the same clip so we can demonstrate the skip scenario.
    sent.length = 0;
    worker._stopTrackPlayback(0);
    worker._startTrackPlayback(0, 0, performance.now());
    const playback2 = worker._trackPlayTimers.get(0);

    // Fire tick 0 so the note-on (and its off at tick 6) gets queued again.
    worker._tickExternalClipPlayback(0);
    sent.length = 0;

    // Advance far past the scheduled note-off (loop grid is the clip's own
    // 16-beat length = 384 ticks) without firing any note-ons in between.
    // Under the buggy code `_tickExternalClipPlayback`
    // only looks up `playback.pendingNoteOffs.get(tick)` for the exact tick
    // value and deletes that single entry: a note-off scheduled for a tick
    // that was jumped over stays stuck in the Map forever -> hanging note.
    worker._tickExternalClipPlayback(96 + 16);

    const firedNoteOffs = sent.filter((bytes) => (bytes[0] & 0xf0) === 0x80).length;
    assert.equal(firedNoteOffs, 1,
        'the note-off for a tick passed over by a skip must still be released exactly once');
    assert.ok(
        !playback2.pendingNoteOffs.get(6),
        'that note-off must no longer remain pending after release',
    );
    worker._stopTrackPlayback(0);
});

test('audio latency offset shifts external-clock note-ons earlier by the same amount', () => {
    const sent = [];
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = new DAWEngine({ tempo: 120 }); // 500 ms per beat = 24 ticks
    worker.daw.loopLenBeats = 4;
    worker.daw.tracks[0].clips[0] = {
        length: 16,
        notes: [{ channel: 1, note: 62, velocity: 90, start: 1.5, dur: 0.25 }],
    };
    worker.daw.setRecordMode('none');
    worker.outputs = new Map([['test-synth', { sendMessage: (bytes) => sent.push([...bytes]) }]]);
    worker.controllerEngine = { isExcludedOutput: () => false };
    worker._trackPlayTimers = new Map();
    worker._ledGlow = new Map();
    worker._sendFeedback = () => {};
    worker._broadcastState = () => {};
    worker._clearStaleRecordingFeedback = () => {};
    worker._externalClockActive = true;
    worker.audioLatencyMs = 60; // 60 ms = 2.88 ticks -> 3 ticks earlier
    worker._externalMidiClock = { tickCount: 0 };

    worker._startTrackPlayback(0, 0, performance.now());
    // Beat 1.5 = tick 36, so the note-on must fire at tick 33, not 36.
    worker._tickExternalClipPlayback(32);
    assert.equal(sent.filter((b) => (b[0] & 0xf0) === 0x90).length, 0);
    worker._tickExternalClipPlayback(33);
    assert.equal(sent.filter((b) => (b[0] & 0xf0) === 0x90).length, 1);
    worker._stopTrackPlayback(0);
});
