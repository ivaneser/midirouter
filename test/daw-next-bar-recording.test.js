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
    // Wire the DAW's count-in-completion callback to the worker method so that
    // _onCountInComplete exercises production behavior (advances startTime +
    // refreshes pad LEDs) even though makeWorker never runs the constructor.
    const origHandleCIC = worker._handleCountInComplete;
    worker._handleCountInComplete = function () { return origHandleCIC.call(this); };
    worker.daw._onCountInComplete = () => { worker._handleCountInComplete(); };
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

// ---------------------------------------------------------------------------
// Play-before-pad two-bar count-in.
//
// Сценарий: транспорт уже запущен (Play / daw_start_transport). Нажатие пустого
// пэда во время работающего транспорта должно запустить двухтактовый отсчёт, а
// запись начнётся ровно через два такта. За это время MIDI не захватывается;
// после истечения таймера — записывается.
// ---------------------------------------------------------------------------
test('play-before-pad: two-bar count-in before recording begins', async (t) => {
    const worker = makeWorker(300);  // tempo=300 → 200 ms/beat; meter=1 → bar=1 beat ≈ 200 ms
    const daw = worker.daw;
    daw.setMetronomeBeatsPerMeasure(1);

    // Intercept _refreshPadLeds to record the actual LED state at each refresh,
    // proving that the pad LED transitions through 'count-in' while pending
    // and then to 'recording' after count-in completion.
    const origRefresh = worker._refreshPadLeds;
    const padLedTransitions = [];
    worker._refreshPadLeds = (trackIdx, slot) => {
        if (trackIdx != null && slot != null) {
            padLedTransitions.push({ trackIdx, slot, state: worker._padLedStateFor(trackIdx, slot) });
        }
        return origRefresh.call(worker, trackIdx, slot);
    };

    t.after(() => {
        // Restore original _refreshPadLeds so cleanup doesn't break.
        worker._refreshPadLeds = origRefresh;
        if (daw.playing) daw.stopTransport();
        try { worker.cleanup(); } catch (_) {}
    });

    // --- Step 1: Start transport via the real worker entrypoint. ---
    worker.handleDawControl({ type: 'daw_start_transport' });
    assert.equal(daw.playing, true, 'transport is running after daw_start_transport');
    assert.equal(worker._transportPlaying, true, '_transportPlaying set by handleDawControl');
    assert.equal(daw.recording, null, 'no recording started — transport only');

    // Metronome is not started by handleDawControl({ type: 'daw_start_transport' }) —
    // it only starts if _metronomeEnabled was already true (an orthogonal concern).

    // --- Step 2: Press an empty pad with countIn while transport is running. ---
    const baseTime = performance.now();

    // Preserve the worker's real _onCountInComplete (advances recording.startTime)
    // and chain our check on top of it.
    const origOnCountInComplete = daw._onCountInComplete;
    let countInFired = false;
    daw._onCountInComplete = () => {
        origOnCountInComplete();
        countInFired = true;
    };

    // Arm track 0 and trigger pad with countIn=true while transport is playing.
    daw.setRecordMode('replace');
    daw.armTrack(0);
    const result = worker._triggerPad(0, 0, baseTime, { countIn: true });
    assert.equal(result.action, 'record', 'empty pad starts recording action');

    // Two-bar count-in must be pending — _countInRunning should be set.
    assert.ok(daw._countInRunning, '_countInRunning set after pad trigger during transport');
    assert.ok(daw.recording != null, 'recording session exists (armRecording created it)');

    // The recording startTime must be two bars in the future.
    const barMs = 2 * daw._metronomeBeatsPerMeasure * daw._secondsPerBeat() * 1000; // 400 ms at tempo=300, meter=1
    assert.ok(
        daw.recording.startTime > baseTime + barMs - 50,
        'recording startTime is two bars in the future',
    );

    // Pre-count-in MIDI (before startTime) must be ignored.
    const preStart = daw.recording.startTime - 1;
    assert.equal(daw.recordEvent(0x90, 60, 80, preStart), false, 'MIDI before count-in boundary is ignored');

    // Pending pad LED state: during count-in (armRecording created but _countInRunning
    // still true, startTime in the future) the pad shows 'count-in'.
    assert.equal(
        worker._padLedStateFor(0, 0),
        'count-in',
        'pending pad LED state is "count-in" during count-in (armRecording created)',
    );

    // Wait for the two-bar count-in to complete (400 ms at tempo=300, meter=1).
    await new Promise(resolve => setTimeout(resolve, barMs + 50));

    // Count-in timer must have fired and the worker's callback advanced startTime.
    assert.ok(countInFired, '_onCountInComplete fired after two-bar delay');
    assert.equal(daw._countInRunning, false, '_countInRunning cleared after count-in completion');

    // _refreshPadLeds must have been called for this track/slot at count-in
    // completion so the physical pad LED transitions from orange to red.
    const postCountInRefreshes = padLedTransitions.filter(
        (t) => t.trackIdx === 0 && t.slot === 0,
    );
    assert.ok(postCountInRefreshes.length > 0, '_refreshPadLeds called for track 0 / slot 0 at count-in completion');

    // Prove the LED state was 'count-in' while the count-in timer was pending
    // (i.e. before the two-bar delay elapsed), and transitions to 'recording'
    // after count-in completes — this catches a regression where the callback
    // never refreshes the pad LED at all.
    const statesBeforeCompletion = postCountInRefreshes.filter(
        (r) => r.state === 'count-in',
    );
    assert.ok(statesBeforeCompletion.length > 0, 'pad LED state was "count-in" while count-in timer pending');

    // After count-in completes, the final recorded state must be 'recording'.
    const statesAfterCompletion = postCountInRefreshes.filter(
        (r) => r.state === 'recording',
    );
    assert.ok(statesAfterCompletion.length > 0, 'pad LED state transitions to "recording" after count-in completion');

    // After count-in completes, LED state transitions to 'recording'.
    assert.equal(
        worker._padLedStateFor(0, 0),
        'recording',
        'LED state is "recording" after count-in completion (_countInRunning === false)',
    );

    // Recording should now be active — startTime has been advanced to "now" by the callback.
    assert.ok(
        daw.recording.startTime <= performance.now(),
        'recording startTime is in the past (actual recording began)',
    );

    // A note timestamped after count-in completion must be captured.
    const postCountInTime = performance.now();
    assert.equal(daw.recordEvent(0x90, 62, 100, postCountInTime), true, 'MIDI accepted after count-in');

    // Close the held note to flush it into the clip.
    await new Promise(resolve => setTimeout(resolve, 50));
    daw.recordEvent(0x80, 62, 0, performance.now());

    const clip = daw.tracks[0].clips[0];
    assert.ok(clip.notes.length > 0, 'note captured in clip after two-bar count-in');
});

