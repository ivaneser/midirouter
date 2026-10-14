import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';

test('master loop bar setting fixes the shared cycle and clip lengths', () => {
    const daw = new DAWEngine();
    assert.equal(daw.setMasterLoopBars(2), true);
    assert.equal(daw.masterLoopBars, 2);
    assert.equal(daw.loopLenBeats, 8);
    assert.equal(daw._globalCycleLocked, true);
    assert.equal(daw.tracks[0].clips[0].length, 8);
    assert.equal(daw.setMasterLoopBars(0), false);
    assert.equal(daw.setMasterLoopBars(2.5), false);
});

test('locked-cycle recording ignores MIDI until the next bar and loops for the master length', () => {
    const daw = new DAWEngine({ tempo: 120 });
    daw.setMasterLoopBars(2);
    daw.startTransport();
    const now = performance.now();
    daw._playAnchorTime = now - 500; // transport is at beat 1 of bar 1

    daw.setRecordMode('replace');
    const result = daw.triggerPad(0, 0, now);
    assert.equal(result.action, 'record');
    assert.equal(daw.recording.startBeat, 4);
    assert.ok(daw.recording.startTime >= now + 1490, 'recording begins at bar 2, not on button press');
    assert.equal(daw.recordEvent(0x90, 60, 90, now + 1000), false, 'pre-bar MIDI is ignored');

    const start = daw.recording.startTime;
    assert.equal(daw.recordEvent(0x90, 60, 90, start + 250), true);
    assert.equal(daw.recordEvent(0x80, 60, 0, start + 500), true);
    daw._stopRecording(5);
    assert.equal(daw.tracks[0].clips[0].length, 8, 'clip repeats for the selected two-bar master cycle');
    daw.stopTransport();
});
