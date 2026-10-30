import test from 'node:test';
import assert from 'node:assert/strict';
import { NoiseFilter, FILTER_LEVELS } from '../audio-clean.js';

const RATE = 44100;

// Deterministic white noise.
function noise(seed) {
    let state = seed;
    return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2147483648 - 1; };
}

// Stereo frames from per-channel functions of time, in dBFS rms for noise and amplitude for tones.
function stereo(seconds, left, right) {
    const frames = Math.round(seconds * RATE), out = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++) {
        out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left(i / RATE))) * 32767), i * 4);
        out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right(i / RATE))) * 32767), i * 4 + 2);
    }
    return out;
}
const rmsDb = (buffer, channel, from = 0, to = Infinity) => {
    let sum = 0, count = 0;
    const end = Math.min(to, buffer.length / 4);
    for (let i = from; i < end; i++) { const v = buffer.readInt16LE(i * 4 + channel * 2) / 32768; sum += v * v; count++; }
    return 10 * Math.log10(sum / count + 1e-12);
};
// Level of one frequency (Goertzel), in dBFS of a sine of that amplitude.
function toneDb(buffer, channel, hz, from, to) {
    const n = to - from; let re = 0, im = 0;
    for (let i = from; i < to; i++) {
        const v = buffer.readInt16LE(i * 4 + channel * 2) / 32768, angle = 2 * Math.PI * hz * i / RATE;
        re += v * Math.cos(angle); im -= v * Math.sin(angle);
    }
    return 20 * Math.log10(2 * Math.hypot(re, im) / n + 1e-12);
}
const run = (filter, input, chunk = 4096 * 4) => {
    const parts = [];
    for (let at = 0; at < input.length; at += chunk) parts.push(filter.process(input.subarray(at, Math.min(input.length, at + chunk))));
    return Buffer.concat(parts);
};
const db = x => 10 ** (x / 20);

test('the levels are light and strong; anything else is refused', () => {
    assert.deepEqual(FILTER_LEVELS, ['light', 'strong']);
    assert.throws(() => new NoiseFilter({ level: 'extreme' }), /unknown/);
});

test('the output is always whole stereo frames, and nothing is lost over a long stream', () => {
    for (const level of FILTER_LEVELS) {
        const filter = new NoiseFilter({ level });
        const input = stereo(3, () => 0.01, () => 0.01);
        const out = run(filter, input, 1000 * 4 + 3);   // awkward chunk sizes, even mid-frame
        assert.equal(out.length % 4, 0, level);
        assert.ok(input.length - out.length < 4 * 3000, `${level}: held back ${(input.length - out.length) / 4} frames`);
    }
});

test('light: steady noise between the notes is turned down by about 12 dB', t => {
    const left = noise(1), right = noise(2);
    const input = stereo(14, () => db(-60) * Math.sqrt(3) * left(), () => db(-60) * Math.sqrt(3) * right());   // white noise at -60 dBFS rms
    const out = run(new NoiseFilter({ level: 'light' }), input);
    const before = rmsDb(input, 0, 12 * RATE), after = rmsDb(out, 0, 12 * RATE);
    t.diagnostic(`light: noise ${before.toFixed(1)} -> ${after.toFixed(1)} dBFS (${(before - after).toFixed(1)} dB less)`);
    assert.ok(before - after > 9 && before - after < 14, `noise ${before.toFixed(1)} -> ${after.toFixed(1)} dBFS`);
});

test('light: music well above the noise passes at full level, even right after silence', t => {
    const left = noise(3), right = noise(4);
    const hiss = (g, s) => db(-65) * Math.sqrt(3) * s() * g;
    const tone = t => (t >= 10 ? 0.2 * Math.sin(2 * Math.PI * 440 * t) : 0);
    const input = stereo(12, t => hiss(1, left) + tone(t), t => hiss(1, right) + tone(t));
    const out = run(new NoiseFilter({ level: 'light' }), input);
    const inTone = toneDb(input, 0, 440, Math.round(10.3 * RATE), Math.round(11.9 * RATE)), outTone = toneDb(out, 0, 440, Math.round(10.3 * RATE), Math.round(11.9 * RATE));
    t.diagnostic(`light, note: 440 Hz ${inTone.toFixed(1)} -> ${outTone.toFixed(1)} dBFS`);
    assert.ok(Math.abs(inTone - outTone) < 0.5, `440 Hz ${inTone.toFixed(1)} -> ${outTone.toFixed(1)} dBFS`);
});

