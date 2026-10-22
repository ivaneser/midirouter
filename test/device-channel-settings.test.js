import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceChannelSettings } from '../device-channel-settings.js';
import { deviceChannelKey } from '../frontend/js/device-channels.js';

test('device channels persist across restarts and ALSA client renumbering', t => {
    const directory = mkdtempSync(join(tmpdir(), 'midi-channels-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'channels.json');
    const first = new DeviceChannelSettings(path);
    assert.equal(first.set('NTS-1:Sound 20:0', 16), true);
    assert.equal(first.set('MicroFreak:Midi 22:0', 3), true);
    const restored = new DeviceChannelSettings(path);
    assert.equal(restored.channels[deviceChannelKey('NTS-1:Sound 35:0')], 16);
    assert.equal(restored.channels[deviceChannelKey('MicroFreak:Midi 39:0')], 3);
    assert.equal(restored.channels[deviceChannelKey('NTS-1:Sound 35:1')], undefined);
    for (const invalid of [0, 17, 1.5, '2', null]) assert.equal(restored.set('NTS-1:Sound 35:0', invalid), false);
    assert.equal(new DeviceChannelSettings(path).channels[deviceChannelKey('NTS-1:Sound 35:0')], 16);
});

test('invalid saved channels are ignored', t => {
    const directory = mkdtempSync(join(tmpdir(), 'midi-channels-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'channels.json');
    writeFileSync(path, JSON.stringify({ good: 4, bad: 999, string: '7' }));
    const settings = new DeviceChannelSettings(path);
    assert.deepEqual({ ...settings.channels }, { good: 4 });
});