// ---------------------------------------------------------------------------
// SUBSEQUENT-PAD SNAP-TO-NEXT-BAR: project already has content (global cycle
// locked), transport is running. A subsequent empty-pad trigger must show an
// orange "count-in" pending state, reject MIDI before the next bar boundary,
// and begin recording at that very next bar (not two additional bars).
// ---------------------------------------------------------------------------
test('subsequent pad: snap to nearest bar boundary while count-in pending (RED)', async (t) => {
    const worker = makeWorker(300);  // tempo=300 → 200 ms/beat; meter=1 → bar=1 beat ≈ 200 ms
    const daw = worker.daw;
    daw.setMetronomeBeatsPerMeasure(1);

    t.after(() => {
        if (daw.playing) daw.stopTransport();
        try { worker.cleanup(); } catch (_) {}
    });

    // --- Step 1: Create content in the project so it's no longer empty. ---
    const baseTime = performance.now();
    daw.setRecordMode('replace');
    daw.armTrack(0);
    const r1 = worker._triggerPad(0, 0, baseTime);
    assert.equal(r1.action, 'record', 'first pad starts recording on empty clip');

    // Wait for the two-bar count-in to complete so we have a real take.
    await new Promise(resolve => setTimeout(resolve, 450)); // > 2 bars at tempo=300, meter=1

    // Capture a note during active recording so the first take has content.
    const captureTime = performance.now();
    daw.recordEvent(0x90, 60, 80, captureTime);
    await new Promise(resolve => setTimeout(resolve, 50));
    daw.recordEvent(0x80, 60, 0, performance.now());

    // Finalize the first recording so we have a clean non-empty project for
    // the subsequent-pad scenario.  Use _stopRecording directly to avoid the
    // deferred bar-boundary finalization that _triggerPad would schedule when
    // transport is still running (which would block the assertion below).
    daw._stopRecording();
    assert.equal(daw.recording, null, 'first take finalized');
    assert.ok(daw.tracks[0].clips[0].notes.length > 0, 'first take has captured notes');

    // Now the project is NOT empty — global cycle should be locked.
    assert.ok(!daw.isEmptyProject(), 'project has content after first take');
    assert.equal(daw._globalCycleLocked, true, 'global cycle locked after first completed recording');

    // --- Step 2: Start transport (it may already be stopped). ---
    worker.handleDawControl({ type: 'daw_start_transport' });
    assert.ok(daw.playing, 'transport is running for subsequent-pad test');

    // --- Step 3: Trigger a different empty pad while transport runs. ---
    const triggerTime = performance.now();

    // Intercept count-in completion to verify it fires at the right time.
    let countInFired = false;
    const origOnCountInComplete = daw._onCountInComplete;
    daw._onCountInComplete = () => {
        origOnCountInComplete();
        countInFired = true;
    };

    // Trigger pad 0, slot 1 (a different empty slot) — this is a subsequent pad.
    // Pass countIn=true to match production _handleMappedPad behavior which
    // always passes count-in for pad triggers.
    const r2 = worker._triggerPad(0, 1, triggerTime, { countIn: true });
    assert.equal(r2.action, 'record', 'subsequent empty pad starts recording');

    // Count-in must be pending.
    assert.ok(daw._countInRunning, '_countInRunning set for subsequent-pad count-in');
    assert.ok(daw.recording !== null, 'recording session exists after subsequent pad');

    // The startTime must be the NEXT bar boundary — at most one bar away (200 ms),
    // NOT two full bars (400 ms).
    const msPerBeat = 60 / daw.tempo * 1000; // 200 ms at tempo=300
    const maxDelayMs = msPerBeat + 5; // one bar plus tolerance
    assert.ok(
        daw.recording.startTime <= triggerTime + maxDelayMs,
        'subsequent-pad startTime is within one bar of trigger (not two bars)',
    );

    // LED state must be 'count-in' while pending.
    assert.equal(
        worker._padLedStateFor(0, 1),
        'count-in',
        'subsequent-pad LED shows count-in during pending period',
    );

    // MIDI before the boundary is rejected.
    const preStart = daw.recording.startTime - 1;
    assert.equal(daw.recordEvent(0x90, 60, 80, preStart), false, 'MIDI before next-bar boundary is ignored');

    // Wait for the count-in to complete.
    const delayMs = Math.max(10, daw.recording.startTime - triggerTime + 5);
    await new Promise(resolve => setTimeout(resolve, delayMs));

    // Count-in must have fired and recording should now be active.
    assert.ok(countInFired, '_onCountInComplete fired after snap-to-next-bar');
    assert.equal(daw._countInRunning, false, '_countInRunning cleared after count-in completion');

    // LED transitions to 'recording'.
    assert.equal(
        worker._padLedStateFor(0, 1),
        'recording',
        'LED state is "recording" after count-in completes',
    );

    // MIDI accepted now that startTime has passed.
    const postCountInTime = performance.now();
    assert.equal(daw.recordEvent(0x90, 62, 100, postCountInTime), true, 'MIDI accepted after snap-to-next-bar');

    // Close the held note to flush it into the clip.
    await new Promise(resolve => setTimeout(resolve, 50));
    daw.recordEvent(0x80, 62, 0, performance.now());

    // Finalize with _stopRecording directly to avoid the deferred bar-boundary
    // finalization that _triggerPad would schedule when transport is still
    // running (which would block the assertion below).
    daw._stopRecording();
    assert.equal(daw.recording, null, 'subsequent-pad take finalized');
});