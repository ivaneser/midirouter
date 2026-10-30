import test from 'node:test';
import assert from 'node:assert/strict';
import { bandEnergy, smooth, levelFromRms, BeatDetector } from '../listen/visual.js';

test('bandEnergy averages a slice of the spectrum as 0..1', () => {
    const data = new Uint8Array([0, 255, 255, 0, 0]);
    assert.equal(bandEnergy(data, 1, 3), 1);
    assert.equal(bandEnergy(data, 0, 4), 0.5);
    assert.equal(bandEnergy(data, 3, 3), 0, 'an empty slice is silence');
    assert.equal(bandEnergy(data, 2, 99), 255 / 3 / 255, 'the end is clamped to the data');
});

test('smooth rises faster than it falls', () => {
    assert.ok(smooth(0, 1) > 1 - smooth(1, 0), 'attack is quicker than decay');
    assert.equal(smooth(0.5, 0.5), 0.5);
});

test('levelFromRms maps -55 dBFS..0 dBFS to 0..1', () => {
    assert.equal(levelFromRms(0), 0);
    assert.equal(levelFromRms(1), 1);
    assert.ok(Math.abs(levelFromRms(10 ** (-27.5 / 20)) - 0.5) < 1e-9);
    assert.equal(levelFromRms(10 ** (-80 / 20)), 0);
});

test('a beat is a clear jump in the bass, then a short pause', () => {
    const beats = new BeatDetector();
    for (let i = 0; i < 20; i++) assert.equal(beats.update(0.05, 16), false, 'steady quiet bass is not a beat');
    assert.equal(beats.update(0.7, 16), true, 'a kick');
    assert.equal(beats.update(0.9, 16), false, 'not again within the pause');
    for (let i = 0; i < 12; i++) beats.update(0.05, 16);
    assert.equal(beats.update(0.8, 16), true, 'the next kick');
});

test('a constant loud bass settles: only the first moments count as beats', () => {
    const beats = new BeatDetector();
    let early = 0, late = 0;
    for (let i = 0; i < 400; i++) if (beats.update(0.6, 16)) (i < 60 ? early++ : late++);
    assert.ok(early <= 4, `early ${early}`);
    assert.equal(late, 0, 'once the average has caught up there are no more beats');
});
