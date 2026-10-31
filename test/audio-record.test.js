import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { recordUntilQuiet, silenceThreshold, wavOf } from '../audio-record.js';

const RATE = 8000, CHANNELS = 2;
const pcm = (seconds, amplitude) => {
    const frames = Math.round(seconds * RATE), buffer = Buffer.alloc(frames * CHANNELS * 2);
    for (let i = 0; i < frames; i++) {
        const v = Math.round(amplitude * 32767 * Math.sin(i * 0.3));
        for (let c = 0; c < CHANNELS; c++) buffer.writeInt16LE(v, (i * CHANNELS + c) * 2);
    }
    return buffer;
};
const fakeCapture = () => Object.assign(new EventEmitter(), { sampleRate: RATE, channels: CHANNELS, frameBytes: 4, snapshot: () => pcm(0.3, 0.00003) });
const feed = (capture, parts) => setImmediate(() => { for (const part of parts) capture.emit('chunk', part); });

test('the silence before the first note and after the last is cut off', async () => {
    const capture = fakeCapture();
    const pending = recordUntilQuiet(capture, { maxSeconds: 5, quietFor: 0.3 });
    feed(capture, [pcm(0.5, 0), pcm(0.4, 0.3), pcm(0.2, 0.01), pcm(1, 0)]);
    const r = await pending;
    assert.equal(r.heardSound, true);
    assert.equal(r.stoppedQuiet, true);
    assert.ok(r.seconds > 0.6 && r.seconds < 0.75, `kept ${r.seconds}s of 0.6s of sound`);
    const first = Math.abs(r.pcm.readInt16LE(Math.round(0.02 * RATE) * 4));
    assert.ok(first > 0, 'starts with sound, not silence');
    assert.ok(Math.abs(r.pcm.readInt16LE(r.pcm.length - 4)) < 400, 'ends in the quiet tail');
});

test('nothing played: no sound is reported and nothing is kept', async () => {
    const capture = fakeCapture();
    const pending = recordUntilQuiet(capture, { maxSeconds: 0.5, quietFor: 0.2 });
    feed(capture, [pcm(0.2, 0)]);
    const r = await pending;
    assert.equal(r.heardSound, false);
    assert.equal(r.pcm.length, 0);
});

test('the silence threshold follows the noise floor within limits; wavOf frames the samples', () => {
    assert.equal(silenceThreshold(-89), -75);
    assert.equal(silenceThreshold(-60), -50);
    assert.equal(silenceThreshold(-20), -40);
    const wav = wavOf(Buffer.alloc(8), 44100, 2);
    assert.equal(wav.length, 52);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
});
