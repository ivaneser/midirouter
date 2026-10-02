import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DAWEngine, noteOn, noteOff } from '../daw.js';
import { ControllerEngine } from '../controller-engine.js';
import { MIDIRouterWorker } from '../worker-midi.js';

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
    // Replace-режим: после остановки клип остаётся остановленным (дубль сохранён)
    assert.equal(daw.triggerPad(0, 1, 1500).action, 'record-stop-stopped');
    const note = daw.tracks[0].clips[1].notes[0];
    assert.deepEqual(note, { channel: 1, note: 60, velocity: 103, start: 0, dur: 1 });
    assert.deepEqual(noteOn(note.channel - 1, note.note, note.velocity), [0x90, 60, 103]);
    assert.deepEqual(noteOff(note.channel - 1, note.note), [0x80, 60, 0]);
    assert.equal(daw.clipState[0], -1);
});

test('empty pad always starts recording (any Mode); out-of-range is invalid', () => {
    const daw = new DAWEngine();
    // Пустой клип в Play-режиме — тоже запись (по умолчанию)
    assert.equal(daw.triggerPad(0, 0, 0).action, 'record');
    assert.equal(daw.triggerPad(0, 2, 0).action, 'invalid');
    assert.equal(daw.clipState[0], -1, 'recording never puts the clip into playing state');
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
    daw.triggerPad(0, 0, 1000); // track 0 / slot 0 — empty pad starts recording
    daw.recordEvent(0x90, 60, 100, 1000);
    daw.recordEvent(0x80, 60, 0, 1500);
    daw.setRecordMode('none');
    daw.triggerPad(0, 0, 1500); // finalize in Play mode -> playing state in slot 0
    daw.triggerPad(3, 1, 2000); // empty pad -> record into track 3 / slot 1
    daw.recordEvent(0x90, 64, 90, 2000);
    daw.recordEvent(0x80, 64, 0, 2500);
    daw.triggerPad(3, 1, 2500); // finalize in Play mode -> playing state in slot 1

    assert.ok(daw.tracks[0].clips[0].notes.length > 0, 'precondition: slot (0,0) has notes');
    assert.ok(daw.tracks[3].clips[1].notes.length > 0, 'precondition: slot (3,1) has notes');
    assert.equal(daw.clipState[0], 0, 'precondition: track 0 is playing');
    assert.equal(daw.clipState[3], 1, 'precondition: track 3 is playing');

    // Start a fresh in-flight recording to prove reset also stops it.
    daw.triggerPad(1, 0, 3000);
    assert.ok(daw.recording, 'precondition: an in-flight recording is active');

    daw.resetAllClips();

    assert.equal(daw.recording, null, 'reset must stop any in-flight recording');
    for (let t = 0; t < 8; t++) {
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

test('starting a new recording sends the previous playing clip back to pulse', () => {
    const sent = [];
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = new DAWEngine({ tempo: 120 });
    worker.daw.tracks[0].clips[0].notes.push({ channel: 1, note: 60, velocity: 90, start: 0, dur: 0.25 });
    worker.daw.clipState[0] = 0;
    worker.daw.setRecordMode('none');
    worker.outputs = new Map([['Launchkey Mini MK3 DAW Port', {
        sendMessage: (bytes) => sent.push(Array.from(bytes)),
    }]]);
    worker.controllerEngine = ControllerEngine.fromDirectory(
        fileURLToPath(new URL('../controller_profiles', import.meta.url)));
    worker._trackPlayTimers = new Map();
    worker._ledGlow = new Map([[0, { trackIdx: 0, slot: 0, state: 'playing' }]]);
    worker._padLedSent = new Map();
    worker._lastActivated = { trackIdx: 0, slot: 0 };
    worker._broadcastState = () => {};
    worker._syncPadClock = () => {};

    worker._refreshPadLeds(0, 0);
    sent.length = 0;
    const result = worker._triggerPad(0, 1, 1000);

    assert.equal(result.action, 'record');
    assert.equal(worker.daw.recording.slot, 1);
    assert.equal(worker.daw.clipState[0], -1);
    assert.deepEqual(sent, [[0x91, 96, 5], [0x92, 112, 37]],
        'previous clip must pulse when the new slot enters recording');
    worker.daw.stopTransport();
});

test('a track locks to its first recorded MIDI channel for later clips', () => {
    const daw = new DAWEngine({ tempo: 120 });
    daw.triggerPad(0, 0, 1000);
    daw.recordEvent(0x94, 60, 90, 1000); // channel 5
    daw.recordEvent(0x84, 60, 0, 1500);
    daw.triggerPad(0, 0, 1600);
    assert.equal(daw.tracks[0].channel, 5);
    assert.equal(daw.tracks[0].channelAssigned, true);

    daw.triggerPad(0, 1, 2000);
    daw.recordEvent(0x99, 64, 80, 2000); // channel 10 is mapped to locked channel 5
    daw.recordEvent(0x89, 64, 0, 2500);
    assert.equal(daw.tracks[0].clips[1].notes[0].channel, 5);
});

test('Session Record toggles without erasing clips and arms the metronome', () => {
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = new DAWEngine();
    worker.daw.tracks[0].clips[0].notes.push({
        channel: 1, note: 60, velocity: 90, start: 0, dur: 1,
    });
    worker._transportPlaying = false;
    worker._externalClockActive = false;
    worker._trackPlayTimers = new Map();
    worker._syncPadClock = () => {};
    worker._broadcastState = () => {};
    const existingNotes = [...worker.daw.tracks[0].clips[0].notes];

    worker.handleDawControl({ type: 'daw_toggle_session_record' });
    assert.equal(worker.daw.sessionRecording, true);
    assert.equal(worker.daw._metronomeEnabled, true);
    assert.deepEqual(worker.daw.tracks[0].clips[0].notes, existingNotes);

    worker.handleDawControl({ type: 'daw_toggle_session_record' });
    assert.equal(worker.daw.sessionRecording, false);
    assert.deepEqual(worker.daw.tracks[0].clips[0].notes, existingNotes);
    worker.daw.stopTransport();
});

test('DAW metronome lifecycle reports start, stop, tempo, and meter to its audio backend', () => {
    const daw = new DAWEngine();
    const events = [];
    daw._onMetronomeStart = (bpm, beats) => events.push(['start', bpm, beats]);
    daw._onMetronomeStop = () => events.push(['stop']);
    daw._onMetronomeTempo = (bpm) => events.push(['tempo', bpm]);
    daw._onMetronomeMeter = (beats) => events.push(['meter', beats]);

    daw.setTempo(96);
    daw.setMetronomeBeatsPerMeasure(3);
    daw.setMetronome(true);
    daw.setMetronome(false);

    assert.deepEqual(events, [
        ['tempo', 96], ['meter', 3], ['start', 96, 3], ['stop'],
    ]);
});

test('daw_stop_transport finalizes an in-flight recording before clearing transport state', () => {
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = new DAWEngine({ tempo: 120 });
    worker._trackPlayTimers = new Map();
    worker._refreshPadLeds = () => {};
    worker._syncPadClock = () => {};
    worker._broadcastState = () => {};
    const t0 = performance.now();
    worker.daw.setRecordMode('replace');
    worker.daw.triggerPad(0, 0, t0); // start recording on track 0 / slot 0
    assert.ok(worker.daw.recording, 'precondition: an in-flight recording is active');
    worker.daw.recordEvent(0x90, 60, 90, t0 + 100); // hold a note open

    const result = worker.handleDawControl({ type: 'daw_stop_transport' });

    assert.equal(result, undefined, 'handleDawControl returns no value for transport stops');
    assert.equal(worker.daw.recording, null, 'recording must be finalized by daw_stop_transport');
    const note = worker.daw.tracks[0].clips[0].notes[0];
    assert.equal(note.channel, 1);
    assert.equal(note.note, 60);
    assert.equal(note.velocity, 90);
    assert.equal(note.dur, 0.25);
    // Note Off закрывает ноту: start/dur хранятся с точностью до сотых бита.
    assert.deepEqual({ start: note.start, dur: note.dur }, { start: 0.2, dur: 0.25 });
});

// When two Note Ons on the same channel and pitch arrive while recording,
// they must be paired FIFO — each Note Off consumes the oldest unmatched On.
// Because MIDI Note Offs carry no per-note identity, repeated identical pitch/
// channel starts should produce separate recorded notes (not overwrite).
test('overlapping same-channel same-pitch Note Ons are paired FIFO', () => {
    const daw = new DAWEngine({ tempo: 120 }); // 500 ms per beat
    daw.setRecordMode('replace');
    daw.armTrack(0);

    // Stub _beatAt so musical offsets are deterministic and independent of
    // wall-clock time. The mutable holder lets us set the exact beat value
    // that recordEvent observes for each injected event.
    const beatHolder = { beat: 0 };
    daw._beatAt = () => beatHolder.beat;

    // Trigger pad at a fake anchor. The two-bar count-in pushes startTime into
    // the future; overwrite it so injected events (sent after tAnchor) are
    // accepted by the `now < recording.startTime` guard in recordEvent.
    const tAnchor = performance.now() - 3000;
    daw.triggerPad(0, 0, tAnchor);
    assert.ok(daw.recording, 'precondition: an in-flight recording is active');
    // Align startTime to the synthetic timeline so _beatAt stub and FIFO logic
    // work correctly without depending on wall-clock time.
    daw.recording.startTime = tAnchor - 100;

    // Inject two Note Ons at beat 0.5 and 1.0 (same channel 1, pitch 60).
    beatHolder.beat = 0.5;
    daw.recordEvent(0x90, 60, 100, tAnchor + 3000); // first On at beat 0.5

    beatHolder.beat = 1.0;
    daw.recordEvent(0x90, 60, 127, tAnchor + 3500); // second On at beat 1.0

    // Inject two Note Offs at beat 1.5 and 2.0.
    beatHolder.beat = 1.5;
    daw.recordEvent(0x80, 60, 0, tAnchor + 3750);   // first Off -> closes On@0.5

    beatHolder.beat = 2.0;
    daw.recordEvent(0x80, 60, 0, tAnchor + 4000);   // second Off -> closes On@1.0

    // Finalize any remaining open notes (none in this scenario, but verify the
    // finalization path doesn't crash and that noteStarts is emptied).
    daw.triggerPad(0, 0, tAnchor + 4500);

    const clip = daw.tracks[0].clips[0];
    assert.equal(daw.recording, null, 'recording must be finalized');
    assert.equal(clip.notes.length, 2, 'must record two notes from FIFO-paired starts');

    // First note: start=0.5 dur=1.0 (beat 1.5 - beat 0.5)
    const n0 = clip.notes[0];
    assert.deepEqual({ channel: n0.channel, note: n0.note, velocity: n0.velocity, start: n0.start },
        { channel: 1, note: 60, velocity: 100, start: 0.5 });

    // Second note: start=1.0 dur=1.0 (beat 2.0 - beat 1.0)
    const n1 = clip.notes[1];
    assert.deepEqual({ channel: n1.channel, note: n1.note, velocity: n1.velocity, start: n1.start },
        { channel: 1, note: 60, velocity: 127, start: 1.0 });

    // Verify durations (both should be 1.0 beat).
    assert.equal(n0.dur, 1.0, 'first note duration = beat 1.5 - beat 0.5');
    assert.equal(n1.dur, 1.0, 'second note duration = beat 2.0 - beat 1.0');

    // Verify no open starts remain after finalization.
    assert.ok(clip.notes.length === 2 && daw.tracks[0].clips[0] !== undefined);
});


// Stored note timing is rounded to the nearest hundredth of a beat whenever a
// Note Off closes a note during recording — including non-exact timestamps.
test('note off rounds stored start and duration to two decimal places', () => {
    const daw = new DAWEngine({ tempo: 120 }); // 500 ms per beat
    daw.setRecordMode('replace');
    daw.triggerPad(0, 0, 1000);
    // Note On at +123 ms -> start = 0.246; Note Off at +877 ms -> raw dur = (1.754 - 0.246) = 1.508
    daw.recordEvent(0x90, 60, 100, 1123);
    daw.recordEvent(0x80, 60, 0, 1877);
    const note = daw.tracks[0].clips[0].notes[0];
    assert.deepEqual(note, { channel: 1, note: 60, velocity: 100, start: 0.25, dur: 1.51 });
});

// The minimum-duration policy is applied BEFORE rounding: a raw duration of
// exactly the 0.125-beat floor rounds up to 0.13 (nearest hundredth).
test('minimum note duration is enforced before hundredth rounding', () => {
    const daw = new DAWEngine({ tempo: 120 }); // 500 ms per beat
    daw.setRecordMode('replace');
    daw.triggerPad(0, 0, 1000);
    daw.recordEvent(0x90, 64, 80, 1000);   // start = 0.00
    daw.recordEvent(0x80, 64, 0, 1050);    // raw dur = 0.1 -> floored to 0.125
    const note = daw.tracks[0].clips[0].notes[0];
    assert.deepEqual(note, { channel: 1, note: 64, velocity: 80, start: 0, dur: 0.13 });
});

// quantizeClip keeps note start/dur on the hundredth grid (start snaps to the
// gridSize grid; duration is re-floored and rounded).
test('quantizeClip normalizes stored note start and duration', () => {
    const daw = new DAWEngine({ tempo: 120 });
    const clip = daw.tracks[0].clips[0];
    clip.notes.push(
        { channel: 1, note: 60, velocity: 90, start: 0.337, dur: 0.456 },
        { channel: 1, note: 62, velocity: 90, start: 1.872, dur: 0.05 } // below floor -> 0.13
    );
    daw.quantizeClip(0, 0); // default gridSize = 0.125
    assert.deepEqual(daw.tracks[0].clips[0].notes.map(n => ({ start: n.start, dur: n.dur })), [
        { start: 0.38, dur: 0.46 },
        { start: 1.88, dur: 0.13 },
    ]);
});

// loadData normalizes loaded notes to the hundredth grid too (min duration first).
test('loadData rounds stored note start and duration on load', () => {
    const daw = new DAWEngine({ tempo: 120 });
    daw.loadData({
        version: 1,
        tracks: [{
            channel: 1, armed: false, muted: false, soloed: false,
            clips: [
                { length: 4, notes: [
                    { channel: 1, note: 60, velocity: 90, start: 0.337, dur: 0.456 },
                    { channel: 1, note: 62, velocity: 90, start: 1.872, dur: 0.05 },
                ] },
            ],
        }],
    });
    const notes = daw.tracks[0].clips[0].notes;
    assert.deepEqual(notes.map(n => ({ start: n.start, dur: n.dur })), [
        { start: 0.34, dur: 0.46 },
        { start: 1.87, dur: 0.13 },
    ]);
});

// LED contract: only the LAST ACTIVATED playing clip blinks (playing/ch2);
// other playing clips burn steady (active/ch1); stopped-but-recorded clips
// pulse (idle/ch3); empty pads are off. Same cyan color (vel 37) everywhere.
test('pad LED: last-activated blinks, other playing are steady, stopped recorded pulse', () => {
    const sent = [];
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = new DAWEngine({ tempo: 120 });
    worker.daw.tracks[0].clips[0].notes.push({ channel: 1, note: 60, velocity: 90, start: 0, dur: 0.25 });
    worker.daw.setRecordMode('none');
    worker.outputs = new Map([['Launchkey Mini MK3 DAW Port', {
        sendMessage: (bytes) => sent.push(Array.from(bytes)),
    }]]);
    worker.controllerEngine = ControllerEngine.fromDirectory(
        fileURLToPath(new URL('../controller_profiles', import.meta.url)));
    worker._trackPlayTimers = new Map();
    worker._ledGlow = new Map();
    worker._padLedSent = new Map();
    worker._lastActivated = null;
    worker._broadcastState = () => {};

    // Stopped clip with recorded MIDI -> 'idle': pulsing (ch3, 0x92), same color.
    worker._refreshPadLeds(0, 0);
    assert.deepEqual(sent, [[0x92, 112, 37]], 'recorded-but-stopped pad pulses (ch3)');
    const snap = sent.length;
    worker._refreshPadLeds(0, 0);
    assert.equal(sent.length, snap, 'unchanged state must not spam duplicate LED messages');

    // Playing WITHOUT being last-activated -> 'active': steady ch1 (0x90).
    worker.daw.clipState[0] = 0;
    worker._refreshPadLeds(0, 0);
    assert.deepEqual(sent[sent.length - 1], [0x90, 112, 37], 'other playing pad burns steady (ch1)');

    // Last-activated playing clip -> 'playing': flashing ch2 (0x91).
    worker._lastActivated = { trackIdx: 0, slot: 0 };
    worker._refreshPadLeds(0, 0);
    assert.deepEqual(sent[sent.length - 1], [0x91, 112, 37], 'last-activated playing pad blinks (ch2)');

    // Stopping it -> back to pulsing idle.
    worker.daw.clipState[0] = -1;
    worker._refreshPadLeds(0, 0);
    assert.deepEqual(sent[sent.length - 1], [0x92, 112, 37], 'stopped pad returns to pulsing channel 3');

    // Empty slot -> 'off'. (slot 1 pad is note 96 in the Launchkey profile)
    worker.daw.clipState[0] = -1;
    worker._refreshPadLeds(0, 1);
    assert.deepEqual(sent[sent.length - 1], [0x80, 96, 0], 'empty stopped pad sends note-off');

    // Active recording -> 'recording' state.
    worker.daw.recording = { track: 0, slot: 1, notes: [] };
    worker._refreshPadLeds(0, 1);
    assert.deepEqual(sent[sent.length - 1], [0x91, 96, 5], 'recording pad lights red (vel 5)');
});


// When transport/record stops while a note is held, the finalization in
// DAWEngine._stopRecording(endBeat) must derive each open note's duration from
// the actual stop beat, not from a hardcoded constant. A note started at beat 1
// and stopped at beat 3 must end with dur: 2 (the span), preserving pitch,
// channel and velocity.
test('_stopRecording derives sustained-note duration from the actual stop beat', () => {
    const daw = new DAWEngine();

    // Deterministic fixture: set up the recording state directly so that a
    // single sustained note started at beat 1 is captured exactly.
    daw.recording = {
        track: 0,
        slot: 0,
        startBeat: 0,
        notes: daw.tracks[0].clips[0].notes,
        noteStarts: new Map([['note:1:60', [{ channel: 1, velocity: 100, beat: 1 }]]]),
    };

    // Stop the transport/recording at beat 3 (two beats after the note started).
    daw._stopRecording(3, true);

    const clip = daw.tracks[0].clips[0];
    assert.equal(daw.recording, null, 'recording must be finalized/cleared');
    assert.deepEqual(clip.notes.map(n => ({ channel: n.channel, note: n.note, velocity: n.velocity, start: n.start, dur: n.dur })),
        [{ channel: 1, note: 60, velocity: 100, start: 1, dur: 2 }],
        'sustained note stopped at beat 3 must have dur from the actual stop beat (3 - 1 = 2), not a hardcoded value');
});
