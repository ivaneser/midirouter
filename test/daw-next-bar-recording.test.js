// ---------------------------------------------------------------------------
// RED regression — уточнённая семантика остановки записи (next-bar boundary).
//
// Тесты используют только публичные entrypoints worker/DAW:
//   MIDIRouterWorker.handleDawControl, DAWEngine.triggerPad / recordEvent /
//   stopTransport / setRecordMode / armTrack. Никаких production API ради
//   теста не вводится. Контролируемое время достигается минимальными
//   real wall-clock интервалами (tempo=300 → 200 ms/beat; meter=1 → 200 ms/bar),
//   так что ближайшая bar boundary наступает через ~200 мс — тесты быстрые
//   и не зависают. Cleanup — через `t.after`.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';
import { MIDIRouterWorker } from '../worker-midi.js';

// ---------------------------------------------------------------------------
// Helper — создаёт минимального worker-обёртку без реального Worker thread.
// ---------------------------------------------------------------------------
function makeWorker(tempo = 120) {
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = new DAWEngine({ tempo });
    worker._trackPlayTimers = new Map();
    worker._ledGlow = new Map();
    worker._padLedSent = new Map();
    worker._broadcastState = () => {};
    worker._syncPadClock = () => {};
    worker._refreshPadLeds = () => {};
    return worker;
}

// ---------------------------------------------------------------------------
// stopped-transport count-in regression (восстановлен из первоначальной
// версии файла). Проверяет:
//   - future startTime = base + 8 * spb (ДВА полных такта от триггера);
//   - MIDI до начала игнорируется;
//   - Note On ровно в startTime и Note Off через 250 мс принимаются;
//   - note.start = 0 (clip-local, beat 0.0), dur = 0.5 (250 ms при tempo 120).
// ---------------------------------------------------------------------------
test('count-in regression: future start boundary, pre-start MIDI ignored, Note On/Off at start', async (t) => {
    const daw = new DAWEngine({ tempo: 120 }); // 500 ms/beat, 4-beat measure

    const base = performance.now();
    const msPerBeat = 500; // 60 / 120 * 1000

    t.after(() => {
        if (daw.playing) daw.stopTransport();
    });

    assert.equal(daw.playing, false, 'transport starts stopped');

    // Arm track 0 and start recording on empty pad.
    daw.setRecordMode('replace');
    daw.armTrack(0);
    const r1 = daw.triggerPad(0, 0, base);
    assert.equal(r1.action, 'record', 'armed empty pad starts recording');
    assert.ok(daw.recording, 'precondition: recording is active');

    // Count-in start — future next-bar boundary (stopped transport → two full
    // measures delay from trigger moment).
    const expectedStartTime = base + 8 * msPerBeat; // two measures later
    assert.equal(
        daw.recording.startTime,
        expectedStartTime,
        'stopped-transport count-in start must be a future bar boundary',
    );

    // Pre-start MIDI (timestamp before startTime) is ignored.
    const preStart = expectedStartTime - 1;
    const preResult = daw.recordEvent(0x90, 55, 80, preStart);
    assert.equal(preResult, false, 'MIDI before start boundary is ignored');
    assert.equal(daw.recording.notes.length, 0, 'no notes captured yet (pre-start)');

    // Note On exactly at startTime (clip-local beat 0.0).
    const noteOnTime = expectedStartTime;
    daw.recordEvent(0x90, 60, 100, noteOnTime);
    assert.equal(daw.recording.notes.length, 0, 'held note stays in recording buffer');

    // Note Off 250 ms later → clip-local beat 0.5 (250 ms / 500 ms per beat).
    const noteOffTime = expectedStartTime + 250;
    daw.recordEvent(0x80, 60, 0, noteOffTime);

    // The captured note: clip-local start=0, dur=0.5 beats (250 ms at tempo 120).
    const clip = daw.tracks[0].clips[0];
    assert.equal(clip.notes.length, 1, 'note captured in clip');
    const note = clip.notes[0];
    assert.equal(note.note, 60, 'note pitch matches');
    assert.equal(note.velocity, 100, 'note velocity matches');
    assert.equal(note.start, 0, 'note start is clip-local 0 (beat 0.0)');
    assert.equal(note.dur, 0.5, 'note dur = 0.5 beats (250 ms at tempo 120)');

    // Recording session is still active (no stop triggered yet) — the note was
    // closed by its own Note Off, not by a pad trigger / transport stop.
    assert.ok(daw.recording !== null, 'recording session still active after Note Off');
});

