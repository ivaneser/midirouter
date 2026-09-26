// Контракт "Mode": что делает клип ПОСЛЕ окончания записи и как ведёт себя
// повторное нажатие. Пустой клип всегда начинает запись независимо от Mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';
import { MIDIRouterWorker } from '../worker-midi.js';

function recordAndStop(daw, track, slot, t0, mode) {
    daw.setRecordMode(mode);
    assert.equal(daw.triggerPad(track, slot, t0).action, 'record', 'empty clip must start recording');
    daw.recordEvent(0x90, 60, 90, t0 + 100);
    daw.recordEvent(0x80, 60, 0, t0 + 400);
    return daw.triggerPad(track, slot, t0 + 500);
}

test('Play mode: stop after take -> playback; press toggles playback', () => {
    const daw = new DAWEngine();
    const stopResult = recordAndStop(daw, 0, 0, 1000, 'none');
    assert.equal(stopResult.action, 'record-stop', 'Play mode: take stop must start playback');
    assert.equal(daw.clipState[0], 0, 'clip must be in playing state');

    assert.equal(daw.triggerPad(0, 0, 2000).action, 'stop', 'press on playing clip must stop it');
    assert.equal(daw.clipState[0], -1);

    assert.equal(daw.triggerPad(0, 0, 3000).action, 'play', 'press on stopped clip in Play mode must start it');
    assert.equal(daw.clipState[0], 0);
});

test('Overdub mode: stop after take -> stopped with layers kept; next press adds a layer', () => {
    const daw = new DAWEngine();
    const stopResult = recordAndStop(daw, 0, 0, 1000, 'overdub');
    assert.equal(stopResult.action, 'record-stop-stopped', 'Overdub stop must leave the clip stopped');
    assert.equal(daw.clipState[0], -1);
    assert.equal(daw.tracks[0].clips[0].notes.length, 1, 'the take must be kept');

    const again = daw.triggerPad(0, 0, 2000);
    assert.equal(again.action, 'overdub', 'next press on an overdub clip must start a layer');
    daw.recordEvent(0x90, 62, 90, 2000);
    daw.recordEvent(0x80, 62, 0, 2400);
    assert.equal(daw.triggerPad(0, 0, 2500).action, 'record-stop-stopped');
    const notes = daw.tracks[0].clips[0].notes;
    assert.equal(notes.length, 2, 'overdub must keep the old layer and add the new one');
    const pitchSet = new Set(notes.map((n) => n.note));
    assert.ok(pitchSet.has(60) && pitchSet.has(62), 'both layers must be present');
});

test('Replace mode: stop after take -> stopped; next press overwrites the take', () => {
    const daw = new DAWEngine();
    const stopResult = recordAndStop(daw, 0, 0, 1000, 'replace');
    assert.equal(stopResult.action, 'record-stop-stopped', 'Replace stop must leave the clip stopped');
    assert.equal(daw.clipState[0], -1);
    assert.equal(daw.tracks[0].clips[0].notes.length, 1, 'the take must be kept after stop');

    const again = daw.triggerPad(0, 0, 2000);
    assert.equal(again.action, 'record', 'next press on a replace clip must start a fresh take');
    assert.equal(daw.tracks[0].clips[0].notes.length, 0, 'replace must wipe the previous take');
    daw.recordEvent(0x90, 72, 90, 2000);
    daw.recordEvent(0x80, 72, 0, 2400);
    assert.equal(daw.triggerPad(0, 0, 2500).action, 'record-stop-stopped');
    const notes = daw.tracks[0].clips[0].notes;
    assert.equal(notes.length, 1, 'only the new take must remain');
    assert.equal(notes[0].note, 72);
});

test('pressing a new empty clip on the same track stops the current clip', () => {
    const daw = new DAWEngine();
    // Записали и включили воспроизведение в слоте 0 (Play-режим)
    recordAndStop(daw, 0, 0, 1000, 'none');

    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = daw;
    worker.outputs = new Map();
    worker.controllerEngine = { padMappings: () => [], feedbackMessagesFor: () => [] };
    worker._trackPlayTimers = new Map();
    worker._ledGlow = new Map();
    worker._padLedSent = new Map();
    worker._broadcastState = () => {};
    worker._emitVisualEvent = () => {};
    let stopped = 0;
    worker._stopTrackPlayback = () => { stopped += 1; };
    worker._startTrackPlayback = () => {};
    worker._sendFeedback = () => {};
    // Слот 0 "играет"
    daw.clipState[0] = 0;

    // Нажатие на пустой слот 1 той же группы: запись начинается, текущий клип гаснет
    const result = worker._triggerPad(0, 1, 2000);
    assert.equal(result.action, 'record', 'empty slot must start recording');
    assert.equal(daw.recording.track, 0);
    assert.equal(daw.recording.slot, 1);
    assert.equal(stopped, 1, 'the previous clip on this track must be stopped');
    assert.equal(daw.clipState[0], -1);

    // Запись в новом клипе корректно завершается (Play → воспроизведение)
    daw.recordEvent(0x90, 64, 90, 2000);
    daw.recordEvent(0x80, 64, 0, 2400);
    const stopResult = worker._triggerPad(0, 1, 2500);
    assert.equal(stopResult.action, 'record-stop');
    assert.equal(daw.clipState[0], 1, 'new take must start playing');
});

test('empty clip in any mode starts recording on first press', () => {
    for (const mode of ['none', 'replace', 'overdub']) {
        const daw = new DAWEngine();
        daw.setSlotsPerTrack(4);
        daw.setRecordMode(mode);
        assert.equal(daw.triggerPad(5, 3, 0).action, 'record', `mode ${mode}: empty clip must record`);
        assert.ok(daw.recording, `mode ${mode}: recording must be active`);
    }
});
