// quantizeClip snaps note starts to the configured grid (in beats, quarter
// note = 1): 0.3 -> 0.25 at gridSize 0.25 and at 0.125
// (0.3/0.125 = 2.4 -> round -> 2 -> 0.25); grid 2 snaps 1.2 to 2;
// the default grid 0.5 (1/8) snaps 0.3 to 0.5; grid 0 (Off) leaves starts alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';

test('quantizeClip snaps note start to the configured grid', () => {
    const daw = new DAWEngine({ tempo: 120 }); // 500 ms per beat
    assert.equal(daw.quantizeGrid, 0.5, 'default quantization grid is 1/8');
    const clip = daw.tracks[0].clips[0];

    // gridSize 0.25 (1/16): round(0.3 / 0.25) = 1 -> 0.25.
    clip.notes.push({ channel: 1, note: 60, velocity: 90, start: 0.3, dur: 0.4 });
    daw.quantizeClip(0, 0, 0.25);
    assert.equal(daw.tracks[0].clips[0].notes[0].start, 0.25);

    // gridSize 0.125 (1/32): 0.3 / 0.125 = 2.4 -> round -> 2 -> 0.25.
    clip.notes.length = 0;
    clip.notes.push({ channel: 1, note: 60, velocity: 90, start: 0.3, dur: 0.4 });
    daw.quantizeClip(0, 0, 0.125);
    assert.equal(daw.tracks[0].clips[0].notes[0].start, 0.25);

    // default gridSize 0.5 (1/8): 0.3 / 0.5 = 0.6 -> round -> 1 -> 0.5.
    clip.notes.length = 0;
    clip.notes.push({ channel: 1, note: 60, velocity: 90, start: 0.3, dur: 0.4 });
    daw.quantizeClip(0, 0);
    assert.equal(daw.tracks[0].clips[0].notes[0].start, 0.5);

    // Off (gridSize 0): start is kept (only rounded to the hundredth).
    clip.notes.length = 0;
    clip.notes.push({ channel: 1, note: 60, velocity: 90, start: 0.3, dur: 0.4 });
    daw.quantizeClip(0, 0, 0);
    assert.equal(daw.tracks[0].clips[0].notes[0].start, 0.3);

    // grid 2 (1/2): round(1.2 / 2) = 1 -> 2.
    clip.notes.length = 0;
    clip.notes.push({ channel: 1, note: 60, velocity: 90, start: 1.2, dur: 0.4 });
    daw.quantizeClip(0, 0, 2);
    assert.equal(daw.tracks[0].clips[0].notes[0].start, 2);
});
