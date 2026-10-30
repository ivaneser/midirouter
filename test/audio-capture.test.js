import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { AudioCapture, pickCaptureDevice, serveLiveAudio } from '../audio-capture.js';

const CARDS = ` 0 [Headphones     ]: bcm2835_headphonls - bcm2835 Headphones
                      bcm2835 Headphones
 1 [H2n            ]: USB-Audio - H2n
                      ZOOM Corporation H2n at usb-0000:01:00.0-1.2, full speed
 2 [MicroFreak     ]: USB-Audio - MicroFreak
                      Arturia MicroFreak at usb-0000:01:00.0-1.3, full speed
`;

function fakeProcess() {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = [];
    proc.kill = signal => { proc.killed.push(signal); setImmediate(() => proc.emit('close', null)); };
    return proc;
}

function capture(options = {}) {
    const processes = [];
    const calls = [];
    const audio = new AudioCapture({
        device: null,
        readCards: () => CARDS,
        retryMs: 10,
        sampleRate: 1000,
        ringSeconds: 1,
        spawnProcess: (command, args) => { calls.push([command, args]); const p = fakeProcess(); processes.push(p); return p; },
        ...options,
    });
    return { audio, processes, calls };
}

const samples = n => Buffer.alloc(n * 2, 1);

test('the capture device is the attached USB interface, never a synth card', () => {
    assert.equal(pickCaptureDevice(CARDS), 'plughw:CARD=H2n,DEV=0');
    assert.equal(pickCaptureDevice(' 2 [MicroFreak     ]: USB-Audio - MicroFreak\n'), null);
    assert.equal(pickCaptureDevice(''), null);
    assert.equal(pickCaptureDevice(' 3 [CODEC          ]: USB-Audio - USB Audio CODEC\n 1 [H2n            ]: USB-Audio - H2n\n'), 'plughw:CARD=CODEC,DEV=0');
});

test('arecord is started with small periods for a low delay', t => {
    const { audio, calls } = capture();
    t.after(() => audio.stop());
    audio.start();
    const [command, args] = calls[0];
    assert.equal(command, 'arecord');
    assert.deepEqual(args.slice(0, 8), ['-t', 'raw', '-f', 'S16_LE', '-r', '1000', '-c', '1']);
    assert.ok(args.includes('plughw:CARD=H2n,DEV=0'));
    assert.ok(args.some(a => /^--period-size=\d+$/.test(a)));
});

test('the ring keeps only the last seconds, as whole samples, and snapshot returns the newest', t => {
    const { audio, processes } = capture();
    t.after(() => audio.stop());
    audio.start();
    const out = processes[0].stdout;
    out.emit('data', samples(600));
    out.emit('data', Buffer.concat([samples(600), Buffer.from([7])]));   // an odd byte is held back
    assert.equal(audio.status().state, 'live');
    assert.ok(audio.ringBytes <= 1000 * 2 + 600 * 2, 'older chunks are dropped');
    assert.equal(audio.snapshot(0.5).length, 500 * 2);
    out.emit('data', Buffer.from([7]));
    assert.equal(audio.snapshot(10).length % 2, 0);
    assert.equal(audio.snapshot(0).length, 0);
});

test('without a device it waits and retries until one appears', async t => {
    let cards = '';
    const { audio, calls } = capture({ readCards: () => cards });
    t.after(() => audio.stop());
    audio.start();
    assert.equal(audio.status().state, 'no-device');
    assert.equal(calls.length, 0);
    cards = CARDS;
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(calls.length, 1, 'plugging the interface in starts the capture');
});

test('an exited arecord is restarted, and a stalled one is killed', async t => {
    const { audio, processes } = capture({ stallMs: 20 });
    t.after(() => audio.stop());
    audio.start();
    processes[0].emit('close', 1);
    assert.equal(audio.status().state, 'waiting');
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(processes.length, 2);
    audio.lastDataAt = Date.now() - 100;
    audio._checkStall();
    assert.deepEqual(processes[1].killed, ['SIGKILL']);
});

test('a missing arecord binary is reported, not thrown', t => {
    const { audio, processes } = capture();
    t.after(() => audio.stop());
    audio.start();
    processes[0].emit('error', new Error('spawn arecord ENOENT'));
    assert.equal(audio.status().state, 'no-device');
    assert.match(audio.status().error, /arecord/);
});

async function get(audio, path, abortAfterBytes) {
    const server = createServer((req, res) => serveLiveAudio(audio, req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const controller = new AbortController();
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { signal: controller.signal });
        if (response.status !== 200) return { response, body: await response.json() };
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
            chunks.push(chunk);
            size += chunk.length;
            if (size >= abortAfterBytes) break;
        }
        controller.abort();
        return { response, body: Buffer.concat(chunks) };
    } finally {
        server.closeAllConnections();
        server.close();
    }
}

test('GET /audio/live is 503 until the capture is live', async t => {
    const { audio } = capture();
    t.after(() => audio.stop());
    const { response, body } = await get(audio, '/audio/live', 0);
    assert.equal(response.status, 503);
    assert.match(body.state, /stopped/);
});

test('GET /audio/live sends the backfill, then the live audio, and releases the listener', async t => {
    const { audio, processes } = capture();
    t.after(() => audio.stop());
    audio.start();
    processes[0].stdout.emit('data', Buffer.from(Array.from({ length: 200 }, (_, i) => i % 250)));   // 100 samples captured earlier
    setTimeout(() => processes[0].stdout.emit('data', samples(50)), 30);
    const { response, body } = await get(audio, '/audio/live?backfill=0.05', 200);
    assert.equal(response.headers.get('content-type'), 'audio/L16');
    assert.equal(response.headers.get('x-sample-rate'), '1000');
    assert.equal(body.length, 200, '50 backfilled samples, then 50 live ones');
    assert.deepEqual([...body.subarray(0, 4)], [100, 101, 102, 103], 'the backfill is the newest captured audio');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(audio.status().listeners, 0);
});
