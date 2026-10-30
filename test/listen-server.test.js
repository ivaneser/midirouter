import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { createListenServer, listenOnFirstFree } from '../listen-server.js';

function fakeCapture(state = 'live') {
    const capture = new EventEmitter();
    capture.maxBytes = 88200 * 2;
    capture.sampleRate = 44100;
    capture.channels = 2;
    capture.frameBytes = 4;
    capture.listeners_ = 0;
    capture.snapshot = () => Buffer.alloc(0);
    capture.filterLevel = 'light';
    // The cleaned stream: here simply the chunks themselves.
    capture.subscribeClean = handler => { capture.on('chunk', handler); return () => capture.off('chunk', handler); };
    capture.status = () => ({ state, device: 'plughw:CARD=H2n,DEV=0', sampleRate: 44100, channels: 1, error: null, listeners: capture.listeners_ });
    return capture;
}

async function withServer(capture, run) {
    const server = createListenServer({ capture });
    const port = await listenOnFirstFree(server, [0]);
    try { await run(`http://127.0.0.1:${port}`, capture); }
    finally { server.closeAllConnections(); server.close(); }
}

test('the listen server serves the page and its two scripts, and nothing else', async () => {
    await withServer(fakeCapture(), async base => {
        const page = await fetch(`${base}/`);
        assert.equal(page.status, 200);
        assert.match(page.headers.get('content-type'), /text\/html/);
        assert.match(await page.text(), /id="play"/);
        for (const path of ['/visual.js', '/audio-listener.js']) {
            const response = await fetch(base + path);
            assert.equal(response.status, 200, path);
            assert.match(response.headers.get('content-type'), /javascript/);
        }
        for (const path of ['/mcp', '/index.html', '/js/app.js', '/device_maps/waldorf_blofeld.json', '/../server.js', '/sessions/test1.json', '/settings.json']) {
            assert.equal((await fetch(base + path)).status, 404, `${path} is not served`);
        }
        assert.equal((await fetch(`${base}/`, { method: 'POST', body: 'x' })).status, 405);
    });
});

test('the audio status and the live stream come from the same capture', async () => {
    await withServer(fakeCapture(), async base => {
        assert.equal((await (await fetch(`${base}/audio/status`)).json()).state, 'live');
        const controller = new AbortController();
        const response = await fetch(`${base}/audio/live`, { signal: controller.signal });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('x-sample-rate'), '44100');
        assert.equal(response.headers.get('x-channels'), '2');
        controller.abort();
    });
});

test('without audio the live stream is a 503', async () => {
    await withServer(fakeCapture('no-device'), async base => {
        assert.equal((await fetch(`${base}/audio/live`)).status, 503);
    });
});

test('listenOnFirstFree moves on to the next port when one cannot be opened', async () => {
    const blocker = createServer();
    const taken = await listenOnFirstFree(blocker, [0]);
    const server = createListenServer({ capture: fakeCapture() });
    try {
        const port = await listenOnFirstFree(server, [taken, 0]);
        assert.ok(port && port !== taken, 'fell back to a free port');
        const none = createListenServer({ capture: fakeCapture() });
        assert.equal(await listenOnFirstFree(none, [taken]), null, 'nothing free: null');
    } finally {
        server.close();
        blocker.close();
    }
});
