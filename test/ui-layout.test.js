import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UiLayoutSettings } from '../ui-layout.js';
import { applyOrder } from '../frontend/js/section-order.js';

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
