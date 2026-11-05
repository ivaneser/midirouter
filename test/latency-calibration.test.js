import test from 'node:test';
import assert from 'node:assert/strict';
import { measureLag } from '../latency-calibration.js';

// A recording with a click (1 kHz, 50 ms decaying burst; 2 kHz on the first beat of four) and a 220 Hz note on
// every beat that starts `lagMs` after the click.
function recording({ lagMs, bpm = 120, seconds = 8, sampleRate = 48000, noise = 0.01, jitterMs = 0, noteGain = 0.4 }) {
    const beat = 60 / bpm, frames = Math.round(seconds * sampleRate);
    const data = new Float32Array(frames);
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
    for (let b = 0; b * beat < seconds - 0.3; b++) {
        const click = 0.37 + b * beat, hz = b % 4 === 0 ? 2000 : 1000;
        const note = click + (lagMs + (b % 2 ? jitterMs : -jitterMs)) / 1000;
        for (let i = 0; i < 0.05 * sampleRate; i++) {
            const t = i / sampleRate, at = Math.round(click * sampleRate) + i;
            if (at < frames) data[at] += 0.5 * Math.exp(-t / 0.015) * Math.sin(2 * Math.PI * hz * t);
        }
        for (let i = 0; i < 0.2 * sampleRate; i++) {
            const t = i / sampleRate, at = Math.round(note * sampleRate) + i;
            if (at < frames) data[at] += noteGain * Math.exp(-t / 0.15) * Math.sin(2 * Math.PI * 220 * t);
        }
    }
    const pcm = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++) {
        const v = Math.max(-1, Math.min(1, data[i] + noise * rnd())) * 32767;
        pcm.writeInt16LE(v, i * 4); pcm.writeInt16LE(v, i * 4 + 2);
    }
    return { pcm, sampleRate, beat };
}

for (const lagMs of [-40, 0, 25, 90]) {
    test(`measureLag finds a note ${lagMs} ms from the click`, () => {
        const { pcm, sampleRate, beat } = recording({ lagMs });
        const result = measureLag(pcm, { sampleRate, channels: 2, noteHz: 220, beatSec: beat });
        assert.ok(result.pairs >= 10, `pairs ${result.pairs}`);
        assert.ok(Math.abs(result.lagMs - lagMs) < 2, `measured ${result.lagMs}`);
    });
}

test('measureLag reports the spread and survives timing jitter', () => {
    const { pcm, sampleRate, beat } = recording({ lagMs: 30, jitterMs: 4 });
    const result = measureLag(pcm, { sampleRate, noteHz: 220, beatSec: beat });
    assert.ok(Math.abs(result.lagMs - 30) < 5);
    assert.ok(result.jitterMs > 2 && result.jitterMs < 6);
});

test('measureLag finds nothing in silence', () => {
    const result = measureLag(Buffer.alloc(48000 * 4 * 2), { sampleRate: 48000, noteHz: 220, beatSec: 0.5 });
    assert.equal(result.lagMs, null);
    assert.equal(result.pairs, 0);
});

for (const lagMs of [0, 8, -15, 60]) {
    test(`measureLag is not fooled by a loud click over a quiet note (lag ${lagMs} ms)`, () => {
        const { pcm, sampleRate, beat } = recording({ lagMs, noteGain: 0.04 });
        const result = measureLag(pcm, { sampleRate, noteHz: 220, beatSec: beat });
        assert.ok(result.pairs >= 10, `pairs ${result.pairs}`);
        assert.ok(Math.abs(result.lagMs - lagMs) < 3, `measured ${result.lagMs}`);
    });
}
