import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { groupSynthControls } from '../frontend/js/synth-layout.js';
import { classifySynthPortName } from '../frontend/js/synth-catalog.js';

test('MicroFreak detection accepts manufacturer and ALSA port names without confusing MiniFreak', () => {
    for (const name of ['MicroFreak', 'Arturia MicroFreak:Arturia MicroFreak MIDI 1 24:0', 'ARTURIA MICRO FREAK']) {
        assert.deepEqual(classifySynthPortName(name), { supported: true, model: 'arturia-microfreak' });
    }
    assert.equal(classifySynthPortName('Arturia MiniFreak').supported, false);
});

test('MicroFreak groups follow the sound-design order with its cycling envelope beside envelope', () => {
    const { controls } = JSON.parse(readFileSync(new URL('../device_maps/arturia_microfreak.json', import.meta.url)));
    assert.deepEqual(groupSynthControls(controls).map(group => group.category), ['osc', 'filter', 'env', 'cycl_env', 'lfo', 'glide', 'keyboard', 'arp']);
});

test('NTS-1 follows oscillator, shaping, envelope, effects, modulation, performance order', () => {
    const { controls } = JSON.parse(readFileSync(new URL('../device_maps/korg_nts1.json', import.meta.url)));
    const groups = groupSynthControls(controls);
    assert.deepEqual(groups.map(group => group.category), [
        'osc', 'filter', 'env', 'fx', 'fx_mod', 'delay', 'fx_delay',
        'reverb', 'fx_reverb', 'mix', 'mod', 'lfo', 'sweep', 'tremolo', 'arp',
    ]);
    assert.equal(groups.flatMap(group => group.controls).length, controls.length);
    for (const group of groups) {
        assert.deepEqual(group.controls, controls.filter(control => control.category === group.category));
    }
});

test('Craft Synth presents sound and tone before effects, modulation and keyboard controls', () => {
    const { controls } = JSON.parse(readFileSync(new URL('../device_maps/modal_craft_synth_v2.json', import.meta.url)));
    assert.deepEqual(groupSynthControls(controls).map(group => group.category), [
        'sound', 'filter', 'amp', 'env', 'fx', 'mod', 'vibrato', 'portamento', 'keyboard',
    ]);
});

test('new and uncategorized controls remain available after known groups without mutating the map', () => {
    const controls = [{ cc: 1, category: 'new_category' }, { cc: 2 }, { cc: 3, category: 'osc' }];
    const snapshot = structuredClone(controls);
    const groups = groupSynthControls(controls);
    assert.deepEqual(groups.map(group => group.category), ['osc', 'new_category', 'parameters']);
    assert.deepEqual(controls, snapshot);
    assert.equal(groups[1].label, 'new category');
});
