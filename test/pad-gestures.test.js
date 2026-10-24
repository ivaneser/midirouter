import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWUI } from '../frontend/js/daw-ui.js';

function setup() {
    const listeners = { grid: {}, document: {} };
    const cells = { '0,0': { dataset: { track: '0', slot: '0' } }, '0,1': { dataset: { track: '0', slot: '1' } } };
    for (const cell of Object.values(cells)) cell.closest = () => cell;
    let under = null;
    globalThis.document = {
        getElementById: () => ({ addEventListener: (type, fn) => { listeners.grid[type] = fn; } }),
        addEventListener: (type, fn) => { listeners.document[type] = fn; },
        elementFromPoint: () => under,
    };
    const ui = Object.create(DAWUI.prototype);
    const sent = [];
    ui._send = message => sent.push(message);
    ui.dawState = { tracks: [{ clips: [{ notes: 0 }, { notes: 4 }], playing: false }], recording: null, recordMode: 'replace' };
    ui._bindPadGestures();
    const press = (id, cell) => listeners.grid.pointerdown({ pointerId: id, target: cells[cell], button: 0 });
    const release = (id, cell) => { under = cells[cell]; listeners.document.pointerup({ pointerId: id, clientX: 1, clientY: 1 }); };
    return { ui, sent, press, release };
}

test('two pads pressed at once both trigger independently', () => {
    const { sent, press, release } = setup();
    press(1, '0,0');
    press(2, '0,1');
    release(2, '0,1');
    release(1, '0,0');
    assert.deepEqual(sent.map(m => [m.type, m.slot]), [['daw-pad-trigger', 1], ['daw-pad-trigger', 0]]);
});

test('a release elsewhere is not a tap, and holding a recorded clip clears it instead', async t => {
    const { sent, press, release } = setup();
    press(1, '0,0');
    release(1, '0,1');
    assert.equal(sent.length, 0);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    press(2, '0,1');
    t.mock.timers.tick(600);
    release(2, '0,1');
    assert.deepEqual(sent.map(m => m.type), ['daw-clear-clip']);
});
