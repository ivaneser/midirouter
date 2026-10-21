import test from 'node:test';
import assert from 'node:assert/strict';
import { attachMidiKnob } from '../frontend/js/midi-knob.js';

function knob(value = 0) {
    const listeners = {};
    const sent = [];
    const properties = {};
    const input = {
        min: '0', max: '127', value: String(value),
        addEventListener: (name, fn) => { listeners[name] = fn; },
        setAttribute() {}, focus() {},
        setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {},
    };
    const readout = {};
    attachMidiKnob(input, { style: { setProperty: (key, value) => { properties[key] = value; } } }, readout, value => sent.push(value));
    const pointer = (name, y, extra = {}) => listeners[name]({ button: 0, pointerId: 1, clientY: y, preventDefault() {}, ...extra });
    return { input, listeners, sent, properties, readout, pointer };
}

test('rendering a knob never transmits MIDI; native input updates its value and arc', () => {
    const k = knob();
    assert.deepEqual(k.sent, []);
    k.input.value = '127';
    k.listeners.input();
    assert.deepEqual(k.sent, [127]);
    assert.equal(k.readout.textContent, '127');
    assert.equal(k.properties['--knob-fill'], '270deg');
    assert.equal(k.properties['--knob-angle'], '135deg');
});

test('dragging does not jump on touch and clamps to the MIDI range', () => {
    const k = knob(64);
    k.pointer('pointerdown', 200);
    assert.deepEqual(k.sent, []);
    k.pointer('pointermove', 120);
    assert.equal(k.input.value, '127');
    k.pointer('pointermove', 500);
    assert.equal(k.input.value, '0');
    k.pointer('pointerup', 500);
    k.pointer('pointermove', 100);
    assert.deepEqual(k.sent, [127, 0]);
});

test('Shift precision accumulates small movements rather than discarding them', () => {
    const k = knob(64);
    k.pointer('pointerdown', 200);
    for (let y = 199; y >= 190; y--) k.pointer('pointermove', y, { shiftKey: true });
    assert.equal(k.input.value, '65');
    assert.deepEqual(k.sent, [65], 'only changed values are transmitted');
});

test('a second touch cannot take over a drag; canceled gestures stop changing values', () => {
    const k = knob(64);
    k.pointer('pointerdown', 200);
    k.pointer('pointerdown', 300, { pointerId: 2 });
    k.pointer('pointermove', 250, { pointerId: 2 });
    assert.deepEqual(k.sent, []);
    k.pointer('pointercancel', 200);
    k.pointer('pointermove', 100);
    assert.deepEqual(k.sent, []);
});
