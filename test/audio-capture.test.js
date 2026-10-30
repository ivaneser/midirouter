import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { AudioCapture, pickCaptureDevice, serveLiveAudio } from '../audio-capture.js';

// `arecord -l` lists only the cards that can record.
const CARDS = `**** List of CAPTURE Hardware Devices ****
card 1: Blofeld [Blofeld], device 0: USB Audio [USB Audio]
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 2: H2n [H2n], device 0: USB Audio [USB Audio]
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 3: mk2 [LPK25 mk2], device 0: USB Audio [USB Audio]
  Subdevices: 1/1
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
        channels: 1,   // most tests count mono samples; stereo has its own tests
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

test('the capture device is the recording interface, never an instrument', () => {
    assert.equal(pickCaptureDevice(CARDS), 'plughw:CARD=H2n,DEV=0');
    assert.equal(pickCaptureDevice('card 1: Blofeld [Blofeld], device 0: USB Audio [USB Audio]\n'), null);
    assert.equal(pickCaptureDevice('card 0: Headphones [bcm2835 Headphones], device 0: x\n'), null);
    assert.equal(pickCaptureDevice(''), null);
    assert.equal(pickCaptureDevice('card 3: CODEC [USB Audio CODEC], device 0: USB Audio\ncard 2: H2n [H2n], device 0: USB Audio\n'), 'plughw:CARD=CODEC,DEV=0');
    assert.equal(pickCaptureDevice('card 4: H2n [H2n], device 1: USB Audio\n'), 'plughw:CARD=H2n,DEV=1', 'the device number is kept');
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
    const { response, body } = await get(audio, '/audio/live?raw=1&backfill=0.05', 200);
    assert.equal(response.headers.get('content-type'), 'audio/L16');
    assert.equal(response.headers.get('x-sample-rate'), '1000');
    assert.equal(response.headers.get('x-channels'), '1');
    assert.equal(body.length, 200, '50 backfilled samples, then 50 live ones');
    assert.deepEqual([...body.subarray(0, 4)], [100, 101, 102, 103], 'the backfill is the newest captured audio');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(audio.status().listeners, 0);
});

test('the capture is stereo by default, as the interface delivers it', t => {
    const calls = [];
    const audio = new AudioCapture({ device: null, readCards: () => CARDS, spawnProcess: (command, args) => { calls.push(args); return fakeProcess(); } });
    t.after(() => audio.stop());
    assert.equal(audio.channels, 2);
    assert.equal(audio.status().channels, 2);
    audio.start();
    assert.deepEqual(calls[0].slice(6, 8), ['-c', '2']);
});

test('stereo audio is kept in whole frames, and a snapshot counts frames, not samples', t => {
    const { audio, processes } = capture({ channels: 2, sampleRate: 1000, ringSeconds: 1 });
    t.after(() => audio.stop());
    audio.start();
    const out = processes[0].stdout;
    out.emit('data', Buffer.alloc(100 * 4, 1));                 // 100 frames
    out.emit('data', Buffer.alloc(50 * 4 + 3, 2));              // 50 frames and three bytes of the next one
    assert.equal(audio.ringBytes, 150 * 4, 'only whole frames are kept');
    out.emit('data', Buffer.alloc(1, 2));                       // the missing byte completes the frame
    assert.equal(audio.ringBytes, 151 * 4);
    assert.equal(audio.snapshot(0.05).length, 50 * 4, '50 ms of 1 kHz stereo is 50 frames');
    assert.equal(audio.snapshot(0.05).length % 4, 0);
});

test('the ring still holds only the last second in stereo', t => {
    const { audio, processes } = capture({ channels: 2, sampleRate: 1000, ringSeconds: 1 });
    t.after(() => audio.stop());
    audio.start();
    for (let i = 0; i < 5; i++) processes[0].stdout.emit('data', Buffer.alloc(600 * 4, i));
    assert.ok(audio.ringBytes <= 1000 * 4 + 600 * 4, `ring ${audio.ringBytes}`);
    assert.equal(audio.snapshot(10).length % 4, 0);
});

// Steady white noise at about -60 dBFS rms, in chunks like arecord's.
function feedNoise(processes, seconds, channels = 1) {
    let seed = 7;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };
    const chunk = 4096, chunks = Math.ceil(seconds * 44100 / chunk);
    for (let c = 0; c < chunks; c++) {
        const buf = Buffer.alloc(chunk * 2 * channels);
        for (let i = 0; i < chunk * channels; i++) buf.writeInt16LE(Math.round(0.001 * Math.sqrt(3) * rnd() * 32767), i * 2);
        processes[0].stdout.emit('data', buf);
    }
}
const rmsDbOf = buffers => {
    const all = Buffer.concat(buffers); let sum = 0;
    for (let i = 0; i < all.length / 2; i++) { const v = all.readInt16LE(i * 2) / 32768; sum += v * v; }
    return 10 * Math.log10(sum / (all.length / 2) + 1e-12);
};

test('the listened stream is noise-filtered by default; the raw capture stays untouched', t => {
    const { audio, processes } = capture({ sampleRate: 44100 });
    t.after(() => audio.stop());
    audio.start();
    assert.equal(audio.filterLevel, 'light', 'on by default');
    const raw = [], cleaned = [];
    audio.on('chunk', c => raw.push(c));
    audio.subscribeClean(c => cleaned.push(c));
    feedNoise(processes, 14);
    const lateRaw = raw.slice(-40), lateClean = cleaned.slice(-40);
    t.diagnostic(`raw ${rmsDbOf(lateRaw).toFixed(1)} dBFS, cleaned ${rmsDbOf(lateClean).toFixed(1)} dBFS`);
    assert.ok(rmsDbOf(lateRaw) - rmsDbOf(lateClean) > 9, 'steady noise is turned down in the cleaned stream');
    assert.ok(Math.abs(rmsDbOf(lateRaw) + 60) < 2, 'the raw capture is not changed');
});

test('one filter serves every listener: its cost does not grow with their number', t => {
    const { audio, processes } = capture({ sampleRate: 44100 });
    t.after(() => audio.stop());
    audio.start();
    const heard = [[], [], []];
    heard.forEach(list => audio.subscribeClean(c => list.push(c)));
    let calls = 0;
    const original = audio.cleanFilter.process.bind(audio.cleanFilter);
    audio.cleanFilter.process = chunk => { calls++; return original(chunk); };
    feedNoise(processes, 1);
    const chunks = Math.ceil(44100 / 4096);
    assert.equal(calls, chunks, 'each chunk is filtered once, however many listen');
    assert.deepEqual(heard.map(list => Buffer.concat(list).length), [heard[0], heard[1], heard[2]].map(list => Buffer.concat(list).length));
    assert.ok(Buffer.concat(heard[0]).equals(Buffer.concat(heard[1])) && Buffer.concat(heard[1]).equals(Buffer.concat(heard[2])), 'all hear the same');
});

test('the filter exists only while someone listens, and forgets what it learnt afterwards', t => {
    const { audio, processes } = capture({ sampleRate: 44100 });
    t.after(() => audio.stop());
    audio.start();
    assert.equal(audio.cleanFilter, null, 'no listener: nothing is filtered');
    feedNoise(processes, 0.2);
    const stop1 = audio.subscribeClean(() => {});
    const stop2 = audio.subscribeClean(() => {});
    const first = audio.cleanFilter;
    assert.ok(first);
    stop1();
    assert.equal(audio.cleanFilter, first, 'still in use by the other listener');
    stop2();
    assert.equal(audio.cleanFilter, null, 'the last listener left');
    audio.subscribeClean(() => {});
    assert.notEqual(audio.cleanFilter, first, 'a new listener starts a fresh filter');
});

test('the filter level can be switched while listeners stay connected', t => {
    const { audio, processes } = capture({ sampleRate: 44100 });
    t.after(() => audio.stop());
    audio.start();
    const heard = [];
    audio.subscribeClean(c => heard.push(c));
    const statuses = [];
    audio.on('status', s => statuses.push(s.filter));
    audio.setFilterLevel('extreme');
    assert.equal(audio.filterLevel, 'light', 'an unknown level is ignored');
    audio.setFilterLevel('off');
    assert.equal(audio.status().filter, 'off');
    assert.equal(audio.cleanFilter, null);
    const rawChunk = Buffer.alloc(2048, 5);
    heard.length = 0;
    processes[0].stdout.emit('data', rawChunk);
    assert.ok(heard[0].equals(rawChunk), 'with the filter off the listeners get the audio as it is');
    audio.setFilterLevel('strong');
    assert.ok(audio.cleanFilter, 'a new filter takes over for the connected listeners');
    assert.deepEqual([...new Set(statuses)], ['off', 'strong'], 'listeners of the status see each new level');
});

test('the filter level starts from the setting; an unknown one means light', () => {
    assert.equal(new AudioCapture({ device: null, filter: 'strong' }).filterLevel, 'strong');
    assert.equal(new AudioCapture({ device: null, filter: 'off' }).filterLevel, 'off');
    assert.equal(new AudioCapture({ device: null, filter: 'extreme' }).filterLevel, 'light');
    assert.equal(new AudioCapture({ device: null }).filterLevel, 'light');
});

test('GET /audio/live is the filtered stream; ?raw=1 is the untouched capture and the only one with a backfill', async t => {
    const { audio, processes } = capture({ channels: 2, sampleRate: 44100 });
    t.after(() => audio.stop());
    audio.start();
    processes[0].stdout.emit('data', Buffer.alloc(4096 * 4, 0x20));   // the capture is live once it has data
    const server = createServer((req, res) => serveLiveAudio(audio, req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
        for (const [query, filterHeader] of [['', 'light'], ['?raw=1', 'off'], ['?raw=1&backfill=0.05', 'off']]) {
            const controller = new AbortController();
            const response = await fetch(`http://127.0.0.1:${port}/audio/live${query}`, { signal: controller.signal });
            assert.equal(response.status, 200, query);
            assert.equal(response.headers.get('x-filter'), filterHeader, query);
            assert.equal(response.headers.get('x-channels'), '2');
            controller.abort();
        }
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(audio.cleanSubscribers, 0, 'closed connections release the filter');
        assert.equal(audio.status().listeners, 0);
    } finally {
        server.closeAllConnections();
        server.close();
    }
});
