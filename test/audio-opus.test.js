import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { OpusBroadcast, Resampler, qualityBitrate } from '../audio-opus.js';
import { serveLiveAudio } from '../audio-capture.js';

// A capture that only needs to feed the cleaned stream: 48 kHz stereo.
function fakeCapture(sampleRate = 48000) {
    const capture = new EventEmitter();
    Object.assign(capture, { sampleRate, channels: 2, frameBytes: 4, maxBytes: 0, filterLevel: 'off', listeners_: 0, cleanSubscribers: 0 });
    capture.status = () => ({ state: 'live' });
    capture.subscribeClean = onChunk => { capture.cleanSubscribers++; capture.on('clean', onChunk); return () => { capture.cleanSubscribers--; capture.off('clean', onChunk); }; };
    return capture;
}
const tone = frames => {
    const buffer = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++) { const v = Math.round(6000 * Math.sin(i / 8)); buffer.writeInt16LE(v, i * 4); buffer.writeInt16LE(v, i * 4 + 2); }
    return buffer;
};

test('qualityBitrate reads the bitrate out of the quality name', () => {
    assert.equal(qualityBitrate('opus-96'), 96000);
    assert.equal(qualityBitrate('opus-32'), 32000);
    assert.equal(qualityBitrate('pcm'), null);
});

test('Opus packets are cut every 20 ms, framed with their length, and much smaller than the raw audio', t => {
    const capture = fakeCapture();
    const opus = new OpusBroadcast(capture, { quality: 'opus-64' });
    const packets = [];
    const off = opus.subscribe(p => packets.push(p));
    t.after(off);
    capture.emit('clean', tone(960 * 5 + 100));   // five whole frames and a bit
    assert.equal(packets.length, 5);
    for (const packet of packets) {
        assert.equal(packet.readUInt16BE(0), packet.length - 2);
        assert.ok(packet.length < 960 * 4 / 4, 'at least four times smaller than the raw frame');
    }
});

test('one encoder serves every listener and goes away with the last one', () => {
    const capture = fakeCapture();
    const opus = new OpusBroadcast(capture);
    const a = [], b = [];
    const offA = opus.subscribe(p => a.push(p));
    const offB = opus.subscribe(p => b.push(p));
    assert.equal(capture.cleanSubscribers, 1, 'the capture is encoded once');
    capture.emit('clean', tone(960));
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    offA();
    assert.equal(capture.cleanSubscribers, 1);
    offB();
    assert.equal(capture.cleanSubscribers, 0);
    assert.equal(opus.encoder, null);
});

test('a 44.1 kHz capture is resampled to 48 kHz for Opus', () => {
    const capture = fakeCapture(44100);
    const opus = new OpusBroadcast(capture);
    const packets = [];
    const off = opus.subscribe(p => packets.push(p));
    capture.emit('clean', tone(44100));   // one second
    off();
    assert.ok(Math.abs(packets.length - 50) <= 1, `about 50 packets of 20 ms, got ${packets.length}`);
});

test('the resampler keeps the pitch and is continuous across chunks', () => {
    const resampler = new Resampler(44100, 48000, 1);
    const sine = n => { const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * 441 * i / 44100)), i * 2); return b; };
    const whole = sine(4410);
    const out = Buffer.concat([resampler.process(whole.subarray(0, 3000)), resampler.process(whole.subarray(3000))]);
    const samples = new Int16Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.length));
    assert.ok(Math.abs(samples.length - 4800) <= 2, `4410 frames at 44.1k become about 4800 at 48k, got ${samples.length}`);
    let crossings = 0;
    for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
    assert.ok(Math.abs(crossings - 44) <= 1, `44 cycles of 441 Hz in 0.1 s, got ${crossings}`);
    let jump = 0;
    for (let i = 1; i < samples.length; i++) jump = Math.max(jump, Math.abs(samples[i] - samples[i - 1]));
    assert.ok(jump < 1200, `no click at the chunk edge (largest step ${jump})`);
});

test('Opus is only offered at 44.1 or 48 kHz and with an Opus quality', () => {
    assert.equal(new OpusBroadcast(fakeCapture(22050)).available, false);
    assert.equal(new OpusBroadcast(fakeCapture(), { quality: 'pcm' }).available, false);
    assert.equal(new OpusBroadcast(fakeCapture(), { quality: 'opus-128' }).available, true);
});

async function head(capture, opus, path) {
    const server = createServer((req, res) => serveLiveAudio(capture, req, res, opus));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const controller = new AbortController();
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { signal: controller.signal });
        const info = { codec: response.headers.get('x-codec'), bitrate: response.headers.get('x-bitrate'), rate: response.headers.get('x-sample-rate'), type: response.headers.get('content-type') };
        controller.abort();
        return info;
    } finally {
        server.closeAllConnections();
        server.close();
    }
}

test('/audio/live?codec=opus is Opus when available, otherwise the raw stream', async () => {
    const capture = fakeCapture();
    const opus = new OpusBroadcast(capture, { quality: 'opus-96' });
    assert.deepEqual(await head(capture, opus, '/audio/live?codec=opus'), { codec: 'opus', bitrate: '96000', rate: '48000', type: 'application/octet-stream' });
    assert.equal((await head(capture, opus, '/audio/live')).codec, 'pcm', 'a client that did not ask gets PCM');
    assert.equal((await head(capture, opus, '/audio/live?codec=opus&raw=1')).codec, 'pcm', 'raw capture for analysis is never compressed');
    opus.setQuality('pcm');
    assert.equal((await head(capture, opus, '/audio/live?codec=opus')).codec, 'pcm');
});
