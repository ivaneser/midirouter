import test from 'node:test';
import assert from 'node:assert/strict';
import { SCALES, scaleById, isAllowed, nearestAllowed, fitNotesToScale } from '../frontend/js/scales.js';

const C = 0;

test('there are 40 scales, each listed once, starting on the root and ascending within one octave', () => {
    assert.equal(SCALES.length, 40);
    assert.equal(new Set(SCALES.map(s => s.id)).size, SCALES.length);
    assert.equal(new Set(SCALES.map(s => s.steps.join())).size, SCALES.length, 'no two scales have the same notes');
    for (const s of SCALES) {
        assert.equal(s.steps[0], 0, s.name);
        assert.ok(s.steps.every((v, i) => v >= 0 && v < 12 && (i === 0 || v > s.steps[i - 1])), s.name);
    }
});

test('Western, Indian, Japanese and Arabic scales are all there', () => {
    for (const group of ['Western', 'Indian', 'Japanese', 'Arabic']) {
        assert.ok(SCALES.some(s => s.group === group), group);
    }
    for (const name of ['Bilawal', 'Kafi', 'Bhairav', 'Malkauns', 'Hirajoshi', 'In Sen', 'Yo', 'Hijaz', 'Nikriz', 'Nahawand', 'Kurd']) {
        assert.ok(SCALES.some(s => s.name.includes(name)), name);
    }
    assert.deepEqual(scaleById('in-sen').steps, [0, 1, 5, 7, 10]);
});

test('isAllowed follows the root', () => {
    const major = scaleById('major');
    assert.equal(isAllowed(60, C, major), true);          // C
    assert.equal(isAllowed(61, C, major), false);         // C#
    assert.equal(isAllowed(62, 2, major), true);          // D in D major
    assert.equal(isAllowed(60, 2, major), false);         // C in D major
    assert.equal(isAllowed(61, 2, major), true);          // C# in D major
    assert.equal(isAllowed(61, C, null), true);           // no scale: everything
});

test('nearestAllowed keeps allowed notes and moves others to the closest scale note', () => {
    const major = scaleById('major');
    assert.equal(nearestAllowed(64, C, major), 64);
    assert.equal(nearestAllowed(70, C, major), 69);       // A# sits between A and B: A is calmer
    assert.equal(nearestAllowed(61, C, major), 60);       // C# sits between C and D: the root is calmer
});

test('equal distance goes to the lower tension, not just the lower note', () => {
    const major = scaleById('major');
    // F# (66) is one step from F (65) and G (67): G, the fifth, is calmer than the fourth.
    assert.equal(nearestAllowed(66, C, major), 67);
    // G# (68) between G (fifth) and A (sixth): the fifth is calmer.
    assert.equal(nearestAllowed(68, C, major), 67);
});

test('nearestAllowed stays inside 0-127 and falls back to the note when nothing fits', () => {
    const pent = scaleById('major-pentatonic');
    assert.ok(nearestAllowed(0, 1, pent) >= 0);
    assert.ok(nearestAllowed(127, C, pent) <= 127);
    assert.equal(nearestAllowed(61, C, null), 61);
});

test('fitNotesToScale moves notes and merges ones that collide', () => {
    const major = scaleById('major');
    const notes = [
        { channel: 1, note: 61, start: 0, dur: 1, velocity: 90 },
        { channel: 1, note: 60, start: 0, dur: 1, velocity: 80 },   // 61 also becomes 60: merged
        { channel: 1, note: 66, start: 2, dur: 1, velocity: 70 },
    ];
    const fitted = fitNotesToScale(notes, C, major);
    assert.deepEqual(fitted.map(n => n.note), [60, 67]);
    assert.ok(fitted.every(n => isAllowed(n.note, C, major)));
    assert.equal(notes[0].note, 61, 'the input is not mutated');
});
