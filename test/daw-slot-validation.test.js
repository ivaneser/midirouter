// ---------------------------------------------------------------------------
// Regression: malformed slot-count input must not destroy existing clips.
//
// Contract:
//   setSlotsPerTrack('not-a-number') (a non-numeric, JSON-like string) is
//   invalid input. The engine must reject it without corrupting state: the
//   effective slots-per-track count stays a valid integer and every clip's
//   existing notes survive untouched.
//
// Known defect this locks down: Math.trunc('not-a-number') === NaN, so
// Math.max(1, Math.min(16, NaN)) yields NaN; the subsequent
// `base.length < NaN` comparison is always false and
// track.clips gets reassigned to a freshly sliced (empty) array for every
// track — wiping all recorded notes.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';

test('setSlotsPerTrack with a non-numeric string leaves slots and existing clips intact', () => {
    const daw = new DAWEngine({ tempo: 120 }); // default slotsPerTrack = 2

    // Seed one real note into clip (track 0, slot 0) so there is content to lose.
    const seedNote = { channel: 1, note: 60, velocity: 90, start: 0, dur: 0.5 };
    daw.tracks[0].clips[0].notes.push(seedNote);

    const clipsBefore = daw.tracks.map((t) => t.clips.length);

    // The malformed input under test.
    daw.setSlotsPerTrack('not-a-number');

    // slotsPerTrack must remain a valid positive integer, not NaN.
    assert.ok(Number.isInteger(daw.slotsPerTrack),
        `slotsPerTrack must stay an integer after invalid input, got: ${daw.slotsPerTrack}`);
    assert.equal(daw.slotsPerTrack, 2,
        'slotsPerTrack must be unchanged by invalid input');

    // Every clip array keeps its original length...
    daw.tracks.forEach((t, i) => {
        assert.equal(t.clips.length, clipsBefore[i],
            `track ${i} clip count changed after invalid setSlotsPerTrack`);
    });

    // ...and the seeded note survives in its clip.
    const clip = daw.tracks[0].clips[0];
    assert.equal(clip.notes.length, 1, 'seeded clip must keep exactly one note');
    assert.deepEqual(clip.notes[0], seedNote,
        'the existing note must be unchanged after invalid setSlotsPerTrack');
});

// ---------------------------------------------------------------------------
// Regression: JSON-valid null input must not silently clamp to 1.
//
// Contract:
//   setSlotsPerTrack(null) (a valid JSON value that is not a number) is
//   invalid input. The engine must reject it without corrupting state: the
//   effective slots-per-track count stays unchanged and every clip's
//   existing notes survive untouched.
//
// Known defect this locks down: Math.trunc(null) === 0, so the guard
// `!Number.isFinite(0)` passes and Math.max(1, Math.min(16, 0)) clamps to
// 1 — shrinking a higher slot count (e.g. 4) and truncating clips beyond
// slot 0, destroying recorded notes.
// ---------------------------------------------------------------------------
test('setSlotsPerTrack with null leaves slots and existing clips intact', () => {
    const daw = new DAWEngine({ tempo: 120, slotsPerTrack: 4 });

    // Seed one real note into clip (track 0, slot 3) — beyond where a clamp
    // to 1 would truncate the track.
    const seedNote = { channel: 1, note: 60, velocity: 90, start: 0, dur: 0.5 };
    daw.tracks[0].clips[3].notes.push(seedNote);

    const clipsBefore = daw.tracks.map((t) => t.clips.length);

    // The malformed input under test.
    daw.setSlotsPerTrack(null);

    // slotsPerTrack must remain unchanged, not clamped to 1.
    assert.equal(daw.slotsPerTrack, 4,
        'slotsPerTrack must be unchanged by null input');

    // Every clip array keeps its original length...
    daw.tracks.forEach((t, i) => {
        assert.equal(t.clips.length, clipsBefore[i],
            `track ${i} clip count changed after null setSlotsPerTrack`);
    });

    // ...and the seeded note survives in its clip.
    const clip = daw.tracks[0].clips[3];
    assert.equal(clip.notes.length, 1, 'seeded clip must keep exactly one note');
    assert.deepEqual(clip.notes[0], seedNote,
        'the existing note must be unchanged after null setSlotsPerTrack');
});