// ---------------------------------------------------------------------------
// ПУТЬ 1: pad Stop — повторный trigger того же pad во время записи.
//
// Контракт: stop-запрос до конца такта НЕ финализирует take немедленно —
// recording остаётся активным, пока не наступит ближайший конец такта (bar
// boundary). Длительность ноты при этом равна реальному времени от Note On
// (beat 0.0) до конца такта.
//
// Тест использует настоящего MIDIRouterWorker._triggerPad с real wall-clock
// интервалами (tempo=300, meter=1 → bar = 200 ms). RED падает из-за того,
// что production немедленно финализирует запись через _stopRecording.
// ---------------------------------------------------------------------------
test('PATH 1: pad trigger stop defers take finalization to nearest bar end (RED)', async (t) => {
    const worker = makeWorker(300); // 200 ms/beat
    const daw = worker.daw;
    daw.setMetronomeBeatsPerMeasure(1); // meter = 1 → bar = 1 beat = 200 ms

    t.after(() => {
        if (daw.playing) daw.stopTransport();
        worker.cleanup();
    });

    // Arm track 0, trigger empty pad -> recording with next-bar start.
    // Start via the real worker entrypoint so the empty-project worker path
    // starts transport immediately.
    daw.setRecordMode('replace');
    daw.armTrack(0);
    const r1 = worker._triggerPad(0, 0, performance.now());
    assert.equal(r1.action, 'record', 'empty pad starts recording');
    assert.ok(daw.recording, 'precondition: recording is active');

    // Capture recording timing reference (before stop request).
    const recordingStartTime = daw.recording.startTime;
    const recordingStartBeat = daw.recording.startBeat;

    // Wait in real time until recording.startTime has passed (recording started).
    const waitToStart = Math.max(0, recordingStartTime - performance.now()) + 10;
    await new Promise(resolve => setTimeout(resolve, waitToStart));

    // Note On timestamped with actual performance.now() (not a future start).
    const noteOnTime = performance.now();
    daw.recordEvent(0x90, 60, 100, noteOnTime);

    const msPerBeat = 60 / daw.tempo * 1000; // 200 ms at tempo 300
    const stopAt = recordingStartTime + msPerBeat / 2; // stop mid-bar
    await new Promise(resolve => setTimeout(resolve, Math.max(0, stopAt - performance.now())));

    // --- Pad Stop: повторный trigger того же pad -> stop-запрос. ---
    const stopTime = performance.now();
    const transportBeat = ((stopTime - daw._playAnchorTime) / 1000) / daw._secondsPerBeat();
    const nextBar = Math.ceil(transportBeat / daw._metronomeBeatsPerMeasure)
        * daw._metronomeBeatsPerMeasure;
    const boundaryTime = daw._playAnchorTime + nextBar * msPerBeat;
    worker._triggerPad(0, 0, stopTime);

    // Контракт: после stop-request recording остаётся активным (deferred).
    assert.ok(daw.recording !== null, 'recording remains active after pad stop (deferred to bar end)');

    // Дождаться настоящей границы транспорта; ограничить ожидание одной мерой.
    const waitMs = boundaryTime - performance.now() + 5;
    assert.ok(waitMs > 0 && waitMs <= msPerBeat + 10, 'next bar boundary is within one measure');
    await new Promise(resolve => setTimeout(resolve, waitMs));

    // На bar boundary take должен быть финализирован.
    assert.equal(daw.recording, null, 'recording finalized at nearest bar boundary');
    const clip = daw.tracks[0].clips[0];
    assert.equal(clip.notes.length, 1, 'held note belongs to the take');
    const note = clip.notes[0];
    // dur = elapsed beats from real Note On to intended boundary, rounded to 0.01.
    const noteOnBeat = ((noteOnTime - recordingStartTime) / 1000) / daw._secondsPerBeat() + recordingStartBeat;
    const boundaryRecordingBeat = ((boundaryTime - recordingStartTime) / 1000) / daw._secondsPerBeat() + recordingStartBeat;
    const expectedDur = Math.round((boundaryRecordingBeat - noteOnBeat) * 100) / 100;
    assert.equal(note.dur, expectedDur, 'note dur spans to nearest bar end');
    assert.ok(note.start >= 0 && note.start < 1, 'note start within [0, 1)');
});

