import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserPresetStore } from '../user-presets.js';

const controls = [{ cc: 16, value: 80 }, { cc: 43, value: 12 }];

test('saves a named preset with its group and persists it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'user-presets-'));
    const store = new UserPresetStore(dir);
    const id = store.save('korg_nts1', { name: ' Warm Pad ', group: 'Pad', controls });
    assert.deepEqual(store.get('korg_nts1', id), { name: 'Warm Pad', group: 'Pad', controls });
    assert.deepEqual(new UserPresetStore(dir).list('korg_nts1')[id].controls, controls, 'read back by a new store');
    assert.equal(JSON.parse(readFileSync(join(dir, 'korg_nts1.json'), 'utf8')).presets[id].name, 'Warm Pad');
});

test('a preset of the same name is overwritten, a new name gets a new id, group defaults to Misc', () => {
    const store = new UserPresetStore(mkdtempSync(join(tmpdir(), 'user-presets-')));
    const first = store.save('korg_nts1', { name: 'Lead', controls });
    assert.equal(store.save('korg_nts1', { name: 'LEAD', group: 'Lead', controls: [{ cc: 16, value: 1 }] }), first);
    assert.deepEqual(store.get('korg_nts1', first), { name: 'LEAD', group: 'Lead', controls: [{ cc: 16, value: 1 }] });
    const second = store.save('korg_nts1', { name: 'Bass', controls });
    assert.notEqual(second, first);
    assert.equal(store.get('korg_nts1', second).group, 'Misc');
});

test('rejects what cannot be a preset: no name, no controls, bad values, bad file', () => {
    const store = new UserPresetStore(mkdtempSync(join(tmpdir(), 'user-presets-')));
    assert.equal(store.save('korg_nts1', { name: '', controls }), null);
    assert.equal(store.save('korg_nts1', { name: 'X', controls: [] }), null);
    assert.equal(store.save('korg_nts1', { name: 'X', controls: [{ cc: 16, value: 200 }, { cc: 0, value: 5 }] }), null);
    assert.equal(store.save('../evil', { name: 'X', controls }), null);
});

test('removes a preset', () => {
    const store = new UserPresetStore(mkdtempSync(join(tmpdir(), 'user-presets-')));
    const id = store.save('korg_nts1', { name: 'Gone', controls });
    assert.equal(store.remove('korg_nts1', id), true);
    assert.equal(store.get('korg_nts1', id), null);
    assert.equal(store.remove('korg_nts1', id), false);
});
