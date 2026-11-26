import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServer } from '../mcp-server.js';
import { DeviceCatalog } from '../device-catalog.js';

const BLOFELD = { id: 'Blofeld', name: 'Blofeld' };
const FREAK = { id: 'Arturia MicroFreak', name: 'Arturia MicroFreak' };
const notes = [{ note: 60, start: 0, duration: 1 }];

function setup() {
    const log = [], parts = [{ part: 1, channel: 5 }];
    const server = createMcpServer({
        catalog: new DeviceCatalog(new URL('../device_maps', import.meta.url).pathname),
        getOutputs: () => [BLOFELD, FREAK],
        getParts: () => parts,
        setPart: (name, part, channel) => { log.push({ part, channel }); return true; },
        setChannel: (name, channel) => { log.push({ device: name, channel }); return true; },
        getDawState: () => ({ tracks: [] }),
        selectPreset: (target, channel, index) => log.push({ preset: [target, channel, index] }),
        waitPresetName: async () => null,
        daw: message => log.push(message),
        listSessions: async () => ({ sessions: ['old'] }),
        sessionAction: async (type, name) => { log.push({ type, name }); return { ok: true, name, notes: 2, overwritten: false }; },
    });
    const call = async args => {
        const result = await server.callTool('daw_create_session', args);
        return { error: result.isError, text: result.content[0].text };
    };
    return { call, log };
}
const spec = {
    name: 'new song', tempo: 100,
    instruments: [{ device: 'Blofeld', channel: 5, preset: '59' }, { device: 'Blofeld', channel: 2, preset: '1' }, { device: 'MicroFreak', channel: 3, preset: '5' }],
    tracks: [{ channel: 5, clips: [{ notes }] }, { channel: 3, clips: [{ notes, bars: 2 }, { notes }, { notes }] }, { channel: 9 }],
};

test('daw_create_session sets sounds per synth and channel, builds the tracks and saves last', async () => {
    const { call, log } = setup();
    const result = await call(spec);
    assert.ok(!result.error, result.text);
    const data = JSON.parse(result.text);
    assert.deepEqual(data.instruments.map(i => [i.device, i.part, i.channel, i.preset]), [
        ['Blofeld', 1, 5, 59],                      // the part already on that channel
        ['Blofeld', 2, 2, 1],                       // else the part with the channel's number
        ['Arturia MicroFreak', undefined, 3, 5],
    ]);
    assert.match(data.warning, /channel 9/);
    assert.deepEqual(log.slice(0, 2).map(m => m.type), ['daw_reset_arm_record', 'daw_forget_sounds']);
    assert.deepEqual(log.filter(m => m.preset).map(m => m.preset), [['Blofeld', 5, 58], ['Blofeld', 2, 0], ['Arturia MicroFreak', 3, 4]]);
    assert.deepEqual(log.find(m => m.type === 'daw_set_layout'), { type: 'daw_set_layout', tracks: 3, slots: 3 });
    assert.equal(log.filter(m => m.type === 'daw_set_clip').length, 4);
    assert.deepEqual(log.at(-1), { type: 'daw_save_session', name: 'new song' });
});

test('daw_create_session changes nothing when any part of the request is wrong', async () => {
    const { call, log } = setup();
    const bad = [
        { ...spec, name: 'old' },                                                            // exists
        { ...spec, name: 'песня' },
        { ...spec, instruments: [{ device: 'Blofeld', channel: 2, preset: 'no such sound' }] },
        { ...spec, instruments: [{ device: 'Nothing', channel: 2 }] },
        { ...spec, instruments: [{ device: 'MicroFreak', channel: 2 }, { device: 'MicroFreak', channel: 3 }] },
        { ...spec, instruments: [{ device: 'Blofeld', channel: 2 }, { device: 'Blofeld', channel: 2 }] },
        { ...spec, tracks: [{ channel: 3, clips: [{ notes: [{ note: 200, start: 0, duration: 1 }] }] }] },
        { ...spec, tracks: [] },
    ];
    for (const args of bad) assert.ok((await call(args)).error, JSON.stringify(args).slice(0, 120));
    assert.deepEqual(log, []);
    assert.ok(!(await call({ ...spec, name: 'old', overwrite: true })).error);
});
