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
