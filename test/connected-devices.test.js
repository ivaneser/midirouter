import test from 'node:test';
import assert from 'node:assert/strict';
import { connectedDevices, uniquePorts } from '../frontend/js/connected-devices.js';

test('input/output pairs appear once and use the output target for their controls', () => {
    const cards = connectedDevices([{ id: 'input', name: 'Craft Synth' }], [{ id: 'output', name: 'Craft Synth' }]);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].id, 'output');
    assert.equal(cards[0].input, true);
    assert.equal(cards[0].output, true);
});

test('case and whitespace variations do not duplicate an input/output pair', () => {
    assert.equal(connectedDevices([{ id: 'in', name: '  NTS-1   digital kit ' }], [{ id: 'out', name: 'nts-1 digital kit' }]).length, 1);
});

test('repeated inventory IDs are removed without mutating names or caller arrays', () => {
    const input = [{ id: 'a', name: 'Device  A' }, { id: 'a', name: 'Device  A' }];
    assert.deepEqual(uniquePorts(input), [input[0]]);
    assert.equal(input.length, 2);
    assert.equal(input[0].name, 'Device  A');
    assert.deepEqual(uniquePorts(null), []);
});

test('repeated ALSA device prefixes are cleaned for display while real names stay intact', () => {
    const name = 'NTS-1 digital kit:NTS-1 digital kit _ SOUND 20:0';
    const card = connectedDevices([], [{ id: name, name }])[0];
    assert.equal(card.displayName, 'NTS-1 digital kit · SOUND');
    assert.equal(card.name, name);
    assert.equal(card.id, name);
});

test('separate physical instances retain separate cards with distinct display names', () => {
    const ports = [20, 28].map(address => ({ id: String(address), name: `NTS-1 digital kit:NTS-1 digital kit _ SOUND ${address}:0` }));
    const cards = connectedDevices(ports, ports);
    assert.equal(cards.length, 2);
    assert.deepEqual(cards.map(c => c.displayName), ['NTS-1 digital kit · SOUND (20:0)', 'NTS-1 digital kit · SOUND (28:0)']);
});

test('same-name devices with different IDs are paired one-to-one rather than merged', () => {
    const cards = connectedDevices([{ id: 'in1', name: 'USB MIDI' }, { id: 'in2', name: 'USB MIDI' }], [{ id: 'out1', name: 'USB MIDI' }, { id: 'out2', name: 'USB MIDI' }]);
    assert.equal(cards.length, 2);
    assert.equal(new Set(cards.map(c => c.displayName)).size, 2);
    assert.deepEqual(cards.map(c => c.id), ['out1', 'out2']);
});

test('Launchkey performance and DAW ports remain distinct', () => {
    const cards = connectedDevices([], [
        { id: 'midi', name: 'Launchkey Mini MK3:Launchkey Mini MK3 MIDI 1 24:0' },
        { id: 'daw', name: 'Launchkey Mini MK3:Launchkey Mini MK3 DAW 24:1' },
    ]);
    assert.equal(cards.length, 2);
    assert.deepEqual(cards.map(c => c.displayName), ['Launchkey Mini MK3 · MIDI 1', 'Launchkey Mini MK3 · DAW']);
});
