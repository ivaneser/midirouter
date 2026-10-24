import test from 'node:test';
import assert from 'node:assert/strict';
import { PresetNames } from '../preset-names.js';

const directory = new URL('../device_maps/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const target = 'Arturia MicroFreak:Arturia MicroFreak MIDI 1 20:0';

test('MicroFreak name requests correlate source, program and sequence', () => {
    const names = new PresetNames(directory);
    const request = names.request(target, 3, 7);
    assert.deepEqual(request, [240, 0, 32, 107, 7, 1, 0, 3, 25, 0, 7, 0, 247]);
    const reply = [240, 0, 32, 107, 7, 1, 0, 26, 82, ...Array(26).fill(0), 247];
    reply[10] = 7;
    [...'Warm Pad'].forEach((c, i) => { reply[21 + i] = c.charCodeAt(0); });
    assert.equal(names.receive('Other synth', reply), null);
    assert.equal(names.receive(target, reply.slice(0, 15)), null);
    assert.deepEqual(names.receive(target, reply), { target, channel: 3, program: 7, name: 'Warm Pad' });
    assert.equal(names.receive(target, reply), null);
    names.request(target, 3, 8);
    assert.equal(names.receive(target, reply), null, 'late reply must not label a newer selection');
    assert.equal(names.request('Unknown device', 1, 0), null);
});

test('MicroFreak name requests above 128 carry the bank byte and check the reply bank', () => {
    const names = new PresetNames(new URL('../device_maps', import.meta.url).pathname);
    const target = 'Arturia MicroFreak MIDI 1';
    assert.deepEqual(names.bankInfo(target), { programs: 512, cc: 0 });
    const request = names.request(target, 1, 300);
    assert.equal(request[9], 2);
    assert.equal(request[10], 44);
    const reply = [240, 0, 32, 107, 7, 1, request[6], 0, 82, 1, 44, ...new Array(10).fill(0), ...Buffer.from('Bank Two Patch'), 0, 247];
    assert.equal(names.receive(target, reply), null, 'wrong bank is rejected');
});
