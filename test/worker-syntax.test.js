import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const workerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../worker-midi.js');

test('MIDI worker module parses successfully', () => {
    const result = spawnSync(process.execPath, ['--check', workerPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
});
