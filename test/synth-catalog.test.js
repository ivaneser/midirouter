/**
 * synth-catalog.test.js — Focused tests for the synthesizer catalog module.
 *
 * Validates two responsibilities only:
 *  1. Safe classification of output port names into supported synth models
 *     (case-insensitive matching against known ALSA device strings).
 *  2. Render-data shape produced for the UI cards.
 *
 * This test runs BEFORE implementation, so it is expected to FAIL at first.
 * After implementing frontend/js/synth-catalog.js, rerun to confirm GREEN.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// The module under test uses ES modules; import it dynamically per run.
const CATALOG_PATH = '../frontend/js/synth-catalog.js';

let classifySynthPortName, getSynthRenderData;

test.before(async () => {
    const mod = await import(new URL(CATALOG_PATH, import.meta.url).href);
    classifySynthPortName = mod.classifySynthPortName;
    getSynthRenderData = mod.getSynthRenderData;
});

// ---------------------------------------------------------------------------
// Classification tests — supported model names are recognized case-insensitively
// ---------------------------------------------------------------------------

test('Craft Synth is classified as a supported craft-synth card', () => {
    const result = classifySynthPortName('Craft Synth');
    assert.equal(result.supported, true);
    assert.equal(result.model, 'craft-synth');
});

test('classification is case-insensitive: lowercase "craft synth" matches', () => {
    const result = classifySynthPortName('craft synth');
    assert.equal(result.supported, true);
    assert.equal(result.model, 'craft-synth');
});

test('classification is case-insensitive: uppercase "CRAFT SYNTH" matches', () => {
    const result = classifySynthPortName('CRAFT SYNTH');
    assert.equal(result.supported, true);
    assert.equal(result.model, 'craft-synth');
});

test('Korg NTS-1 digital kit is classified as a supported korg-nts-1 card', () => {
    const result = classifySynthPortName('NTS-1 digital kit');
    assert.equal(result.supported, true);
    assert.equal(result.model, 'korg-nts-1');
});

test('Korg NTS-1 with manufacturer prefix is still recognized', () => {
    const result = classifySynthPortName('Korg NTS-1 digital kit');
    assert.equal(result.supported, true);
    assert.equal(result.model, 'korg-nts-1');
});

test('mixed-case "korg nts-1 digital kit" is recognized case-insensitively', () => {
    const result = classifySynthPortName('KORG NTS-1 DIGITAL KIT');
    assert.equal(result.supported, true);
    assert.equal(result.model, 'korg-nts-1');
});

// ---------------------------------------------------------------------------
// Unknown / unsupported names must NOT be guessed
// ---------------------------------------------------------------------------

test('an unknown output port name is classified as unsupported', () => {
    const result = classifySynthPortName('Some Random MIDI Port');
    assert.equal(result.supported, false);
    assert.equal(result.model, null);
});

test('an empty string is classified as unsupported', () => {
    const result = classifySynthPortName('');
    assert.equal(result.supported, false);
    assert.equal(result.model, null);
});

// ---------------------------------------------------------------------------
// Render data — getSynthRenderData produces card objects for supported ports
// ---------------------------------------------------------------------------

test('getSynthRenderData returns card objects with id, name, model, supported', () => {
    const outputs = [
        { id: 'out1', name: 'Craft Synth' },
        { id: 'out2', name: 'NTS-1 digital kit' },
        { id: 'out3', name: 'Some Random MIDI Port' },
    ];
    const cards = getSynthRenderData(outputs);

    assert.equal(cards.length, 3);

    const [craft, korg, unknown] = cards;

    assert.equal(craft.id, 'out1');
    assert.equal(craft.name, 'Craft Synth');
    assert.equal(craft.model, 'craft-synth');
    assert.equal(craft.supported, true);

    assert.equal(korg.id, 'out2');
    assert.equal(korg.name, 'NTS-1 digital kit');
    assert.equal(korg.model, 'korg-nts-1');
    assert.equal(korg.supported, true);

    assert.equal(unknown.id, 'out3');
    assert.equal(unknown.name, 'Some Random MIDI Port');
    assert.equal(unknown.supported, false);
    assert.equal(unknown.model, null);
});

test('empty outputs list yields an empty card list', () => {
    const cards = getSynthRenderData([]);
    assert.ok(Array.isArray(cards));
    assert.equal(cards.length, 0);
});
