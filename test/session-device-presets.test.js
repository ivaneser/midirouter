import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIDIRouterWorker } from '../worker-midi.js';
import { DAWEngine } from '../daw.js';

test('sessions save and restore device programs on their channels after port renumbering', t => {
    const directory = mkdtempSync(join(tmpdir(), 'session-presets-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = new DAWEngine();
    worker._sessionsDir = () => directory;
    worker._listSessions = () => {};
    worker._rememberDeviceProgram('Test synth:Midi 20:0', 7, 42);
    worker._saveSession('test');
    const saved = JSON.parse(readFileSync(join(directory, 'test.json'), 'utf8'));
    assert.deepEqual(saved.devicePresets, [{ target: 'Test synth:Midi 20:0', channel: 7, program: 42 }]);
    const sent = [];
    worker.outputs = new Map([['Test synth:Midi 40:0', { sendMessage: bytes => sent.push([...bytes]) }]]);
    for (const method of ['_stopAllClipPlayback', '_clearStaleRecordingFeedback', '_refreshPadLeds', '_syncPadClock', '_broadcastState']) worker[method] = () => {};
    worker._loadSession('test');
    assert.deepEqual(sent, [[0xC6, 42]]);
    assert.equal([...worker._devicePrograms.values()][0].target, 'Test synth:Midi 40:0');
    worker._restoreDevicePrograms([{ target: 'Missing', channel: 1, program: 2 }, { target: 'Test synth:Midi 40:0', channel: 17, program: 3 }]);
    assert.equal(sent.length, 1, 'missing devices and invalid channels do not send');
    worker._restoreDevicePrograms(undefined);
    assert.equal(worker._devicePrograms.size, 0, 'old sessions load without preset data');
});

test('instrument control values are saved with the session and re-sent on load', async () => {
    const { MIDIRouterWorker } = await import('../worker-midi.js');
    const w = Object.create(MIDIRouterWorker.prototype);
    const sent = [];
    w.outputs = new Map([['Synth:Synth 20:0', { sendMessage: b => sent.push([...b]) }]]);
    w._rememberDeviceControl('Synth:Synth 20:0', 2, 34, 99);
    const saved = [...w._deviceControls.values()];
    assert.deepEqual(saved, [{ target: 'Synth:Synth 20:0', channel: 2, cc: 34, value: 99 }]);
    w.outputs = new Map([['Synth:Synth 24:0', { sendMessage: b => sent.push([...b]) }]]);
    w._restoreDeviceControls([...saved, { target: 'x', channel: 99, cc: 1, value: 1 }]);
    assert.deepEqual(sent, [[0xB1, 34, 99]]);
    assert.equal(w._deviceControls.size, 1, 'invalid entries are dropped');
});
