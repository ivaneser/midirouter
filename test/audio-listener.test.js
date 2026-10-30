import test from 'node:test';
import assert from 'node:assert/strict';
import { pcmToFloat, sliderToGain } from '../frontend/js/audio-listener.js';

test('16-bit little-endian samples become floats', () => {
    const { samples, peak, rest } = pcmToFloat(new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0xff, 0x7f]));
    assert.deepEqual([...samples], [0.5, -0.5, 32767 / 32768]);
    assert.equal(peak, 32767 / 32768);
    assert.equal(rest, null);
});

test('an odd trailing byte is carried into the next chunk', () => {
    const first = pcmToFloat(new Uint8Array([0x00, 0x40, 0x00]));
    assert.equal(first.samples.length, 1);
    assert.equal(first.rest, 0x00);
    const second = pcmToFloat(new Uint8Array([0xc0]), first.rest);
    assert.deepEqual([...second.samples], [-0.5]);
    assert.equal(second.rest, null);
});

test('silence has no peak and an empty chunk is harmless', () => {
    assert.equal(pcmToFloat(new Uint8Array([0, 0, 0, 0])).peak, 0);
    assert.equal(pcmToFloat(new Uint8Array([])).samples.length, 0);
});

test('the volume slider is unchanged sound in the middle and boosts up to +24 dB at the end', () => {
    assert.equal(sliderToGain(0), 0);
    assert.equal(sliderToGain(0.25), 0.5);
    assert.equal(sliderToGain(0.5), 1);
    assert.equal(sliderToGain(1), 16);
    assert.ok(Math.abs(20 * Math.log10(sliderToGain(1)) - 24.08) < 0.01);
    assert.equal(sliderToGain(-3), 0, 'out of range is clamped');
    assert.equal(sliderToGain(9), 16);
});
