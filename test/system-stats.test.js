import test from 'node:test';
import assert from 'node:assert/strict';
import { SystemStats } from '../system-stats.js';

test('CPU usage comes from the change in busy time since the last sample', () => {
    const readings = [{ idle: 100, total: 200 }, { idle: 150, total: 300 }, { idle: 150, total: 300 }];
    const stats = new SystemStats({ readCpu: () => readings.shift(), readTemp: () => 52.3, readDisk: () => ({ usedPercent: 40, freeGb: 9 }), readMem: () => ({ usedPercent: 30 }) });
    assert.deepEqual(stats.sample(), { cpu: 50, tempC: 52.3, disk: { usedPercent: 40, freeGb: 9 }, mem: { usedPercent: 30 } });
    assert.equal(stats.sample().cpu, null, 'no elapsed time gives no reading');
});

test('real readers return numbers or null without throwing', () => {
    const sample = new SystemStats().sample();
    assert.ok(sample.tempC === null || typeof sample.tempC === 'number');
    assert.ok(sample.disk === null || sample.disk.usedPercent >= 0);
});
