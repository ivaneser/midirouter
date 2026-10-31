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

test('Blofeld name requests carry bank and program; the 16-character name is read from the sound dump', () => {
    const names = new PresetNames(directory);
    const target = 'Waldorf Blofeld:Waldorf Blofeld MIDI 1 24:0';
    assert.deepEqual(names.bankInfo(target), { programs: 1024, cc: 0 });
    assert.deepEqual(names.request(target, 3, 300), [240, 62, 19, 127, 0, 2, 44, 247]);
    const reply = [240, 62, 19, 0, 16, 2, 44, ...Array(383).fill(0), 0, 247];
    [...'Fat Bass'].forEach((c, i) => { reply[370 + i] = c.charCodeAt(0); });
    const wrongProgram = reply.slice();
    wrongProgram[6] = 45;
    assert.equal(names.receive(target, wrongProgram), null);
    assert.deepEqual(names.receive(target, reply), { target, channel: 3, program: 300, name: 'Fat Bass' });
});

test('Craft Synth announces its patch name by itself: nothing is sent, the name broadcast labels the selection', () => {
    const names = new PresetNames(directory);
    const target = 'Craft Synth 2.0:Craft Synth 2.0 MIDI 1 40:0';
    assert.equal(names.request(target, 10, 5), null);
    const data = [240, 0, 33, 7, 104, 2, 0, ...Array(32).fill(1), 247];
    assert.equal(names.receive(target, data), null, 'the data broadcast is not a name');
    const announce = [240, 0, 33, 7, 104, 3, 5, 11, ...Buffer.from('Wobble Bass'), 247];
    assert.deepEqual(names.receive(target, announce), { target, channel: 10, program: 5, name: 'Wobble Bass' });
    assert.equal(names.receive(target, announce), null);
});

test('learn() reads names and sounds nobody asked for, with the program the message carries', () => {
    const names = new PresetNames(directory);
    const craft = 'Craft Synth 2.0:Craft Synth 2.0 MIDI 1 40:0';
    const data = [240, 0, 33, 7, 104, 2, 0, 7, ...Array(40).fill(9), 247];
    assert.deepEqual(names.learn(craft, data), { file: 'modal_craft_synth_v2', program: 7, dump: data });
    const name = [240, 0, 33, 7, 104, 3, 7, 11, ...Buffer.from('Tearout Arp'), 247];
    assert.deepEqual(names.learn(craft, name), { file: 'modal_craft_synth_v2', program: 7, name: 'Tearout Arp' });
    assert.equal(names.learn('Unknown synth', name), null);

    const blofeld = 'Waldorf Blofeld:Waldorf Blofeld MIDI 1 24:0';
    const reply = [240, 62, 19, 0, 16, 2, 44, ...Array(383).fill(0), 0, 247];
    [...'Fat Bass'].forEach((c, i) => { reply[370 + i] = c.charCodeAt(0); });
    const learned = names.learn(blofeld, reply);
    assert.equal(learned.program, 2 * 128 + 44);
    assert.equal(learned.name, 'Fat Bass');
    assert.equal(learned.dump.length, reply.length);
});
