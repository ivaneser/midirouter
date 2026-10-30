import test from 'node:test';
import assert from 'node:assert/strict';
import { pcmToFloat, sliderToGain } from '../frontend/js/audio-listener.js';

test('16-bit little-endian samples become floats', () => {
    const { samples, peak, rest } = pcmToFloat(new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0xff, 0x7f]));
    assert.deepEqual([...samples], [0.5, -0.5, 32767 / 32768]);
    assert.equal(peak, 32767 / 32768);
    assert.equal(rest, null);
});

test('a partial frame is carried into the next chunk (mono)', () => {
    const first = pcmToFloat(new Uint8Array([0x00, 0x40, 0x00]));
    assert.equal(first.samples.length, 1);
    assert.deepEqual([...first.rest], [0x00]);
    const second = pcmToFloat(new Uint8Array([0xc0]), first.rest);
    assert.deepEqual([...second.samples], [-0.5]);
    assert.equal(second.rest, null);
});

test('silence has no peak and an empty chunk is harmless', () => {
    assert.equal(pcmToFloat(new Uint8Array([0, 0, 0, 0])).peak, 0);
    assert.equal(pcmToFloat(new Uint8Array([])).samples.length, 0);
});

test('stereo frames are split into left and right', () => {
    // frames: (L 0.5, R -0.5), (L 0.25, R 0)
    const { channels, peak, rest } = pcmToFloat(new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0x00, 0x20, 0x00, 0x00]), null, 2);
    assert.equal(channels.length, 2);
    assert.deepEqual([...channels[0]], [0.5, 0.25]);
    assert.deepEqual([...channels[1]], [-0.5, 0]);
    assert.equal(peak, 0.5);
    assert.equal(rest, null);
});

test('a stereo chunk that ends inside a frame carries the missing part over', () => {
    const first = pcmToFloat(new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0x00, 0x20]), null, 2);   // one frame + 2 bytes
    assert.equal(first.channels[0].length, 1);
    assert.deepEqual([...first.rest], [0x00, 0x20]);
    const second = pcmToFloat(new Uint8Array([0x00, 0x00]), first.rest, 2);
    assert.deepEqual([...second.channels[0]], [0.25]);
    assert.deepEqual([...second.channels[1]], [0]);
    assert.equal(second.rest, null);
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
