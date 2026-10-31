import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PresetStore } from '../preset-store.js';

test('a learned name is saved, replaces the old one, and the sound is kept beside it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'presets-'));
    const store = new PresetStore(dir);
    assert.equal(store.learn({ file: 'modal_craft_synth_v2', program: 4, name: 'Old' }), true);
    assert.equal(store.learn({ file: 'modal_craft_synth_v2', program: 4, name: 'Old' }), false);
    assert.equal(store.learn({ file: 'modal_craft_synth_v2', program: 4, name: 'Falspread Chord', dump: [240, 1, 247] }), true);
    store.flush();
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'modal_craft_synth_v2.json'), 'utf8')), { presets: { 5: { name: 'Falspread Chord' } } });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'modal_craft_synth_v2.dumps.json'), 'utf8')), { 5: 'f001f7' });
    // A new run starts from what was saved.
    const again = new PresetStore(dir);
    assert.equal(again.learn({ file: 'modal_craft_synth_v2', program: 4, name: 'Falspread Chord' }), false);
    assert.equal(again.learn({ file: '../evil', program: 1, name: 'x' }), false);
});