// ---------------------------------------------------------------------------
// ПУТЬ 2: global Stop — handleDawControl({type:'daw_stop_transport'}).
// Контракт: `daw_stop_transport` должен остановить транспорт И финализировать
// take по ближайшему концу такта, а не немедленно. Запись должна остаться
// активной сразу после stop-request и завершиться на bar boundary.
// ---------------------------------------------------------------------------
test('PATH 2: daw_stop_transport defers take finalization to nearest bar end (RED)', async (t) => {
    const worker = makeWorker(300); // 200 ms/beat
    const daw = worker.daw;
    daw.setMetronomeBeatsPerMeasure(1); // meter = 1 → bar = 1 beat = 200 ms

    t.after(() => {
        if (daw.playing) daw.stopTransport();
        worker.cleanup();
    });

    // Arm track 0, trigger empty pad -> recording with next-bar start.
    // Start via the real worker entrypoint so the empty-project worker path
    // starts transport immediately (no explicit daw_start_transport needed).
    daw.setRecordMode('replace');
    daw.armTrack(0);
    const r1 = worker._triggerPad(0, 0, performance.now());
    assert.equal(r1.action, 'record', 'empty pad starts recording');
    assert.ok(daw.recording, 'precondition: recording is active');

    // Capture recording timing reference (before stop request).
    const recordingStartTime = daw.recording.startTime;
    const recordingStartBeat = daw.recording.startBeat;

    // Wait in real time until recording.startTime has passed (recording started).
    const waitToStart = Math.max(0, recordingStartTime - performance.now()) + 10;
    await new Promise(resolve => setTimeout(resolve, waitToStart));

    // Note On timestamped with actual performance.now() (not a future start).
    const noteOnTime = performance.now();
    daw.recordEvent(0x90, 60, 100, noteOnTime);

    const msPerBeat = 60 / daw.tempo * 1000; // 200 ms at tempo 300
    const stopAt = recordingStartTime + msPerBeat / 2; // stop mid-bar
    await new Promise(resolve => setTimeout(resolve, Math.max(0, stopAt - performance.now())));

    // --- Global Stop через handleDawControl. ---
    const stopTime = performance.now();
    const transportBeat = ((stopTime - daw._playAnchorTime) / 1000) / daw._secondsPerBeat();
    const nextBar = Math.ceil(transportBeat / daw._metronomeBeatsPerMeasure)
        * daw._metronomeBeatsPerMeasure;
    const boundaryTime = daw._playAnchorTime + nextBar * msPerBeat;
    worker.handleDawControl({ type: 'daw_stop_transport' });

    // Контракт: после stop-request recording остаётся активным (deferred).
    // Транспорт останавливается по boundary, а не мгновенно.
    assert.ok(daw.recording !== null, 'recording remains active after global stop (deferred to bar end)');
    assert.equal(daw.playing, true, 'transport remains active after global stop (deferred to bar end)');

    // Дождаться настоящей границы транспорта; ограничить ожидание одной мерой.
    const waitMs = boundaryTime - performance.now() + 5;
    assert.ok(waitMs > 0 && waitMs <= msPerBeat + 10, 'next bar boundary is within one measure');
    await new Promise(resolve => setTimeout(resolve, waitMs));

    // На bar boundary take должен быть финализирован, транспорт остановлен.
    assert.equal(daw.recording, null, 'recording finalized at nearest bar boundary');
    assert.equal(daw.playing, false, 'transport stopped at bar boundary');
    const clip = daw.tracks[0].clips[0];
    assert.equal(clip.notes.length, 1, 'held note belongs to the take');
    const note = clip.notes[0];
    // dur = elapsed beats from real Note On to intended boundary, rounded to 0.01.
    const noteOnBeat = ((noteOnTime - recordingStartTime) / 1000) / daw._secondsPerBeat() + recordingStartBeat;
    const boundaryRecordingBeat = ((boundaryTime - recordingStartTime) / 1000) / daw._secondsPerBeat() + recordingStartBeat;
    const expectedDur = Math.round((boundaryRecordingBeat - noteOnBeat) * 100) / 100;
    assert.equal(note.dur, expectedDur, 'note dur spans to nearest bar end');
    assert.ok(note.start >= 0 && note.start < 1, 'note start within [0, 1)');
});


