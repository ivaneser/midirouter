// Overdub mode: the initial take ends at the bar line, the clip enters the overdub
// status (loops and records new layers), and a pad press moves it to Play.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';
import { MIDIRouterWorker } from '../worker-midi.js';

function makeWorker(daw) {
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = daw;
    worker.outputs = new Map();
    worker.controllerEngine = { padMappings: () => [], feedbackMessagesFor: () => [] };
    worker._trackPlayTimers = new Map();
    worker._ledGlow = new Map();
    worker._padLedSent = new Map();
    worker._broadcastState = () => {};
    worker._emitVisualEvent = () => {};
    worker._sendFeedback = () => {};
    worker._startTrackPlayback = (track, slot) => { starts.push([track, slot]); };
    worker._stopTrackPlayback = (track) => { stops.push(track); };
    const starts = [];
    const stops = [];
    worker.starts = starts;
    worker.stops = stops;
    return worker;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('Overdub: take ends at bar line -> overdub status (recording layer, clip looping) -> pad -> Play',
    async (t) => {
        const daw = new DAWEngine({ tempo: 300 }); // 200 ms per beat
        daw.setMetronomeBeatsPerMeasure(1);        // 1-beat bar = 200 ms
        daw.setRecordMode('overdub');
        const worker = makeWorker(daw);
        t.after(() => {
            clearTimeout(worker._recordingStopTimer);
            daw.stopTransport();
            daw.setMetronome(false);
        });

        // Empty clip: count-in, recording starts
        worker._triggerPad(0, 0, performance.now());
        await wait(450);
        assert.ok(daw.recording, 'recording must start after count-in');
        daw.recordEvent(0x90, 64, 90, performance.now());
        daw.recordEvent(0x80, 64, 0, performance.now() + 60);

        // Second press: recording continues until the bar line
        assert.equal(worker._triggerPad(0, 0, performance.now()).action, 'record-stop-pending');
        assert.ok(daw.recording, 'take stays open until the bar line');
        await wait(250);

        // Bar line passed: take is kept, clip is in the overdub status
        assert.equal(daw.recording?.mode, 'overdub', 'overdub layer must be recording');
        assert.equal(daw.recording.clipWasEmpty, false);
        assert.equal(daw.clipState[0], 0, 'clip loops during overdub');
        assert.equal(daw.tracks[0].clips[0].notes.length, 1, 'initial take kept');
        assert.ok(worker.starts.some(([tr, sl]) => tr === 0 && sl === 0), 'clip playback started');

        // A note played in the overdub status is added as a layer
        daw.recordEvent(0x90, 67, 90, performance.now());
        daw.recordEvent(0x80, 67, 0, performance.now() + 60);
        assert.equal(daw.tracks[0].clips[0].notes.length, 2, 'layer note recorded');

        // Pad press: overdub ends at the bar line, clip moves to Play (keeps looping)
        const stopsBefore = worker.stops.length;
        assert.equal(worker._triggerPad(0, 0, performance.now()).action, 'record-stop-pending');
        await wait(250);
        assert.equal(daw.recording, null, 'overdub layer finished at bar line');
        assert.equal(daw.clipState[0], 0, 'clip is in Play (looping)');
        assert.equal(daw.tracks[0].clips[0].notes.length, 2, 'both notes kept');
        assert.ok(daw.tracks[0].clips[0].length >= 1);
        assert.equal(worker.stops.length, stopsBefore, 'playback must not be stopped');
    });
