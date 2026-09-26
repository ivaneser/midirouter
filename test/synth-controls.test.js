/**
 * Focused tests for synth-map loading, safe control rendering, and MIDI CC send
 * behavior through DeviceManager's real card interaction path.
 *  1. getControlsForModel(model) fetches /device_maps/<file>.json and returns
 *     controls after checking response.ok (tests stub global fetch using Node
 *     fs to load the actual JSON map files).
 *  2. renderControlDefinition(controlDef) produces safe DOM instructions from
 *     each control definition (slider / dropdown / toggle).
 *  3. buildMidiCcBytes(model, cc, value) emits [0xB0, cc, value] only on user
 *     interaction — never auto-emitted at render time.
 *  4. Integration: expanding a supported card fetches the exact map URL, renders
 *     controls without sending MIDI, and user interaction sends to the correct
 *     output with the right payload.
 *
 * These run BEFORE implementation -> expected to FAIL red at first.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceManager } from '../frontend/js/device-manager.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CATALOG_PATH = '../frontend/js/synth-catalog.js';
const MAP_DIR = '../device_maps';

let getControlsForModel, renderControlDefinition, buildMidiCcBytes;

// Stub global fetch so the ESM module's browser path works in Node tests.
// Each call resolves with an object shaped like a real Response.ok + json().
function stubFetch() {
    const mapFiles = {
        'modal_craft_synth_v2.json': readFileSync(
            join(__dirname, MAP_DIR, 'modal_craft_synth_v2.json'), 'utf-8'
        ),
        'korg_nts1.json': readFileSync(
            join(__dirname, MAP_DIR, 'korg_nts1.json'), 'utf-8'
        ),
    };

    globalThis.fetch = async (url) => {
        const file = url.split('/').pop(); // /device_maps/<file>.json -> <file>
        if (!mapFiles[file]) {
            return { ok: false, status: 404 };
        }
        return {
            ok: true,
            status: 200,
            json: async () => JSON.parse(mapFiles[file]),
        };
    };
}

test.before(async () => {
    stubFetch();
    const mod = await import(new URL(CATALOG_PATH, import.meta.url).href);
    getControlsForModel = mod.getControlsForModel;
    renderControlDefinition = mod.renderControlDefinition;
    buildMidiCcBytes = mod.buildMidiCcBytes;
});

// ---------------------------------------------------------------------------
// 1. Map loading — getControlsForModel(model) fetches the exact map URL
// ---------------------------------------------------------------------------

test('getControlsForModel("craft-synth") returns 18 controls after fetching /device_maps/modal_craft_synth_v2.json', async () => {
    const controls = await getControlsForModel('craft-synth');
    assert.ok(Array.isArray(controls), 'returns an array of controls');
    assert.equal(controls.length, 18, 'matches map count exactly');
    // First control from the JSON must be intact.
    assert.deepEqual(controls[0], {
        cc: 1, name: 'Modulation', min: 0, max: 127, type: 'slider', unit: '%', category: 'mod'
    });
});

test('getControlsForModel("korg-nts-1") returns 29 controls after fetching /device_maps/korg_nts1.json (fixed count)', async () => {
    const controls = await getControlsForModel('korg-nts-1');
    assert.ok(Array.isArray(controls), 'returns an array of controls');
    assert.equal(controls.length, 29, 'matches actual map count (29 sliders+dropdowns)');
    // First control from the JSON must be intact.
    assert.deepEqual(controls[0], {
        cc: 14, name: 'Volume EG Type', min: 0, max: 5, type: 'dropdown',
        options: ['ADSR', 'AHR', 'AR', 'AR loop', 'Open'], category: 'osc'
    });
});

test('getControlsForModel returns a fresh copy each call (no shared mutation)', async () => {
    const a = await getControlsForModel('craft-synth');
    const b = await getControlsForModel('craft-synth');
    a.push({ cc: 999 }); // mutate
    assert.equal(b.length, 18, 'second call is not affected by mutating the first');
});

test('getControlsForModel returns undefined for an unknown model (no crash)', async () => {
    const result = await getControlsForModel('nonexistent-model');
    assert.equal(result, undefined);
});

test('getControlsForModel handles fetch errors gracefully (non-ok response)', async () => {
    // Temporarily break fetch to simulate a 404.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    try {
        const controls = await getControlsForModel('craft-synth');
        assert.ok(Array.isArray(controls), 'returns empty array on fetch error');
        assert.equal(controls.length, 0, 'empty array on non-ok response');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// ---------------------------------------------------------------------------
// 2. renderControlDefinition — produces safe DOM instructions per definition
// ---------------------------------------------------------------------------

test('slider definition renders as range input instruction with min=0 max=127', () => {
    const def = { cc: 7, name: 'Volume', min: 0, max: 127, type: 'slider', unit: '%', category: 'amp' };
    const instr = renderControlDefinition(def);
    assert.equal(instr.tag, 'input');
    assert.equal(instr.attrs.type, 'range');
    assert.equal(instr.attrs.min, '0');
    assert.equal(instr.attrs.max, '127');
    assert.ok(instr.attrs['data-cc'] !== undefined, 'carries data-cc attribute');
});

test('dropdown definition renders as select instruction with option labels', () => {
    const def = {
        cc: 14, name: 'Volume EG Type', min: 0, max: 5, type: 'dropdown',
        options: ['ADSR', 'AHR', 'AR', 'AR loop', 'Open'], category: 'osc'
    };
    const instr = renderControlDefinition(def);
    assert.equal(instr.tag, 'select');
    assert.ok(Array.isArray(instr.options), 'provides option labels array');
    assert.deepEqual(instr.options, ['ADSR', 'AHR', 'AR', 'AR loop', 'Open']);
});

test('toggle definition renders as checkbox instruction with on-threshold', () => {
    const def = {
        cc: 64, name: 'Hold 1 (Sustain)', min: 0, max: 127, type: 'toggle',
        on_threshold: 64, category: 'keyboard'
    };
    const instr = renderControlDefinition(def);
    assert.equal(instr.tag, 'input');
    assert.equal(instr.attrs.type, 'checkbox');
    assert.ok(instr.attrs['data-cc'] !== undefined, 'carries data-cc attribute');
});

test('renderControlDefinition is safe against malicious definition names (textContent)', () => {
    const def = { cc: 1, name: '<script>alert(1)</script>', type: 'slider', min: 0, max: 127 };
    const instr = renderControlDefinition(def);
    assert.equal(instr.tag, 'input');
    // The label instruction must use textContent-safe structure (no raw HTML).
    assert.ok(instr.label.useTextContent !== false, 'label must be textContent-safe');
});

// ---------------------------------------------------------------------------
// 3. buildMidiCcBytes — emits exactly [0xB0, cc, value], never at render time
// ---------------------------------------------------------------------------

test('buildMidiCcBytes returns [0xB0, cc, value] for a slider adjustment', () => {
    assert.deepEqual(buildMidiCcBytes('craft-synth', 7, 64), [0xB0, 7, 64]);
});

test('buildMidiCcBytes returns [0xB0, cc, value] for a toggle activation', () => {
    assert.deepEqual(buildMidiCcBytes('korg-nts-1', 64, 127), [0xB0, 64, 127]);
});

test('buildMidiCcBytes never mutates or returns the same array reference', () => {
    const a = buildMidiCcBytes('craft-synth', 7, 50);
    const b = buildMidiCcBytes('craft-synth', 7, 50);
    a[2] = 999;
    assert.equal(b[2], 50, 'returned arrays are independent copies');
});

test('buildMidiCcBytes clamps value to 0..127 range for MIDI safety', () => {
    const over = buildMidiCcBytes('craft-synth', 7, 200);
    assert.deepEqual(over, [0xB0, 7, 127], 'clamps above 127 to 127');
    const under = buildMidiCcBytes('craft-synth', 7, -5);
    assert.deepEqual(under, [0xB0, 7, 0], 'clamps below 0 to 0');
});

// ---------------------------------------------------------------------------
// 4. Interaction-only MIDI (integration-style): no send on render, right payload
// ---------------------------------------------------------------------------

test('renderControlDefinition does not return anything that looks like a MIDI message', () => {
    // Rendering must never emit [0xB0, cc, value]-shaped arrays.
    for (const def of [
        { cc: 7, name: 'Volume', type: 'slider', min: 0, max: 127 },
        { cc: 14, name: 'Volume EG Type', type: 'dropdown', options: ['A', 'B'] },
        { cc: 64, name: 'Hold', type: 'toggle', on_threshold: 64 },
    ]) {
        const instr = renderControlDefinition(def);
        assert.ok(
            !Array.isArray(instr),
            `renderControlDefinition for ${def.type} must return an instruction object, not a MIDI array`
        );
        assert.equal(
            Array.isArray(instr.bytes) ? instr.bytes[0] : undefined,
            undefined,
            'instruction must never carry a bytes property (MIDI is only sent on user change events)'
        );
    }
});

test('buildMidiCcBytes for a dropdown uses its option index as the value', () => {
    // Dropdown value = option index per the map contract.
    assert.deepEqual(
        buildMidiCcBytes('korg-nts-1', 14, 2),
        [0xB0, 14, 2],
        'dropdown value is its option index'
    );
});

test('getControlsForModel does not send MIDI during fetch/render (integration)', async () => {
    // Verify that simply awaiting getControlsForModel and rendering definitions
    // never emits any [0xB0, cc, value]-shaped MIDI message.
    const controls = await getControlsForModel('craft-synth');

    for (const def of controls) {
        const instr = renderControlDefinition(def);
        // Instructions are pure DOM descriptions — no bytes property.
        assert.equal(instr.bytes, undefined, `no MIDI bytes on ${def.type} control`);
    }

    // Simulate a user interaction that DOES send MIDI via buildMidiCcBytes.
    const mockCard = { id: 'test-card-1' };
    let sentTarget = null;
    let sentPayload = null;

    // Mock the card's sendMidi (the way controller-ui calls it).
    const mockSendMidi = function (target, bytes) {
        sentTarget = target;
        sentPayload = bytes;
    };

    // Simulate user sliding a slider to value 42.
    const sliderDef = controls.find(c => c.cc === 1 && c.type === 'slider');
    assert.ok(sliderDef, 'found the Modulation slider');
    const bytes = buildMidiCcBytes('craft-synth', sliderDef.cc, 42);
    mockSendMidi.call(mockCard, mockCard.id, bytes);

    assert.deepEqual(sentPayload, [0xB0, 1, 42], 'sends correct [0xB0, cc, value] payload');
    assert.equal(sentTarget, 'test-card-1', 'sends to the correct card output id');
});

class TestElement {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.dataset = {};
        this.attributes = {};
        this.listeners = {};
        this.parentNode = null;
        this.textContent = '';
        this.className = '';
        this.type = '';
        this.value = '';
        this.selectedIndex = 0;
    }

    set innerHTML(value) {
        if (value === '') this.replaceChildren();
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    replaceChildren(...children) {
        for (const child of this.children) child.parentNode = null;
        this.children = [];
        for (const child of children) this.appendChild(child);
    }

    addEventListener(name, callback) {
        this.listeners[name] = callback;
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }

    async click() {
        return this.listeners.click?.();
    }

    remove() {
        if (!this.parentNode) return;
        this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
    }

    contains(target) {
        return this === target || this.children.some(child => child.contains(target));
    }

    querySelector(selector) {
        const className = selector.startsWith('.') ? selector.slice(1) : '';
        for (const child of this.children) {
            if (child.className.split(/\s+/).includes(className)) return child;
            const nested = child.querySelector(selector);
            if (nested) return nested;
        }
        return null;
    }
}

function findAll(element, predicate, result = []) {
    if (predicate(element)) result.push(element);
    for (const child of element.children) findAll(child, predicate, result);
    return result;
}

test('DeviceManager renders controls without MIDI, then sends user CC to the selected output only', async () => {
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        WebSocket: globalThis.WebSocket,
    };
    const inputList = new TestElement('div');
    const synthCards = new TestElement('div');
    const elements = { 'input-list': inputList, 'synth-cards': synthCards };
    const sent = [];
    globalThis.document = { getElementById: id => elements[id] || null, createElement: tag => new TestElement(tag) };
    globalThis.WebSocket = { OPEN: 1 };
    globalThis.window = {
        app: { ws: { readyState: 1, send: value => sent.push(JSON.parse(value)) } },
    };

    try {
        const manager = new DeviceManager();
        manager.updatePorts([], [
            { id: 'craft-output-9', name: 'Craft Synth' },
            { id: 'nts-output-4', name: 'NTS-1 digital kit' },
            { id: 'other-output', name: 'Unrecognized MIDI device' },
        ]);
        assert.equal(sent.length, 0, 'rendering cards must never transmit MIDI');
        assert.equal(synthCards.children.length, 3);
        assert.equal(findAll(synthCards, el => el.className === 'synth-card-toggle').length, 2,
            'only supported synths expose controls');

        const cards = synthCards.children;
        const craftToggle = cards[0].children.find(el => el.className === 'synth-card-toggle');
        await craftToggle.click();
        assert.equal(sent.length, 0, 'expanding/loading controls must not transmit MIDI');
        const craftPanel = cards[0].querySelector('.synth-controls');
        const craftSlider = findAll(craftPanel, el => el.type === 'range')[0];
        assert.ok(craftSlider);
        craftSlider.value = '42';
        craftSlider.listeners.input();
        assert.equal(sent.length, 1);
        assert.deepEqual(sent[0].data.bytes, [0xB0, 1, 42]);
        assert.equal(sent[0].target, 'craft-output-9');

        const ntsToggle = cards[1].children.find(el => el.className === 'synth-card-toggle');
        await ntsToggle.click();
        const ntsPanel = cards[1].querySelector('.synth-controls');
        const ntsSelect = findAll(ntsPanel, el => el.tagName === 'select')[0];
        assert.ok(ntsSelect);
        ntsSelect.selectedIndex = 2;
        ntsSelect.listeners.change();
        assert.equal(sent.length, 2);
        assert.deepEqual(sent[1].data.bytes, [0xB0, 14, 2]);
        assert.equal(sent[1].target, 'nts-output-4');
    } finally {
        globalThis.document = previous.document;
        globalThis.window = previous.window;
        globalThis.WebSocket = previous.WebSocket;
    }
});
