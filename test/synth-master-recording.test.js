import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { DAWEngine } from '../daw.js';
import { ClockMaster } from '../clock-master.js';
import { ExternalMidiClock } from '../external-midi-clock.js';
import { MIDIRouterWorker } from '../worker-midi.js';

const NTS = 'NTS-1 digital kit:NTS-1 digital kit _ SOUND 20:0';
const OTHER = 'Other keyboard:Other keyboard MIDI 1 28:0';

function setup(t) {
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = new DAWEngine();
    worker.daw.triggerPad(0, 0, performance.now() - 1000);
    worker.daw.playing = true;
    worker._transportPlaying = true;
    worker._clockMaster = new ClockMaster();
    worker._clockMaster.selectExternal(NTS);
    worker._externalMidiClock = new ExternalMidiClock({
        now: () => performance.now(), setTempo: bpm => worker.daw.setTempo(bpm),
    });
    worker.daw.setExternalClock(true);
    worker.inputs = new Map([[NTS, {}], [OTHER, {}]]);
    // Model a port whose MIDI callback is live while pad registration is stale.
    worker.controllerInputs = new Set();
    worker.controllerEngine = { inputEvent: () => null, profileForInput: () => null };
    worker.padMap = new Map();
    worker.outputs = new Map();
    worker._mappings = new Map();
    worker._trackPlayTimers = new Map();
    worker._scheduleExternalClockTimeout = () => {};
    worker._sendMidiClockOutputs = () => {};
    worker._broadcastState = () => {};
    t.after(() => worker.daw.stopTransport());
    return worker;
}

for (const zeroVelocityRelease of [false, true]) {
    test(`clock-master NTS-1 ribbon records without controller registration (zero-velocity release: ${zeroVelocityRelease})`, t => {
        const worker = setup(t);
        worker._onIncomingMessage(NTS, 0, [0xf8]);
        assert.equal(worker._externalMidiClock.tickCount, 1);
        worker._onIncomingMessage(NTS, 0, [0x92, 55, 64]);
        worker._onIncomingMessage(NTS, 0, [zeroVelocityRelease ? 0x92 : 0x82, 55, zeroVelocityRelease ? 0 : 64]);
        worker._onIncomingMessage(NTS, 0, [0xf8]);
        const notes = worker.daw.tracks[0].clips[0].notes;
        assert.equal(notes.length, 1);
        assert.equal(notes[0].note, 55);
        assert.equal(notes[0].velocity, 64);
        assert.equal(notes[0].channel, 3);
        assert.ok(notes[0].dur > 0);
        assert.equal(worker._externalMidiClock.tickCount, 2, 'notes must not consume or reset clock ticks');
    });
}

test('non-master notes record while only the selected master supplies timing', t => {
    const worker = setup(t);
    worker._onIncomingMessage(OTHER, 0, [0xf8]);
    assert.equal(worker._externalMidiClock.tickCount, 0);
    worker._onIncomingMessage(OTHER, 0, [0x90, 60, 90]);
    worker._onIncomingMessage(OTHER, 0, [0x80, 60, 0]);
    assert.equal(worker.daw.tracks[0].clips[0].notes[0].note, 60);
    worker._onIncomingMessage(NTS, 0, [0xf8]);
    assert.equal(worker._externalMidiClock.tickCount, 1);
});

test('clock-only NTS input does not invent notes and ribbon notes before count-in ends remain ignored', t => {
    const worker = setup(t);
    worker._onIncomingMessage(NTS, 0, [0xf8]);
    assert.equal(worker.daw.tracks[0].clips[0].notes.length, 0);
    worker.daw.recording.startTime = performance.now() + 1000;
    worker._onIncomingMessage(NTS, 0, [0x90, 55, 64]);
    worker._onIncomingMessage(NTS, 0, [0x80, 55, 64]);
    assert.equal(worker.daw.tracks[0].clips[0].notes.length, 0);
    assert.equal(worker.daw.recording.noteStarts.size, 0);
});

test('input watchdog recovers an open synth absent from controller registration and master selection', async t => {
    const worker = setup(t);
    worker._clockMaster.selectInternal();
    worker.inputs = new Map([[NTS, { _index: 0 }]]);
    const reopened = [];
    worker._reopenInput = (...args) => reopened.push(args);
    t.mock.method(childProcess.default, 'execFile', (file, args, options, callback) => {
        assert.equal(file, 'aconnect');
        queueMicrotask(() => callback(null, `client 20: 'NTS-1 digital kit' [type=kernel,card=1]\n    0 'NTS-1 digital kit _ SOUND'\n`));
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    await worker._verifyInputConnections();
    assert.deepEqual(reopened, [[NTS, 0]]);
});
