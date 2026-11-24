import test from 'node:test';
import assert from 'node:assert/strict';
import { sliderToGain } from '../frontend/js/audio-listener.js';

test('the volume slider is unchanged sound in the middle and boosts up to +24 dB at the end', () => {
    assert.equal(sliderToGain(0), 0);
    assert.equal(sliderToGain(0.25), 0.5);
    assert.equal(sliderToGain(0.5), 1);
    assert.equal(sliderToGain(1), 16);
    assert.ok(Math.abs(20 * Math.log10(sliderToGain(1)) - 24.08) < 0.01);
    assert.equal(sliderToGain(-3), 0, 'out of range is clamped');
    assert.equal(sliderToGain(9), 16);
});