test('strong: steady noise is reduced by at least 10 dB', t => {
    const left = noise(5), right = noise(6);
    const input = stereo(16, () => db(-60) * Math.sqrt(3) * left(), () => db(-60) * Math.sqrt(3) * right());
    const out = run(new NoiseFilter({ level: 'strong' }), input);
    const before = rmsDb(input, 0, 13 * RATE), after = rmsDb(out, 0, 13 * RATE);
    t.diagnostic(`strong: noise ${before.toFixed(1)} -> ${after.toFixed(1)} dBFS (${(before - after).toFixed(1)} dB less)`);
    assert.ok(before - after > 10, `noise ${before.toFixed(1)} -> ${after.toFixed(1)} dBFS`);
});

test('strong: a note keeps its level while the noise around it drops', t => {
    const left = noise(7), right = noise(8);
    const hiss = s => db(-50) * Math.sqrt(3) * s();
    const tone = t => (t >= 8 ? 0.1 * Math.sin(2 * Math.PI * 1000 * t) : 0);   // -23 dBFS rms, 27 dB over the noise
    const input = stereo(12, t => hiss(left) + tone(t), t => hiss(right) + tone(t));
    const out = run(new NoiseFilter({ level: 'strong' }), input);
    const from = Math.round(9.5 * RATE), to = Math.round(11.5 * RATE);
    const inTone = toneDb(input, 0, 1000, from, to), outTone = toneDb(out, 0, 1000, from, to);
    t.diagnostic(`strong, note: 1 kHz ${inTone.toFixed(1)} -> ${outTone.toFixed(1)} dBFS`);
    assert.ok(Math.abs(inTone - outTone) < 1.5, `1 kHz ${inTone.toFixed(1)} -> ${outTone.toFixed(1)} dBFS`);
    // The noise away from the note (3.1-3.3 kHz) while the note plays.
    const inNoise = toneDb(input, 0, 3150, from, to), outNoise = toneDb(out, 0, 3150, from, to);
    t.diagnostic(`strong, noise beside the note: ${inNoise.toFixed(1)} -> ${outNoise.toFixed(1)} dBFS`);
    assert.ok(inNoise - outNoise > 5, `3.15 kHz noise ${inNoise.toFixed(1)} -> ${outNoise.toFixed(1)} dBFS`);
});

test('a sudden loud hit is not swallowed (attacks open at once)', () => {
    const left = noise(9), right = noise(10);
    const hit = t => (t >= 9 && t < 9.05 ? 0.5 * Math.sin(2 * Math.PI * 200 * t) : 0);
    const input = stereo(10, t => db(-60) * Math.sqrt(3) * left() + hit(t), t => db(-60) * Math.sqrt(3) * right() + hit(t));
    for (const level of FILTER_LEVELS) {
        const out = run(new NoiseFilter({ level }), input);
        const frames = out.length / 4;
        let peak = 0;
        for (let i = Math.floor(9.02 * RATE); i < Math.min(frames, Math.floor(9.12 * RATE)); i++) peak = Math.max(peak, Math.abs(out.readInt16LE(i * 4)) / 32768);
        assert.ok(peak > 0.35, `${level}: hit peak ${peak.toFixed(2)}`);
    }
});

test('mono and stereo both work, and the sides stay independent', () => {
    const quiet = Buffer.alloc(4 * 2000);
    for (const channels of [1, 2]) {
        const filter = new NoiseFilter({ level: 'light', channels });
        assert.equal(filter.process(Buffer.alloc(2000 * 2 * channels)).length % (2 * channels), 0);
    }
    const left = noise(11);
    const input = stereo(12, t => (t > 8 ? 0.3 * Math.sin(2 * Math.PI * 300 * t) : db(-62) * Math.sqrt(3) * left()), () => 0);
    const out = run(new NoiseFilter({ level: 'strong' }), input);
    assert.ok(rmsDb(out, 1, 0, out.length / 4) < -80, 'a silent right channel stays silent');
    assert.ok(quiet.length > 0);
});
