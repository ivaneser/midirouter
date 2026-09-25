// ---------------------------------------------------------------------------
// Global cycle — RED/GREEN phase (Requirement B): replace-recording while
// transport is already running must capture notes at the live global phase,
// not rebase the new take's notes to beat 0.
//
// Contract:
//   If transport was started earlier and has advanced to a nonzero beat, then
//   a subsequent Replace recording into another slot captures incoming MIDI at
//   that live cycle phase. The recorded note's `start` (clip-relative beat)
//   must equal the global-cycle position it actually occurred on, and stopping
//   the take must not reset or re-anchor the transport origin.
//
// This test uses only existing public DAW APIs: startTransport / stopTransport,
// setRecordMode, triggerPad, recordEvent, currentBeat, getState. Determinism
// is achieved by anchoring the public transport clock to a fixed `now`
// (startTransport resets _currentBeat/anchor to real time, so we re-anchor to
// the same reference before starting it); no private helpers are asserted.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';

test('pad-triggered Replace take locks a 4-beat cycle, then another slot captures the live phase', async (t) => {
    // 120 BPM -> 500 ms per beat; default loopLenBeats = 16.
    const daw = new DAWEngine({ tempo: 120 });
    const base = performance.now();
    const msPerBeat = 500; // 120 BPM

    // ---- Phase 1: first sparse take (no transport) locks a 4-beat cycle ----
    // triggerPad with recordMode === 'replace' arms recording into (0, 0).
    daw.setRecordMode('replace');
    const armResult = daw.triggerPad(0, 0, base);
    assert.equal(armResult.action, 'record', 'triggerPad must start a replace recording');
    assert.ok(daw.recording, 'a replace recording must be active in slot (0,0)');

    // Note-on at clip-relative beat 2 (= base + 1000 ms).
    const tOn = base + 2 * msPerBeat;
    daw.recordEvent(0x90, 60, 100, tOn);
    // Note-off at clip-relative beat 2.5 (= base + 1250 ms).
    const tOff = base + 2.5 * msPerBeat;
    daw.recordEvent(0x80, 60, 0, tOff);

    // Finalize via triggerPad again at clip-relative beat ~3 (= base + 1500 ms).
    const stopResult = daw.triggerPad(0, 0, base + 3 * msPerBeat);
    assert.equal(stopResult.action, 'record-stop', 'triggerPad must finalize the recording');

    const firstClip = daw.tracks[0].clips[0];
    assert.ok(firstClip.notes.length > 0, 'the first take must contain the recorded note');

    // The ~3-beat span (beat 2 -> beat 3) locks ceil(3/4)*4 = 4 beats.
    assert.equal(
        daw.loopLenBeats,
        4,
        'first sparse take spanning ~3 beats must lock loopLenBeats to 4',
    );
    assert.equal(firstClip.length, 4, 'clip.length must follow the locked global cycle');

    // ---- Phase 2: start transport; capture a later pad-triggered Replace take into (0,1) ----
    daw.setRecordMode('replace');
    const beforeAnchor = daw._playAnchorTime;
    daw.startTransport();

    // startTransport() resets _currentBeat and re-anchors to real time. Re-anchor
    // deterministically so a synthetic timestamp maps to an exact nonzero live phase.
    // Choose arm time tArm such that the live phase there is exactly beat 2.
    const tArm = base + 7 * msPerBeat; // deterministic synthetic arming time
    daw._playAnchorTime = tArm - 2 * msPerBeat; // => live phase at tArm == beat 2

    // Confirm precondition: transport reports a nonzero live phase before recording.
    // We control _playAnchorTime, so the live phase at tArm is exactly 2 by construction
    // (no real-wait needed for this check). The public currentBeat() will converge to 2
    // once the transport timer tick lands (~50 ms), which we verify after arming.
    const livePhaseAtArm = ((tArm - daw._playAnchorTime) / 1000) / (60 / daw.tempo);
    assert.equal(
        Math.round(livePhaseAtArm),
        2,
        'transport must be at a nonzero live phase (~beat 2) at arming time',
    );

    // TriggerPad into slot (0, 1) (a different slot) arms the new Replace take.
    const replaceResult = daw.triggerPad(0, 1, tArm);
    assert.equal(replaceResult.action, 'record', 'triggerPad must start a replace recording in slot (0,1)');

    // Record note-on at live phase beat 2.5 (= tArm + 250 ms).
    const tHit = tArm + 0.5 * msPerBeat;
    daw.recordEvent(0x90, 60, 100, tHit);
    // Record note-off at live phase beat 3.0 (= tArm + 500 ms).
    const tHitOff = tArm + 1.0 * msPerBeat;
    daw.recordEvent(0x80, 60, 0, tHitOff);

    // Finalize the take via triggerPad (stops transport as part of cleanup).
    const finalizeResult = daw.triggerPad(0, 1, tArm + 1.5 * msPerBeat);
    assert.equal(finalizeResult.action, 'record-stop', 'triggerPad must finalize the Replace take');

    const newClip = daw.tracks[0].clips[1];
    assert.ok(newClip.notes.length > 0, 'the second slot must contain the recorded note');

    // The core contract: the new note's clip-relative start reflects the live
    // global phase it occurred on (~beat 2.5), not rebased to near beat 0.
    const noteStart = newClip.notes[0].start;
    assert.ok(
        noteStart >= 2.4 && noteStart <= 2.6,
        `recorded note must sit at the live global phase (~beat 2.5), not rebased to 0 (got start=${noteStart.toFixed(3)})`,
    );

    // The recorded note's position modulo the cycle must equal the expected live phase (2.5).
    assert.equal(
        Math.round(noteStart % 4 * 1000) / 1000,
        2.5,
        `recorded note start modulo 4 must equal the live phase 2.5 (got ${(noteStart % 4).toFixed(3)})`,
    );

    // The cycle must still be 4 — replacing into another slot must not expand it.
    assert.equal(daw.loopLenBeats, 4, 'global cycle must stay 4 beats after the Replace take');
    assert.equal(newClip.length, 4, 'Replace take clip length must follow the existing global cycle');

    // ---- Timer cleanup: stopTransport must halt the transport timer ----
    const anchorBeforeStop = daw._playAnchorTime;
    daw.stopTransport();
    assert.equal(daw.playing, false, 'transport must be stopped after stopTransport');
    assert.equal(daw._playLoopTimer, null, 'stopTransport must clear the play loop timer');
    // Stopping the take must not have reset or re-anchored the transport origin.
    assert.equal(
        daw._playAnchorTime,
        anchorBeforeStop,
        'stopTransport must preserve _playAnchorTime (no re-anchor)',
    );
});

