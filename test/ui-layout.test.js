import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UiLayoutSettings } from '../ui-layout.js';
import { applyOrder, sectionKey } from '../frontend/js/section-order.js';

test('section order survives a restart and rejects junk keys', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'layout-')), 'ui-layout.json');
    const a = new UiLayoutSettings(path);
    assert.deepEqual(a.order, []);
    a.set(['devices', 'session', 'devices', '../x', 5]);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).order, ['devices', 'session']);
    assert.deepEqual(new UiLayoutSettings(path).order, ['devices', 'session']);
});

test('saved order is applied; new sections keep their place after the known ones', () => {
    assert.deepEqual(applyOrder(['session', 'piano-roll', 'devices'], ['devices', 'gone']), ['devices', 'session', 'piano-roll']);
    assert.deepEqual(applyOrder(['a', 'b'], undefined), ['a', 'b']);
});

test('a section that is new to the saved order lands right after the section before it in the page', () => {
    const page = ['session', 'piano-roll', 'keyboard', 'clock', 'devices', 'audio', 'config', 'help', 'logs'];
    const saved = ['session', 'keyboard', 'piano-roll', 'devices', 'clock', 'config', 'help', 'logs'];   // the order chosen on the Pi
    assert.deepEqual(applyOrder(page, saved), ['session', 'keyboard', 'piano-roll', 'devices', 'audio', 'clock', 'config', 'help', 'logs'],
        'MIDI audio sits between MIDI devices and MIDI clock');
    assert.deepEqual(applyOrder(page, undefined), page, 'no saved order: the page order');
    assert.deepEqual(applyOrder(page, ['logs']), ['logs', 'session', 'piano-roll', 'keyboard', 'clock', 'devices', 'audio', 'config', 'help'],
        'with nothing saved around it, new sections keep their order after the known ones');
    assert.deepEqual(applyOrder(['a', 'b', 'c'], ['c', 'gone', 'a']), ['c', 'a', 'b'], 'b follows a, its neighbour in the page');
});

test('the MIDI audio section is a reorderable section like the others', () => {
    const el = { id: '', classList: { contains: cls => cls === 'audio-details' } };
    assert.equal(sectionKey(el), 'audio');
});
