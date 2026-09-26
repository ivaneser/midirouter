import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DAWEngine, noteOn, noteOff } from '../daw.js';
import { ControllerEngine } from '../controller-engine.js';

const profiles = ControllerEngine.fromDirectory(fileURLToPath(new URL('../controller_profiles', import.meta.url)));

test('Launchkey profile routes both Session rows and targets its DAW output', () => {
    const input = 'Launchkey Mini MK3 DAW Port';
    const bottom = profiles.inputEvent(input, [0x90, 112, 100]);
    const top = profiles.inputEvent(input, [0x90, 96, 100]);
    assert.deepEqual([bottom.pad.trackIdx, bottom.pad.slot], [0, 0]);
    assert.deepEqual([top.pad.trackIdx, top.pad.slot], [0, 1]);
    assert.equal(profiles.inputEvent(input, [0x80, 96, 0]).pressed, false);
    assert.equal(profiles.inputEvent(input, [0xbf, 115, 127]).action, 'play');
    assert.equal(profiles.inputEvent(input, [0xbf, 21, 64]).consume, false);
    assert.equal(profiles.inputEvent('Launchkey Mini MK3 MIDI Port', [0x90, 60, 100]), null);
    assert.equal(profiles.isExcludedOutput('Launchkey Mini MK3 MIDI Port'), true);
    assert.deepEqual(profiles.initMessagesFor(input), [[159, 12, 127], [182, 29, 2]]);
    assert.deepEqual(profiles.feedbackMessagesFor(input, 0, 1, 'playing'), [[145, 96, 37]]);
    assert.deepEqual(profiles.feedbackMessagesFor('Craft Synth', 0, 1, 'playing'), []);
    assert.equal(profiles.inputEvent('nanoPAD2 MIDI 1', [0x90, 36, 100]), null);
});

test('profiles scope identical note numbers to their own input port', () => {
    const engine = new ControllerEngine([
        { id: 'one', input: { exact: 'Controller One' }, pads: [
            { message: 'note', channel: 1, numbers: [36], trackStart: 0, slot: 0 }] },
        { id: 'two', input: { exact: 'Controller Two' }, pads: [
            { message: 'note', channel: 1, numbers: [36], trackStart: 4, slot: 1 }] },
    ]);
    assert.equal(engine.inputEvent('Controller One', [144, 36, 90]).pad.trackIdx, 0);
    assert.equal(engine.inputEvent('Controller Two', [144, 36, 90]).pad.trackIdx, 4);
});

test('feedback templates can emit CC or SysEx with pad indices', () => {
    const engine = new ControllerEngine([{ id: 'rgb', input: { exact: 'RGB In' },
        pads: [{ message: 'cc', channel: 10, numbers: [20], trackStart: 0, slot: 0, indexStart: 7 }],
        feedback: { output: { exact: 'RGB Out' }, states: {
            playing: [240, 0, 32, 41, '$index', 37, 247], off: [185, '$number', 0],
        } } }]);
    assert.equal(engine.inputEvent('RGB In', [185, 20, 127]).kind, 'pad');
    assert.deepEqual(engine.feedbackMessagesFor('RGB Out', 0, 0, 'playing'), [[240, 0, 32, 41, 7, 37, 247]]);
    assert.deepEqual(engine.feedbackMessagesFor('RGB Out', 0, 0, 'off'), [[185, 20, 0]]);
});

test('SysEx input pads use configured data positions', () => {
    const engine = new ControllerEngine([{ id: 'sysex-pad', input: { exact: 'Grid In' },
        pads: [{ message: 'sysex', prefix: [240, 0, 32], numberByte: 3, valueByte: 4,
            numbers: [7], trackStart: 2, slot: 0 }] }]);
    const down = engine.inputEvent('Grid In', [240, 0, 32, 7, 64, 247]);
    const up = engine.inputEvent('Grid In', [240, 0, 32, 7, 0, 247]);
    assert.deepEqual([down.kind, down.pad.trackIdx, down.pressed], ['pad', 2, true]);
    assert.equal(up.pressed, false);
});

test('Program Change pads fire from two-byte messages', () => {
    const engine = new ControllerEngine([{ id: 'program-pad', input: { exact: 'Program In' },
        pads: [{ message: 'program', channel: 2, numbers: [8], trackStart: 3, slot: 0 }] }]);
    const event = engine.inputEvent('Program In', [0xc1, 8]);
    assert.deepEqual([event.kind, event.pressed, event.pad.trackIdx], ['pad', true, 3]);
    assert.equal(engine.inputEvent('Program In', [0xc0, 8]).consume, true);
});

