import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DeviceManager } from '../frontend/js/device-manager.js';

const catalog = JSON.parse(readFileSync(new URL('../device_maps/presets/waldorf_blofeld.json', import.meta.url), 'utf8'));

test('every Blofeld preset has a sound group, and the groups are a usable handful', () => {
    const groups = new Map();
    for (const preset of Object.values(catalog.presets)) groups.set(preset.group, (groups.get(preset.group) || 0) + 1);
    assert.equal(Object.keys(catalog.presets).length, 1024);
    assert.ok(!groups.has(undefined), 'no preset without a group');
    assert.ok(groups.size >= 10 && groups.size <= 20, `${groups.size} groups`);
    for (const [name, count] of groups) assert.ok(count >= 10, `${name} has only ${count} presets`);
});

test('well-known presets land in the expected group', () => {
    const group = number => catalog.presets[String(number)].group;
    assert.equal(group(26), 'Bells');       // PPG Bells
    assert.equal(group(53), 'Organ');       // Dirty Organ
    assert.equal(group(542), 'Guitar');     // Guitar 1
    assert.equal(group(954), 'Drums');      // Bass Drum
    assert.equal(group(708), 'Bass');       // 2Step Bass
    assert.equal(group(370), 'Pads');       // Airpad
});

test('programsInGroup filters by group, and "All" or a device without groups lists everything', () => {
    const manager = Object.create(DeviceManager.prototype);
    manager.presetCounts = new Map([['dev', 6]]);
    manager.presetGroups = new Map([['dev', { 1: 'Pads', 2: 'Bass', 3: 'Pads', 4: 'Bass', 5: 'Bass', 6: 'Leads' }]]);
    assert.deepEqual(manager.programsInGroup('dev', 'Pads'), [0, 2]);
    assert.deepEqual(manager.programsInGroup('dev', ''), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(manager.programsInGroup('other', 'Pads', 3), [0, 1, 2]);
});

test('Craft Synth presets are grouped too, with Misc for the ones that fit nowhere', () => {
    const craft = JSON.parse(readFileSync(new URL('../device_maps/presets/modal_craft_synth_v2.json', import.meta.url), 'utf8'));
    assert.equal(Object.keys(craft.presets).length, 64);
    assert.equal(craft.presets['10'].group, 'Bass');   // Larry's Bass
    assert.equal(craft.presets['64'].group, 'Misc');   // Init Patch
    assert.ok(Object.values(craft.presets).every(preset => preset.group));
});

test('PreenFM2 presets carry the names read from the synth and a group each', () => {
    const pfm = JSON.parse(readFileSync(new URL('../device_maps/presets/preenfm2.json', import.meta.url), 'utf8'));
    assert.equal(Object.keys(pfm.presets).length, 1024);
    assert.ok(Object.values(pfm.presets).every(preset => preset.name && preset.group));
    assert.deepEqual(pfm.presets['1'], { name: 'A.G.PIANO', group: 'Keys' });
    assert.equal(pfm.presets['19'].group, 'Organ');               // ROCK ORG
    assert.equal(pfm.presets['49'].group, 'Strings & Choir');     // STRG ENS.2
    assert.equal(pfm.presets['1024'].group, 'Bass');              // WOBBLEBASS
});