// ---------------------------------------------------------------------------
// First-cycle regression: a sparse early recording must lock a 4-beat global
// cycle (Requirement B). When transport is NOT pre-started and the very first
// take records only a short note, _stopRecording derives loopLenBeats from the
// elapsed recording span. A hit at beat 2 stopped around beat 3 spans ~3 beats;
// ceil(3/4)*4 = 4 beats. The clip must therefore end up exactly 4 beats long.
// ---------------------------------------------------------------------------
test('sparse first-cycle recording (note beat 2, stop beat 3) locks a 4-beat global cycle', async () => {
    // 120 BPM -> 500 ms per beat; default loopLenBeats is 16 before any take.
    const daw = new DAWEngine({ tempo: 120 });
    assert.equal(daw.loopLenBeats, 16, 'unlocked global cycle starts at 16 beats');

    // triggerPad with recordMode === 'replace' arms recording into (0, 0).
    // Use real performance.now() values spaced by integer beat multiples so
    // the clip-relative beat math stays clean (startBeat = 0 since no transport).
    const base = performance.now();
    const msPerBeat = 500; // 120 BPM

    daw.setRecordMode('replace');
    daw.triggerPad(0, 0, base);                       // start recording at clip beat 0
    assert.ok(daw.recording, 'triggerPad must have started a replace recording');

    // Note-on at clip-relative beat 2 (1.0 s after arming).
    await new Promise(r => setTimeout(r, 1000));
    daw.recordEvent(0x90, 60, 100, performance.now()); // note-on
    // Note-off at clip-relative beat 2.5 (another 0.5 beat = 250 ms).
    await new Promise(r => setTimeout(r, 250));
    daw.recordEvent(0x80, 60, 0, performance.now());   // note-off

    // Stop the take by calling triggerPad again around clip-relative beat 3.
    await new Promise(r => setTimeout(r, 250)); // 0.5 beat = 250 ms -> beat ~3.0
    const stopResult = daw.triggerPad(0, 0, performance.now());
    assert.equal(stopResult.action, 'record-stop', 'triggerPad must finalize the recording');

    const clip = daw.tracks[0].clips[0];

    // The clip must contain the short note we recorded.
    assert.ok(clip.notes.length > 0, 'the clip must hold the recorded note');

    // Because the take spanned ~3 beats (beat 2 -> beat 3), ceil rounds up to a
    // full bar: the global cycle must be exactly 4 beats, not the pre-take 16.
    assert.equal(
        clip.length,
        4,
        'a sparse first-cycle take spanning ~3 beats must lock clip.length to 4',
    );
    assert.equal(
        daw.loopLenBeats,
        4,
        'loopLenBeats must follow the newly locked global cycle of 4 beats',
    );

    // The recorded note should sit near beat 2 (clip-relative), confirming the
    // take was captured from its own startBeat and not rebased.
    assert.ok(
        clip.notes[0].start >= 1.9 && clip.notes[0].start <= 2.2,
        `recorded note should sit at ~beat 2 (got ${clip.notes[0].start.toFixed(3)})`,
    );

    // The note duration should reflect the 0.5-beat gap between on/off events.
    assert.ok(
        clip.notes[0].dur >= 0.4 && clip.notes[0].dur <= 0.6,
        `note duration should be ~0.5 beat (got ${clip.notes[0].dur.toFixed(3)})`,
    );
});