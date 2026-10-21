import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';
import { MIDIRouterWorker } from '../worker-midi.js';

function workerFor(offset, external = false) {
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = new DAWEngine({ tempo: 120 });
    worker.audioOffsetMs = offset;
    worker.daw.getAudioOffsetMs = () => worker.audioOffsetMs;
    worker._externalClockActive = external;
    worker._externalMidiClock = { tickCount: 96 };
    worker._trackPlayTimers = new Map();
    worker._ledGlow = new Map();
    worker._refreshPadLeds = () => {};
    worker._syncPadClock = () => {};
    worker._clearStaleRecordingFeedback = () => {};
    worker._broadcastState = () => {};
    worker.sent = [];
    worker._sendToSynthOutputs = bytes => worker.sent.push([...bytes]);
    return worker;
}

for (const offset of [-120, 0, 120]) {
    test(`recording and held-note closure preserve clip position with shift ${offset} ms`, t => {
        const daw = new DAWEngine({ tempo: 120 });
        t.after(() => daw.stopTransport());
        daw.getAudioOffsetMs = () => offset;
        daw.playing = true;
        daw._globalCycleLocked = true;
        const base = performance.now();
        daw._playAnchorTime = base;
        daw.armRecording(0, 0, base + 2000 + offset);
        daw.recordEvent(0x90, 60, 90, base + 3000 + offset);
        daw.recordEvent(0x80, 60, 0, base + 3250 + offset);
        daw.recordEvent(0x90, 64, 90, base + 3500 + offset);
        daw._stopRecording(8, true);
        assert.deepEqual(daw.tracks[0].clips[0].notes.map(n => [n.start, n.dur]), [[2, 0.5], [3, 1]]);
    });

    test(`finished take starts playback at the shifted boundary (${offset} ms)`, t => {
        const worker = workerFor(offset);
        const { daw } = worker;
        const tasks = [];
        t.mock.method(globalThis, 'setTimeout', (fn, delay) => {
            const task = { fn, delay };
            tasks.push(task);
            return task;
        });
        t.mock.method(globalThis, 'clearTimeout', () => {});
        daw.playing = true;
        daw._globalCycleLocked = true;
        daw.loopLenBeats = 16; // A long global cycle must not delay the handoff.
        const base = performance.now() - 2100;
        daw._playAnchorTime = base;
        daw.armRecording(0, 0, base + 2000 + offset);
        daw.recordEvent(0x90, 60, 90, base + 2000 + offset);
        daw.recordEvent(0x80, 60, 0, base + 2125 + offset);
        worker.quantizeGrid = 0;
        worker._scheduleRecordingStop({ now: base + 2500 + offset });
        // Simulate the stop callback at its intended wall-clock boundary.
        t.mock.method(performance, 'now', () => base + 4000 + offset);
        tasks.shift().fn();
        assert.equal(daw.recording, null);
        assert.equal(daw.clipState[0], 0);
        assert.ok(worker._trackPlayTimers.has(0));
        assert.ok(tasks[0].delay < 1, `opening note must be due immediately, got ${tasks[0].delay}`);
        tasks.shift().fn();
        assert.deepEqual(worker.sent[0], [0x90, 60, 90]);
        const repeatedOn = tasks.at(-1);
        assert.ok(Math.abs(repeatedOn.delay - 2000) < 0.001, 'the next pass keeps the same shifted origin');
        const noteOff = tasks[0];
        assert.equal(noteOff.delay, 125, 'shift does not change note duration');
    });
}

test('external clock: an advanced opening note sounds on handoff and early on the next pass', () => {
    const worker = workerFor(-125, true); // six ticks at 120 BPM
    worker.daw.tracks[0].clips[0] = {
        length: 4, notes: [{ channel: 1, note: 60, velocity: 90, start: 0, dur: 0.25 }],
    };
    // Finish at wall clock now: the grid boundary is 125 ms later.
    worker._startTrackPlayback(0, 0, performance.now() + 125, { immediate: true });
    const ons = () => worker.sent.filter(bytes => bytes[0] === 0x90);
    assert.equal(ons().length, 1, 'opening note must not wrap to the end of the first loop');
    worker._tickExternalClipPlayback(96);
    assert.equal(ons().length, 1, 'same tick must not retrigger a note');
    worker._tickExternalClipPlayback(102);
    assert.deepEqual(worker.sent.at(-1), [0x80, 60, 0]);
    worker._tickExternalClipPlayback(191);
    assert.equal(ons().length, 1);
    worker._tickExternalClipPlayback(192);
    assert.equal(ons().length, 2, 'second pass retains the six-tick advance');
    worker._stopTrackPlayback(0);
});

test('pending launch prepares the scheduler early enough for a negative shift', t => {
    const worker = workerFor(-120);
    let task;
    t.mock.method(globalThis, 'setTimeout', (fn, delay) => (task = { fn, delay }));
    let launch;
    worker._startTrackPlayback = (...args) => { launch = args; };
    worker._schedulePendingStart(0, 0, 2000, 500);
    assert.equal(task.delay, 380);
    task.fn();
    assert.deepEqual(launch, [0, 0, 2000, { immediate: true }]);
});

test('late count-in completion preserves the calibrated recording boundary', t => {
    const worker = workerFor(-120);
    const base = performance.now();
    worker.daw.playing = true;
    worker.daw._playAnchorTime = base;
    worker.daw.armRecording(0, 0, base - 120, { countIn: true });
    t.after(() => worker.daw.stopTransport());
    const scheduledStart = worker.daw.recording.startTime;
    t.mock.method(performance, 'now', () => scheduledStart + 50);
    worker._handleCountInComplete();
    assert.equal(worker.daw.recording.startTime, scheduledStart);
    assert.equal(worker.daw._playAnchorTime, scheduledStart);
    worker.daw.recordEvent(0x90, 60, 90, scheduledStart - 120);
    worker.daw.recordEvent(0x80, 60, 0, scheduledStart + 130);
    assert.equal(worker.daw.recording.notes[0].start, 0);
});
