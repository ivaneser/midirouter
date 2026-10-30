import test from 'node:test';
import assert from 'node:assert/strict';
import { pcmToFloat } from '../frontend/js/audio-listener.js';

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
