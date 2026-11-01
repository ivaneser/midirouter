import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';
import { MIDIRouterWorker } from '../worker-midi.js';

test('overdub-arm count-in uses project contents from before arming the target clip', (t) => {
    const daw = new DAWEngine({ tempo: 300 });
    daw.setMetronomeBeatsPerMeasure(1);
    daw.setRecordMode('overdub');
    daw.tracks[0].clips[0].notes.push({ channel: 1, note: 60, velocity: 90, start: 0, dur: 1 });
    daw.playing = true;
    const now = performance.now();
    daw._playAnchorTime = now - 100; // half a beat; next 1-beat bar is ~100 ms away
    daw.armTrack(0);
    t.after(() => daw.stopTransport());

    daw.triggerPad(0, 0, now, { countIn: true });

    assert.ok(daw.recording.startTime <= now + 120,
        'arming a layer on a nonempty project must not turn it into a two-bar count-in');
    assert.equal(daw.recording.startBeat, 0);
});

test('a mapped clip pad launches clips only: its Note On/Off is never recorded as a note', (t) => {
    const daw = new DAWEngine({ tempo: 120 });
    daw.setRecordMode('none');
    daw.armTrack(0);
    daw.triggerPad(0, 0, performance.now());
    assert.ok(daw.recording);
    daw.recording.startTime = performance.now() - 100;
    daw._countInRunning = false;
    t.after(() => daw.stopTransport());

    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = daw;
    worker._trackPlayTimers = new Map();
    worker._clockMaster = { source: null, activeOutputs: [] };
    worker.controllerEngine = {
        inputEvent: () => ({ kind: 'pad', pad: { trackIdx: 1, slot: 0 }, pressed: true, consume: true }),
    };
    const pressed = [];
    worker._handleMappedPad = (pad, velocity) => pressed.push([pad, velocity]);

    worker._onIncomingMessage('Test Pad Controller', 0, [0x90, 64, 100]);
    worker._onIncomingMessage('Test Pad Controller', 0, [0x80, 64, 0]);

    assert.equal(pressed.length, 2, 'the pad still launches clips');
    assert.equal(daw.tracks[0].clips[0].notes.length, 0, 'but is not recorded as a note');
});
