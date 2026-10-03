import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';
import { MIDIRouterWorker } from '../worker-midi.js';

test('replace-arm count-in uses project contents from before clearing the target clip', (t) => {
    const daw = new DAWEngine({ tempo: 300 });
    daw.setMetronomeBeatsPerMeasure(1);
    daw.setRecordMode('replace');
    daw.tracks[0].clips[0].notes.push({ channel: 1, note: 60, velocity: 90, start: 0, dur: 1 });
    daw.playing = true;
    const now = performance.now();
    daw._playAnchorTime = now - 100; // half a beat; next 1-beat bar is ~100 ms away
    daw.armTrack(0);
    t.after(() => daw.stopTransport());

    daw.triggerPad(0, 0, now, { countIn: true });

    assert.ok(daw.recording.startTime <= now + 120,
        'replace-mode clearing must not turn a previously nonempty project into a two-bar count-in');
    assert.equal(daw.recording.startBeat, 0);
});

test('mapped pad Note On/Off messages reach the active recording path', (t) => {
    const daw = new DAWEngine({ tempo: 120 });
    daw.setRecordMode('replace');
    daw.armTrack(0);
    daw.triggerPad(0, 0, performance.now());
    assert.ok(daw.recording);
    daw.recording.startTime = performance.now() - 100;
    daw._countInRunning = false;
    t.after(() => daw.stopTransport());

    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = daw;
    worker.controllerEngine = {
        inputEvent: () => ({ kind: 'pad', pad: { trackIdx: 1, slot: 0 }, pressed: true, consume: true }),
    };
    worker._handleMappedPad = () => {};

    // Even though the controller path handles pad actions first, the DAW must
    // still reject any MIDI timestamp before the red Record transition.
    daw.recording.startTime = performance.now() + 100;
    worker._onIncomingMessage('Test Pad Controller', 0, [0x90, 63, 100]);
    worker._onIncomingMessage('Test Pad Controller', 0, [0x80, 63, 0]);
    assert.equal(daw.tracks[0].clips[0].notes.length, 0);

    daw.recording.startTime = performance.now() - 100;
    worker._onIncomingMessage('Test Pad Controller', 0, [0x90, 64, 100]);
    worker._onIncomingMessage('Test Pad Controller', 0, [0x80, 64, 0]);

    assert.equal(daw.tracks[0].clips[0].notes.length, 1);
    assert.equal(daw.tracks[0].clips[0].notes[0].note, 64);
    assert.equal(daw.tracks[0].clips[0].notes[0].velocity, 100);
});
