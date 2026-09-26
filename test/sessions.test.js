import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DAWEngine } from '../daw.js';
import { MIDIRouterWorker } from '../worker-midi.js';

test('DAW toData/loadData round-trips full clip content', () => {
    const daw = new DAWEngine({ tempo: 100 });
    daw.setSlotsPerTrack(2);
    daw.tracks[0].clips[0].notes = [{ channel: 1, note: 60, velocity: 90, start: 0.5, dur: 0.5 }];
    daw.tracks[0].clips[0].length = 8;
    daw.tracks[3].clips[1].notes = [{ channel: 4, note: 72, velocity: 64, start: 1, dur: 1 }];
    daw.tracks[3].clips[1].length = 4;
    daw.tracks[3].muted = true;

    const data = daw.toData();
    assert.equal(data.version, 1);
    assert.equal(data.tempo, 100);

    const daw2 = new DAWEngine({ tempo: 120 });
    daw2.loadData(data);

    assert.equal(daw2.tempo, 100);
    assert.deepEqual(daw2.tracks[0].clips[0].notes, daw.tracks[0].clips[0].notes);
    assert.equal(daw2.tracks[0].clips[0].length, 8);
    assert.deepEqual(daw2.tracks[3].clips[1].notes, daw.tracks[3].clips[1].notes);
    assert.equal(daw2.tracks[3].clips[1].length, 4);
    assert.equal(daw2.tracks[3].muted, true);
    assert.ok(daw2.clipState.every((s) => s === -1), 'loaded session must not start playback');

    // invalid data must be rejected
    assert.throws(() => daw2.loadData(null));
    assert.throws(() => daw2.loadData({ tracks: 'nope' }));
});

function makeWorker(dir) {
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = new DAWEngine({ tempo: 120 });
    worker.outputs = new Map();
    worker._trackPlayTimers = new Map();
    worker._ledGlow = new Map();
    worker._padLedSent = new Map();
    worker._broadcastState = () => {};
    worker._sendFeedback = () => {};
    worker._refreshPadLeds = () => {};
    worker._clearStaleRecordingFeedback = () => {};
    worker._sessionsDir = () => dir;
    return worker;
}

test('worker save/list/load/delete sessions on disk', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'midirouter-sessions-'));
    t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

    const worker = makeWorker(dir);
    worker.daw.tracks[0].clips[0].notes = [{ channel: 1, note: 60, velocity: 90, start: 0, dur: 0.5 }];
    worker.daw.tracks[0].clips[0].length = 4;

    worker._saveSession('demo set');
    const file = path.join(dir, 'demo set.json');
    assert.ok(fs.existsSync(file), 'session file must be created in sessions dir');

    // path traversal / dotfiles must be neutralized
    worker._saveSession('../etc/passwd');
    assert.ok(!fs.existsSync(path.join(dir, '..', 'etc.json')));
    assert.ok(!fs.existsSync(path.join(dir, '.etcpasswd.json')));
    assert.ok(!fs.existsSync(path.join(dir, '..etcpasswd.json')));

    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(data.tracks[0].clips[0].notes.length, 1);

    // load into a fresh worker
    const worker2 = makeWorker(dir);
    worker2._loadSession('demo set');
    assert.equal(worker2.daw.tracks[0].clips[0].notes.length, 1);
    assert.equal(worker2.daw.tracks[0].clips[0].notes[0].note, 60);
    assert.equal(worker2.daw.tracks[0].clips[0].length, 4);

    // missing session must not throw
    assert.doesNotThrow(() => worker2._loadSession('nope'));

    // delete
    worker._deleteSession('demo set');
    assert.ok(!fs.existsSync(file), 'deleted session must be removed from disk');
});

test('session name sanitizer keeps only safe characters', () => {
    const worker = makeWorker('/tmp');
    // slashes removed, traversal dots stay inert
    assert.equal(worker._sessionNameOf('my session/../../x'), 'my session....x');
    assert.equal(worker._sessionNameOf('a.json'), 'a');
    assert.equal(worker._sessionNameOf('..'), '');
    assert.equal(worker._sessionNameOf(''), '');
    assert.equal(worker._sessionNameOf('...hidden'), 'hidden');
});
