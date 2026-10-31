import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioSettings } from '../audio-settings.js';

const file = () => join(mkdtempSync(join(tmpdir(), 'audio-settings-')), 'audio-settings.json');

test('the filter is on (light) by default, or the configured fallback', () => {
    assert.equal(new AudioSettings(file()).filter, 'light');
    assert.equal(new AudioSettings(file(), 'strong').filter, 'strong');
    assert.equal(new AudioSettings(file(), 'off').filter, 'off');
    assert.equal(new AudioSettings(file(), 'nonsense').filter, 'light');
});

test('a chosen level is saved and wins over the fallback after a restart', () => {
    const path = file();
    const settings = new AudioSettings(path, 'light');
    assert.equal(settings.setFilter('strong'), 'strong');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { filter: 'strong', quality: 'opus-96' });
    assert.equal(new AudioSettings(path, 'off').filter, 'strong');
});

test('unknown levels are refused and change nothing', () => {
    const path = file();
    const settings = new AudioSettings(path);
    assert.equal(settings.setFilter('extreme'), null);
    assert.equal(settings.setFilter(undefined), null);
    assert.equal(settings.filter, 'light');
    assert.equal(new AudioSettings(path).filter, 'light');
});

test('a damaged or foreign settings file is ignored', () => {
    const path = file();
    writeFileSync(path, '{not json');
    assert.equal(new AudioSettings(path, 'strong').filter, 'strong');
    writeFileSync(path, JSON.stringify({ filter: 'loud' }));
    assert.equal(new AudioSettings(path, 'off').filter, 'off');
});

test('the stream quality defaults to Opus 96, is saved, and unknown values are refused', () => {
    const path = file();
    const settings = new AudioSettings(path);
    assert.equal(settings.quality, 'opus-96');
    assert.equal(settings.setQuality('opus-32'), 'opus-32');
    assert.equal(settings.setQuality('mp3'), null);
    assert.equal(settings.quality, 'opus-32');
    assert.equal(new AudioSettings(path).quality, 'opus-32');
    assert.equal(new AudioSettings(path).filter, 'light', 'the filter is kept next to it');
});
