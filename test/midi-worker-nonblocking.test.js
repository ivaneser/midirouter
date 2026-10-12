// ---------------------------------------------------------------------------
// Regression: `_verifyOutputConnections` must not block the Node event loop.
//
// The ALSA subscription check shells out to `aconnect -l`.  A synchronous
// `execSync` call freezes every timer in the worker thread while the command
// is running — on a busy Pi that is hundreds of milliseconds per hot-plug
// tick.  This test proves the probe is asynchronous: it returns a Promise,
// and an event-loop timer scheduled *before* the call still fires while the
// fake `aconnect` is pending.
//
// Hardware-free: no MIDI devices are opened.  A stub executable named
// `aconnect` that sleeps ~0.2 s (printing nothing) is placed on PATH in a
// temp directory, so the real ALSA binary is never touched.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MIDIRouterWorker } from '../worker-midi.js';

/**
 * Create a worker instance WITHOUT invoking the constructor, so no ALSA
 * hardware probes, audio devices, or timers are started.  Only the state the
 * probe touches is seeded manually: one registered output and no output
 * enumerator (so `_filterPorts` is never called).
 */
function makeBareWorker() {
    const w = Object.create(MIDIRouterWorker.prototype);

    // One "open" output.  The value object is a plain sentinel — the probe
    // only reads `output._index` when it decides to reopen, and with an
    // empty fake listing no port is found at all, so nothing is reopened.
    w.outputs = new Map([['Fake MIDI:Port 1:0', {}]]);

    // No output enumerator: `_verifyOutputConnections` guards on `this._enumOut`
    // before calling `_filterPorts`, so the real RtMidi output client is never
    // created.
    w._enumOut = null;

    return w;
}

test('aconnect output verification yields a Promise and does not block the event loop', async (t) => {
    // --- Fake `aconnect` on PATH: sleeps ~0.2 s, prints nothing -----------
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'midirouter-aconnect-'));
    const fakeAconnect = path.join(tmpDir, 'aconnect');
    fs.writeFileSync(fakeAconnect, '#!/bin/sh\nsleep 0.2\n', { mode: 0o755 });

    const oldPath = process.env.PATH;
    process.env.PATH = `${tmpDir}${path.delimiter}${oldPath}`;

    t.after(() => {
        process.env.PATH = oldPath;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const worker = makeBareWorker();

    // --- Event-loop liveness probe ---------------------------------------
    // If the `aconnect` call were synchronous (execSync), this timer would be
    // starved until the fake command finished — i.e. it could only fire
    // *after* the probe settled.  Firing while the probe is still pending is
    // proof the event loop stayed free.
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 25);

    // Clear the liveness timer in cleanup no matter how far the test got —
    // e.g. if an assertion below throws, a pending 25 ms timer would keep
    // firing after the test is done (and after PATH/tmpdir are torn down).
    t.after(() => clearTimeout(timer));

    // --- Kick off the verification ----------------------------------------
    const probe = worker._verifyOutputConnections();

    // The probe must be a thenable (Promise).  A synchronous execSync-based
    // implementation returns `undefined` here.
    assert.ok(probe && typeof probe.then === 'function',
        '_verifyOutputConnections() must return a Promise');

    // Sleep long enough that the 25 ms liveness timer is guaranteed to have
    // fired, while still far short of the fake `aconnect`'s ~0.2 s sleep — so
    // if the loop stayed free, `timerFired` flips during this window and the
    // probe is still pending when we check.  (A bare `setImmediate` turn can
    // resolve in well under 25 ms and would not prove anything.)
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(timerFired, true,
        'event-loop timer fired while the fake aconnect was still pending');

    // The probe is still unsettled at this point (fake command sleeps 0.2 s;
    // only ~a few ms have elapsed).
    let settled = false;
    const race = Promise.race([
        probe.then(() => { settled = true; }, () => { settled = true; }),
        new Promise((resolve) => setTimeout(resolve, 5)),
    ]);
    await race;

    assert.equal(settled, false,
        'probe must still be pending while the fake aconnect is running');

    // Settle it for real.  With an empty listing no output port is found, so
    // nothing is reopened and the Promise resolves cleanly.
    await probe;
});
