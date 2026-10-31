import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveLiveAudio } from './audio-capture.js';

// The listen-only page for many devices. It serves exactly these files and the live audio, and nothing
// of the DAW, the MIDI controls or the MCP server, so it can sit open on port 80 for anyone on the network.
const FILES = {
    '/': ['listen/index.html', 'text/html; charset=utf-8'],
    '/visual.js': ['listen/visual.js', 'application/javascript; charset=utf-8'],
    '/audio-listener.js': ['frontend/js/audio-listener.js', 'application/javascript; charset=utf-8'],
};

export function createListenServer({ capture, opus = null, root = import.meta.dirname }) {
    return createServer(async (req, res) => {
        const path = req.url.split('?')[0];
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { Allow: 'GET, HEAD' });
            res.end();
            return;
        }
        if (path === '/audio/live') {
            serveLiveAudio(capture, req, res, opus);
            return;
        }
        if (path === '/audio/status') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(capture.status()));
            return;
        }
        const file = FILES[path];
        if (!file) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found');
            return;
        }
        try {
            const body = await readFile(join(root, file[0]));
            res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
            res.end(req.method === 'HEAD' ? undefined : body);
        } catch {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Unavailable');
        }
    });
}

// Listens on the first of `ports` that can be opened (80 needs a permission the service may not have:
// the next port is then used) and resolves with it, or null when none could be.
export function listenOnFirstFree(server, ports) {
    return new Promise(resolve => {
        const attempt = index => {
            if (index >= ports.length) { resolve(null); return; }
            const onError = () => attempt(index + 1);
            server.once('error', onError);
            server.listen(ports[index], () => {
                server.off('error', onError);
                resolve(server.address().port);
            });
        };
        attempt(0);
    });
}