// ---------------------------------------------------------------------------
// Count-in regression — pressing Play during a count-in must stop transport
// immediately (not defer to the bar boundary), cancel the pending count-in
// timer, null daw.recording, and invoke _onMetronomeStop.
// ---------------------------------------------------------------------------
test('count-in: controller Play stops transport immediately, cancels pending count-in', async (t) => {
    const metronomeStopped = [];

    // Use the lightweight makeWorker helper — no real ALSA ports / Python process.
    const worker = makeWorker(300);  // tempo=300 → 200 ms/beat; meter=1 → bar=1 beat ≈ 200 ms
    const daw = worker.daw;
    daw.setMetronomeBeatsPerMeasure(1);

    t.after(() => {
        if (daw.playing) daw.stopTransport();
        try { worker.cleanup(); } catch (_) {}
    });

    // --- Start a recording on an empty pad with count-in. ---
    daw.setRecordMode('replace');

    // Intercept metronome / count-in callbacks so we can assert they fire.
    let completionFired = false;
    daw._onCountInComplete = () => { completionFired = true; };
    daw._onAudioBeat = (isAccent) => {};

    // Intercept _onMetronomeStop via the DAW callback chain.
    const origOnMetronomeStop = daw._onMetronomeStop;
    daw._onMetronomeStop = () => { metronomeStopped.push(true); };

    const baseTime = performance.now();
    const r1 = worker._triggerPad(0, 0, baseTime);
    assert.equal(r1.action, 'record', 'empty pad starts recording');
    assert.ok(daw.recording, 'precondition: recording is active');
    assert.equal(daw._countInRunning, true, '_countInRunning must be set during count-in');

    // --- Press Play immediately DURING the count-in (before timer fires). ---
    const beforeStop = performance.now();
    worker._handleProfileTransport('play', true);

    // Assertions: immediate stop.
    assert.equal(daw.playing, false, 'transport must be stopped immediately after Play during count-in');
    assert.equal(worker._transportPlaying, false, '_transportPlaying cleared immediately');
    assert.ok(
        performance.now() - beforeStop < 100,
        'stop operation should complete in under 100 ms',
    );

    // Recording must be null (count-in timer canceled + recording session destroyed).
    assert.equal(daw.recording, null, 'recording cleared after immediate stop');

    // Pending count-in timer must be null.
    assert.equal(daw._countInTimer, null, '_countInTimer cleared on immediate stop');

    // _onMetronomeStop must have been invoked (called by daw.stopTransport → _stopMetronome).
    assert.ok(metronomeStopped.length > 0, 'metronome stopped callback was invoked');

    // Count-in flag should be cleared.
    assert.equal(daw._countInRunning, false, '_countInRunning cleared on immediate stop');

    // Wait beyond two-bar deadline (2 × 200 ms = 400 ms) and verify no
    // delayed completion fires (the _countInTimer must have been cleared).
    await new Promise(resolve => setTimeout(resolve, 450)); // > two bars at tempo=300, meter=1 → 400ms
    assert.equal(daw._countInRunning, false, '_countInRunning still false after count-in window');
    assert.ok(!completionFired, 'no delayed _onCountInComplete fired after cancelled count-in');
});