test('invalid controller profiles fail validation', () => {
    assert.throws(() => new ControllerEngine([{ id: 'bad', input: { exact: 'Bad' },
        pads: [{ message: 'note', channel: 17, numbers: [36], trackStart: 0, slot: 0 }] }]));
});

test('a held note records quarter-note timing, velocity and MIDI channel', () => {
    const daw = new DAWEngine();
    assert.equal(daw.slotsPerTrack, 2);
    daw.setRecordMode('replace');
    assert.equal(daw.triggerPad(0, 1, 1000).action, 'record');
    daw.recordEvent(0x90, 60, 103, 1000);
    daw.recordEvent(0x80, 60, 0, 1500);
    assert.equal(daw.triggerPad(0, 1, 1500).action, 'record-stop');
    const note = daw.tracks[0].clips[1].notes[0];
    assert.deepEqual(note, { channel: 1, note: 60, velocity: 103, start: 0, dur: 1 });
    assert.deepEqual(noteOn(note.channel - 1, note.note, note.velocity), [0x90, 60, 103]);
    assert.deepEqual(noteOff(note.channel - 1, note.note), [0x80, 60, 0]);
    assert.equal(daw.clipState[0], 1);
});

test('empty and out-of-range clips cannot enter playing state', () => {
    const daw = new DAWEngine();
    assert.equal(daw.triggerPad(0, 0, 0).action, 'empty');
    assert.equal(daw.triggerPad(0, 2, 0).action, 'invalid');
    assert.equal(daw.clipState[0], -1);
});

test('finalizing a held note preserves a sounding velocity', () => {
    const daw = new DAWEngine();
    daw.setRecordMode('replace');
    daw.triggerPad(0, 0, 1000);
    daw.recordEvent(0x90, 64, 90, 1000);
    daw.triggerPad(0, 0, 1100);
    assert.equal(daw.tracks[0].clips[0].notes[0].velocity, 90);
});

// Rec Arm contract: a reset must wipe EVERY clip on EVERY track/slot back to
// zero (no notes, whole-bar minimum length), drop any playing state, and stop
// an in-flight recording — leaving the engine ready for a brand-new take.
test('resetAllClips wipes every clip and recording state to zero', () => {
    const daw = new DAWEngine();
    daw.setSlotsPerTrack(2);

    // Record real notes into two different tracks/slots so the reset has
    // something to clear.
    daw.setRecordMode('replace');
    daw.triggerPad(0, 0, 1000); // track 0 / slot 0
    daw.recordEvent(0x90, 60, 100, 1000);
    daw.recordEvent(0x80, 60, 0, 1500);
    daw.triggerPad(0, 0, 1500); // finalize -> playing state in slot 0
    daw.triggerPad(3, 1, 2000); // arm record into track 3 / slot 1
    daw.recordEvent(0x90, 64, 90, 2000);
    daw.recordEvent(0x80, 64, 0, 2500);
    daw.triggerPad(3, 1, 2500); // finalize -> playing state in slot 1

    assert.ok(daw.tracks[0].clips[0].notes.length > 0, 'precondition: slot (0,0) has notes');
    assert.ok(daw.tracks[3].clips[1].notes.length > 0, 'precondition: slot (3,1) has notes');
    assert.equal(daw.clipState[0], 0, 'precondition: track 0 is playing');
    assert.equal(daw.clipState[3], 1, 'precondition: track 3 is playing');

    // Start a fresh in-flight recording to prove reset also stops it.
    daw.triggerPad(1, 0, 3000);
    assert.ok(daw.recording, 'precondition: an in-flight recording is active');

    daw.resetAllClips();

    assert.equal(daw.recording, null, 'reset must stop any in-flight recording');
    for (let t = 0; t < 16; t++) {
        for (let s = 0; s < 2; s++) {
            const clip = daw.tracks[t].clips[s];
            assert.deepEqual(clip.notes, [], `clip (${t},${s}) must have no notes`);
            assert.equal(clip.length, 4, `clip (${t},${s}) must be back to one whole bar`);
            assert.equal(daw.clipState[t], -1, `track ${t} must be stopped`);
        }
    }

    // After a reset, triggering an empty pad must report 'record' again (armed
    // replace mode), i.e. the engine is ready for a brand-new take.
    daw.setRecordMode('replace');
    assert.equal(daw.triggerPad(0, 0, 4000).action, 'record');
    daw.triggerPad(0, 0, 4100); // stop the fresh recording so state stays clean
});
