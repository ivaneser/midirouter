import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import net from 'net';

const REPO_DIR = new URL('../', import.meta.url).pathname;

/** Poll until a TCP connection to localhost:port succeeds. */
async function waitUntilListening(port, { timeoutMs = 20_000, backoffMs = 500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let waited = 0;
    while (Date.now() < deadline) {
        try {
            await new Promise((resolve, reject) => {
                const s = net.createConnection(port, '127.0.0.1');
                s.once('connect', () => { s.end(); resolve(); });
                s.once('error', err => { s.destroy(); reject(err); });
                setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, 1500);
            });
            return;
        } catch (e) {
            waited += backoffMs;
            if (Date.now() + backoffMs > deadline) throw new Error(`server did not start listening within ${waited}ms`);
            await new Promise(r => setTimeout(r, backoffMs));
        }
    }
    throw new Error(`server did not start listening within ${timeoutMs}ms`);
}

/**
 * Regression test for DEBUGGING.md #4: the server must exit with code 0 on
 * SIGINT even when a WebSocket client is still connected.
 *
 * Previously `process.on('SIGINT')` called `wss.close()` without terminating
 * the open clients, so the event loop stayed alive until the force-exit timer
 * fired and `process.exit(1)` ran.
 */
test('server exits with code 0 on SIGINT while a WS client is connected', async () => {
    // Pick a free port to avoid collisions with other running servers.
    const port = await new Promise((resolve, reject) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const p = s.address().port;
            s.close(() => resolve(p));
        });
    });

    const sp = spawn(process.execPath, ['server.js'], {
        cwd: REPO_DIR,
        env: { ...process.env, PORT: String(port) },
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    sp.stdout.on('data', d => (stdout += d));
    sp.stderr.on('data', d => (stderr += d));

    // Wait for the TCP listener to come up (retrying, so this is robust).
    await waitUntilListening(port);

    // Connect the regression client.
    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => { ws.close(); reject(new Error('client connect timeout')); }, 5000);
        ws.on('open', () => { clearTimeout(t); resolve(null); });
    });

    // Give the worker a moment to enumerate ports so the client is truly "active".
    await new Promise(r => setTimeout(r, 1000));

    sp.kill('SIGINT');

    const t0 = Date.now();
    const [code, signal] = await new Promise(resolve => {
        sp.on('exit', (code, signal) => resolve([code, signal]));
    });
    const elapsed = Date.now() - t0;

    // The graceful path must complete promptly on WS `close` -- well below the
    // 3-second fallback timeout. (1.5s is a soft ceiling: if the real driver is
    // WebSocket close this passes comfortably; 3s proves we are NOT waiting on
    // the fallback timer.)
    assert.ok(elapsed < 1500, `SIGINT shutdown did not complete within 1.5s (took ${elapsed}ms -- likely waiting on the 3s fallback)`);

    assert.equal(signal, null, 'process should exit via code, not be killed by a signal');
    assert.equal(code, 0, `expected exit code 0; got ${code}. stderr: ${stderr.slice(0, 1000)}`);

    ws.close();

    // Safety net: kill stragglers if the process is somehow still alive.
    setTimeout(() => {
        if (!sp.killed) sp.kill('SIGKILL');
    }, 2000);
});

test('server exits with code 0 on SIGINT when no clients are connected', async () => {
    const port = await new Promise((resolve, reject) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const p = s.address().port;
            s.close(() => resolve(p));
        });
    });

    const sp = spawn(process.execPath, ['server.js'], {
        cwd: REPO_DIR,
        env: { ...process.env, PORT: String(port) },
        stdio: 'pipe',
    });

    // Wait for the listener to come up (retrying).
    await waitUntilListening(port);

    // No client connected -- just send SIGINT immediately.
    const t0 = Date.now();
    sp.kill('SIGINT');

    const [code, signal] = await new Promise(resolve => {
        sp.on('exit', (code, signal) => resolve([code, signal]));
    });
    const elapsed = Date.now() - t0;

    assert.equal(signal, null, 'process should exit via code, not be killed by a signal');
    assert.equal(code, 0, `expected exit code 0 on clean shutdown; got ${code}`);
    assert.ok(elapsed < 6000, `shutdown took ${elapsed}ms -- expected well under the fallback timeout`);

    // Safety net.
    setTimeout(() => {
        if (!sp.killed) sp.kill('SIGKILL');
    }, 2000);
});
