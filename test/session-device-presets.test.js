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

test('preset names are saved with the session and restored without asking the device', t => {
    const directory = mkdtempSync(join(tmpdir(), 'session-presets-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = new DAWEngine();
    worker._sessionsDir = () => directory;
    worker._listSessions = () => {};
    const synth = 'Arturia MicroFreak:MicroFreak MIDI 1 20:0';
    worker._rememberDeviceProgram(synth, 3, 300);
    worker._noteDevicePresetName({ target: synth, channel: 3, program: 299, name: 'Wrong' });
    assert.equal([...worker._devicePrograms.values()][0].name, undefined, 'a name for another preset is ignored');
    worker._noteDevicePresetName({ target: synth, channel: 3, program: 300, name: 'Warm Pad' });
    worker._rememberDeviceProgram(synth, 3, 300);
    assert.equal([...worker._devicePrograms.values()][0].name, 'Warm Pad', 'reselecting the same preset keeps its name');
    worker._saveSession('named');
    const saved = JSON.parse(readFileSync(join(directory, 'named.json'), 'utf8'));
    assert.deepEqual(saved.devicePresets, [{ target: synth, channel: 3, program: 300, name: 'Warm Pad' }]);

    const sent = [];
    worker.outputs = new Map([['Arturia MicroFreak:MicroFreak MIDI 1 40:0', { sendMessage: bytes => sent.push([...bytes]) }]]);
    for (const method of ['_stopAllClipPlayback', '_clearStaleRecordingFeedback', '_refreshPadLeds', '_syncPadClock', '_broadcastState']) worker[method] = () => {};
    worker._loadSession('named');
    assert.deepEqual(sent, [[0xB2, 0, 2], [0xC2, 44]], 'only Bank Select and Program Change go out, no SysEx name request');
    assert.equal([...worker._devicePrograms.values()][0].name, 'Warm Pad');
    worker._rememberDeviceProgram('Arturia MicroFreak:MicroFreak MIDI 1 40:0', 3, 301);
    assert.equal([...worker._devicePrograms.values()][0].name, undefined, 'a new preset drops the old name');
});

test('a name request missed while the synth loads the sound is repeated until it answers', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const worker = Object.create(MIDIRouterWorker.prototype);
    const target = 'Blofeld:Blofeld 32:0';
    const sent = [];
    worker.outputs = new Map([[target, { sendMessage: bytes => sent.push([...bytes]) }]]);
    worker._broadcastState = () => {};
    worker._sendPreset(target, 13, 17);
    const requests = () => sent.filter(bytes => bytes[0] === 0xF0).length;
    assert.equal(requests(), 1);
    t.mock.timers.tick(250);
    assert.equal(requests(), 2, 'asked again after the synth had time to load');
    worker._presetNames.pending.delete(Object.keys(Object.fromEntries(worker._presetNames.pending))[0] ?? '');
    for (const key of [...worker._presetNames.pending.keys()]) worker._presetNames.pending.delete(key);
    t.mock.timers.tick(5000);
    assert.equal(requests(), 2, 'no more requests once the name has arrived');
});

test('Blofeld parts, their channels, sounds and controls are saved with the session and restored', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const directory = mkdtempSync(join(tmpdir(), 'session-parts-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const synth = 'Waldorf Blofeld:Blofeld MIDI 1 24:0';
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = new DAWEngine();
    worker._sessionsDir = () => directory;
    worker._listSessions = () => {};
    worker._deviceChannels = { 'waldorf blofeld#1': 1, 'waldorf blofeld#2': 5, 'waldorf blofeld': 3, 'other synth': 2 };
    worker._rememberDeviceProgram(synth, 1, 12, 'Part one');
    worker._rememberDeviceProgram(synth, 5, 300, 'Part two');       // bank 2, program 44
    worker._rememberDeviceControl(synth, 5, 69, 99);
    worker._saveSession('multi');
    const saved = JSON.parse(readFileSync(join(directory, 'multi.json'), 'utf8'));
    assert.deepEqual(saved.deviceParts, { 'waldorf blofeld#1': 1, 'waldorf blofeld#2': 5 }, 'only parts, not plain channels');

    const sent = [];
    const posted = [];
    worker.outputs = new Map([['Waldorf Blofeld:Blofeld MIDI 1 28:0', { sendMessage: bytes => sent.push([...bytes]) }]]);
    for (const method of ['_stopAllClipPlayback', '_clearStaleRecordingFeedback', '_refreshPadLeds', '_syncPadClock', '_broadcastState']) worker[method] = () => {};
    worker._loadSession('multi');
    assert.deepEqual(sent.filter(bytes => bytes[0] === 0xC0), [[0xC0, 12]], 'part 1 restores its program');
    assert.equal(sent.some(bytes => bytes[0] === 0xC4), false, 'part 2 waits for part 1 to load');
    t.mock.timers.tick(300);
    assert.equal(sent.some(bytes => bytes[0] === 0xB4 && bytes[1] === 69), false, 'knobs wait until the last sound has loaded');
    t.mock.timers.tick(300);
    assert.ok(sent.some(bytes => bytes[0] === 0xC4 && bytes[1] === 44), 'part 2 restores its program on channel 5');
    assert.ok(sent.some(bytes => bytes[0] === 0xB4 && bytes[1] === 69 && bytes[2] === 99), 'part 2 control comes back');
    assert.equal([...worker._devicePrograms.values()].find(p => p.channel === 5).name, 'Part two');
});
