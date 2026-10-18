// Recording must follow the audio offset the performer tuned. Clip notes are
// sent audioOffsetMs after their grid time (negative = earlier), so a key the
// performer presses in time with what they hear belongs to grid time
// (press - audioOffsetMs). Stored clip starts must match the beat that was
// audible when the performer pressed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';

function setup(audioOffsetMs) {
    const daw = new DAWEngine({ tempo: 120 }); // 500 ms per beat
    daw.getAudioOffsetMs = () => audioOffsetMs;
    daw.quantizeGrid = 0; // Off: expose the raw timing
    return daw;
}

// Transport already playing (grid anchored at `base`, cycle locked): a new take
// records against that grid, the way the performer hears it.
function playingDaw(t, audioOffsetMs, base) {
    const daw = setup(audioOffsetMs);
    t.after(() => daw.stopTransport());
    daw.playing = true;
    daw._playAnchorTime = base;
    daw._globalCycleLocked = true;
    daw.loopLenBeats = 16;
    return daw;
}

test('a key pressed on the heard beat is recorded at that grid beat (offset -120 ms)', (t) => {
    const base = performance.now();
    const msPerBeat = 500;
    const off = -120;
    const daw = playingDaw(t, off, base);
    // Heard beat k (grid) is at wall time base + k*500 + off, so the press on
    // beat 4 (bar line) is at base + 2000 + off, and beat 6 is heard at base + 3000 + off.
    daw.triggerPad(0, 0, base + 4 * msPerBeat + off);       // starts on bar line 4
    daw.recordEvent(0x90, 60, 100, base + 6 * msPerBeat + off); // heard on beat 6
    daw.recordEvent(0x80, 60, 0, base + 6 * msPerBeat + off + 250);
    daw.triggerPad(0, 0, base + 8 * msPerBeat + off);        // stop on bar line 8

    const note = daw.tracks[0].clips[0].notes[0];
    assert.ok(note, 'note recorded');
    // Relative to the take start (beat 4): heard beat 6 is clip beat 2.
    assert.ok(Math.abs(note.start - 2) < 0.01, `start should be clip beat 2, got ${note.start}`);
});

test('with zero offset the same press is recorded at the same clip beat', (t) => {
    const base = performance.now();
    const msPerBeat = 500;
    const daw = playingDaw(t, 0, base);
    daw.triggerPad(0, 0, base + 4 * msPerBeat);
    daw.recordEvent(0x90, 60, 100, base + 6 * msPerBeat);
    daw.recordEvent(0x80, 60, 0, base + 6 * msPerBeat + 250);
    daw.triggerPad(0, 0, base + 8 * msPerBeat);

    const note = daw.tracks[0].clips[0].notes[0];
    assert.ok(Math.abs(note.start - 2) < 0.01, `got ${note.start}`);
});
