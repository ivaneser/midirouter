import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServer } from '../mcp-server.js';
import { DeviceCatalog, encodeControlValue, findControl } from '../device-catalog.js';

const FREAK = { id: 'Arturia MicroFreak:Arturia MicroFreak MIDI 1 20:0', name: 'Arturia MicroFreak:Arturia MicroFreak MIDI 1 20:0' };
const NTS = { id: 'NTS-1 digital kit:NTS-1 digital kit _ SOUND 24:0', name: 'NTS-1 digital kit:NTS-1 digital kit _ SOUND 24:0' };

function setup(extra = {}) {
    const sent = [], daw = [], presets = [];
    const state = { deviceControls: [], devicePresets: [] };
    const ctx = {
        catalog: new DeviceCatalog(new URL('../device_maps', import.meta.url).pathname),
        getOutputs: () => [FREAK, NTS],
        getChannel: () => 3,
        setChannel: () => true,
        getDawState: () => state,
        sendMidi: (target, bytes) => sent.push([target, bytes]),
        noteControl: (target, channel, cc, value) => state.deviceControls.push({ target, channel, cc, value }),
        selectPreset: (target, channel, index) => presets.push([target, channel, index]),
        presetName: () => null,
        waitPresetName: async () => 'Warm Pad',
        sendPerformance: (targets, bytes) => sent.push([targets, bytes]),
        daw: message => daw.push(message),
        listSessions: async () => ({ sessions: ['a'] }),
        panic: () => daw.push('panic'),
        later: (ms, fn) => fn(),
        ...extra,
    };
    const server = createMcpServer(ctx);
    const call = async (name, args) => {
        const { body } = await server.handlePost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
        const result = body.result;
        return { error: result.isError, data: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
    };
    return { server, call, sent, daw, presets, state };
}

test('initialize, tools/list and notifications follow the MCP handshake', async () => {
    const { server } = setup();
    const init = await server.handlePost({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    assert.equal(init.body.result.protocolVersion, '2025-03-26');
    assert.deepEqual((await server.handlePost({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const list = await server.handlePost({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.ok(list.body.result.tools.some(t => t.name === 'set_parameter'));
    assert.equal((await server.handlePost('{bad')).status, 400);
});

test('set_parameter sends a channel CC by name and keeps the UI state in step', async () => {
    const { call, sent, state } = setup();
    const result = await call('set_parameter', { device: 'microfreak', parameter: 'Filter Cutoff', value: 100 });
    assert.equal(result.data.cc, 23);
    assert.deepEqual(sent[0], [FREAK.id, [0xB2, 23, 100]]);
    assert.deepEqual(state.deviceControls[0], { target: FREAK.id, channel: 3, cc: 23, value: 100 });
    const params = await call('get_device_params', { device: 'microfreak', category: undefined });
    assert.equal(params.data.parameters.find(p => p.cc === 23).value, 100);
});

test('values are clamped and dropdowns take option labels', async () => {
    const nts = new DeviceCatalog(new URL('../device_maps', import.meta.url).pathname).forPort(NTS.name).map.controls;
    const eg = findControl(nts, 14);
    assert.equal(encodeControlValue(eg, 'AR loop').display, 3);
    assert.throws(() => encodeControlValue(eg, 'nonsense'), /options/);
    assert.equal(encodeControlValue({ type: 'slider', min: 0, max: 127, cc: 1, name: 'x' }, 500).raw, 127);
    assert.equal(encodeControlValue({ type: 'slider', min: -64, max: 63, cc: 1, name: 'x' }, 0).raw, 64);
});

test('set_parameters rejects the whole batch when one name is unknown', async () => {
    const { call, sent } = setup();
    const bad = await call('set_parameters', { device: 'microfreak', values: { cutoff: 50, nope: 1 } });
    assert.ok(bad.error);
    assert.equal(sent.length, 0);
    const ok = await call('set_parameters', { device: 'microfreak', values: { 'Filter Cutoff': 50, resonance: 20 } });
    assert.equal(ok.data.applied.length, 2);
});

test('select_preset resolves catalog names, uses bank-aware indexes and reports the device name', async () => {
    const { call, presets } = setup();
    const byNumber = await call('select_preset', { device: 'microfreak', preset: 200 });
    assert.deepEqual(presets[0], [FREAK.id, 3, 199]);
    assert.equal(byNumber.data.name, 'Warm Pad');
    const byName = await call('select_preset', { device: 'microfreak', preset: 'NervousKeys' });
    assert.deepEqual(presets[1], [FREAK.id, 3, 0]);
    assert.equal(byName.data.preset, 1);
    assert.ok((await call('select_preset', { device: 'microfreak', preset: 513 })).error);
    assert.ok((await call('select_preset', { device: 'NTS', preset: 129 })).error);
});

test('list_presets filters the catalog; unsupported devices report an error', async () => {
    const { call } = setup();
    const found = await call('list_presets', { device: 'microfreak', query: 'nervous' });
    assert.equal(found.data.presets[0].number, 1);
    assert.ok((await call('get_device_params', { device: 'nonexistent' })).error);
});

test('DAW tools post worker messages and play_notes schedules paired note on/off', async () => {
    const { call, daw, sent } = setup();
    await call('daw_set_tempo', { bpm: 128 });
    await call('daw_trigger_pad', { track: 0, slot: 2 });
    assert.deepEqual(daw, [{ type: 'daw_set_tempo', bpm: 128 }, { type: 'daw_pad_trigger', trackIdx: 0, slot: 2 }]);
    assert.ok((await call('daw_set_tempo', { bpm: 5 })).error);
    await call('play_notes', { device: 'microfreak', bpm: 120, notes: [{ note: 60, start: 0, duration: 1 }] });
    assert.deepEqual(sent.map(([, bytes]) => bytes), [[0x92, 60, 100], [0x82, 60, 0]]);
});

test('tools of the mcpi upstream are forwarded through the same endpoint', async () => {
    const calls = [];
    const upstream = {
        has: name => name === 'record_audio',
        listTools: async () => [{ name: 'record_audio', inputSchema: {} }, { name: 'set_parameter', inputSchema: {} }],
        callTool: async (name, args) => { calls.push([name, args]); return { content: [{ type: 'text', text: '{"rms":0.1}' }] }; },
    };
    const { server, call } = setup({ upstream });
    const list = (await server.handlePost({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).body.result.tools;
    assert.equal(list.filter(t => t.name === 'set_parameter').length, 1, 'own tool wins over upstream duplicate');
    assert.ok(list.some(t => t.name === 'record_audio'));
    assert.deepEqual((await call('record_audio', { seconds: 2 })).data, { rms: 0.1 });
    assert.deepEqual(calls, [['record_audio', { seconds: 2 }]]);
});

test('parts of a multitimbral instrument are separate devices with their own channels', async () => {
    const blofeld = { id: 'Waldorf Blofeld:Waldorf Blofeld MIDI 1 24:0', name: 'Waldorf Blofeld:Waldorf Blofeld MIDI 1 24:0' };
    const parts = [{ part: 1, channel: 1 }, { part: 3, channel: 9 }];
    const { call, sent } = setup({
        getOutputs: () => [blofeld],
        getParts: () => parts,
        getChannel: (name, part) => parts.find(p => p.part === part)?.channel ?? 1,
    });
    const listed = await call('list_devices', {});
    assert.deepEqual(listed.data.map(d => [d.part, d.channel, d.device]), [[1, 1, `${blofeld.name} part 1`], [3, 9, `${blofeld.name} part 3`]]);
    const set = await call('set_parameter', { device: 'blofeld part 3', parameter: 35, value: 2 });
    assert.equal(set.data.channel, 9);
    assert.deepEqual(sent[0][1].slice(0, 2), [0xB8, 35]);
    assert.ok((await call('set_parameter', { device: 'blofeld part 2', parameter: 35, value: 1 })).error, 'part 2 is not added');
});

test('DAW authoring tools validate input and forward worker messages', async () => {
    const { call, daw, state } = setup();
    state.tracks = [{ clips: [{}, {}] }];
    assert.equal((await call('daw_reset', {})).error, undefined);
    assert.deepEqual(daw.pop(), { type: 'daw_reset_arm_record' });
    await call('daw_set_layout', { tracks: 3, slots: 4 });
    assert.deepEqual(daw.pop(), { type: 'daw_set_layout', tracks: 3, slots: 4 });
    assert.ok((await call('daw_set_layout', {})).error);

    const notes = [{ note: 60, start: 0, duration: 1 }, { note: 64, start: 1, duration: 1, velocity: 90 }];
    const ok = await call('daw_set_clip', { track: 0, slot: 1, device: 'MicroFreak', notes });
    assert.equal(ok.data.channel, 3);
    assert.deepEqual(daw.pop(), { type: 'daw_set_clip', trackIdx: 0, slot: 1, channel: 3, bars: undefined, notes: [
        { note: 60, start: 0, dur: 1, velocity: 100 }, { note: 64, start: 1, dur: 1, velocity: 90 }] });
    assert.ok((await call('daw_set_clip', { track: 0, slot: 2, channel: 1, notes })).error);   // no such slot
    assert.ok((await call('daw_set_clip', { track: 0, slot: 0, notes })).error);               // no channel
    assert.ok((await call('daw_set_clip', { track: 0, slot: 0, channel: 1, notes: [{ note: 200, start: 0, duration: 1 }] })).error);

    await call('daw_track', { action: 'mute', track: 2 });
    assert.deepEqual(daw.pop(), { type: 'daw_mute_track', trackIdx: 2 });
    assert.ok((await call('daw_track', { action: 'solo' })).error);

    await call('daw_set_clock', { source: 'external', port: 'Keystep', output: false });
    assert.deepEqual(daw.splice(-2), [{ type: 'clock_source_select', kind: 'external', portName: 'Keystep' }, { type: 'daw_midi_clock_off' }]);
    assert.ok((await call('daw_set_clock', { source: 'external' })).error);

    await call('daw_set_metronome', { enabled: false, beats_per_measure: 3 });
    assert.deepEqual(daw.splice(-2), [{ type: 'daw_metronome_off' }, { type: 'daw_metronome_beats_per_measure', bpm: 3 }]);
    await call('daw_sessions', { action: 'delete', name: 'old' });
    assert.deepEqual(daw.pop(), { type: 'daw_delete_session', name: 'old' });
});

test('DAWEngine.setClipNotes fills a clip, assigns the channel and rounds the length to bars', async () => {
    const { DAWEngine } = await import('../daw.js');
    const daw = new DAWEngine();
    const clip = daw.setClipNotes(1, 0, [{ note: 60, start: 0, dur: 1, velocity: 100 }, { note: 62, start: 4.5, dur: 1, velocity: 80 }], 7);
    assert.equal(clip.notes.length, 2);
    assert.equal(clip.notes[0].channel, 7);
    assert.equal(clip.length, 8);
    assert.equal(daw.tracks[1].channel, 7);
    assert.equal(daw.tracks[1].channelAssigned, true);
    assert.equal(daw.setClipNotes(99, 0, [], 1), null);
});

test('send_cc sends a validated raw control change and records it', async () => {
    const { call, sent, state } = setup();
    const ok = await call('send_cc', { device: 'MicroFreak', cc: 7, value: 90, channel: 2 });
    assert.equal(ok.data.cc, 7);
    assert.deepEqual(sent.pop(), [FREAK.id, [0xB1, 7, 90]]);
    assert.deepEqual(state.deviceControls.pop(), { target: FREAK.id, channel: 2, cc: 7, value: 90 });
    assert.ok((await call('send_cc', { device: 'MicroFreak', cc: 120, value: 1 })).error);
    assert.ok((await call('send_cc', { device: 'MicroFreak', cc: 7, value: 128 })).error);
});
