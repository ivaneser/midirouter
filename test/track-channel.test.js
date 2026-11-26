import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServer } from '../mcp-server.js';
import { DeviceCatalog } from '../device-catalog.js';
import { DAWEngine } from '../daw.js';

const FREAK = { id: 'Arturia MicroFreak:Arturia MicroFreak MIDI 1 20:0', name: 'Arturia MicroFreak:Arturia MicroFreak MIDI 1 20:0' };
const NTS = { id: 'NTS-1 digital kit:NTS-1 digital kit _ SOUND 24:0', name: 'NTS-1 digital kit:NTS-1 digital kit _ SOUND 24:0' };

function setup(channels, state = { tracks: [{ clips: [] }, { clips: [] }] }) {
    const daw = [], presets = [];
    const server = createMcpServer({
        catalog: new DeviceCatalog(new URL('../device_maps', import.meta.url).pathname),
        getOutputs: () => [FREAK, NTS],
        getChannel: name => channels[name],
        getParts: () => [],
        getDawState: () => state,
        selectPreset: (target, channel, index) => presets.push([target, channel, index]),
        presetName: () => null,
        waitPresetName: async () => 'Warm Pad',
        daw: message => daw.push(message),
    });
    return { server, daw, presets };
}
const call = async (server, args) => (await server.callTool('daw_set_track_channel', args));

test('daw_set_track_channel takes a channel or a device, and never touches the sound', async () => {
    const { server, daw, presets } = setup({ [FREAK.name]: 3, [NTS.name]: 4 });
    const byDevice = await call(server, { track: 1, device: 'MicroFreak' });
    assert.ok(!byDevice.isError, byDevice.content[0].text);
    const byChannel = JSON.parse((await call(server, { track: 0, channel: 4 })).content[0].text);
    assert.deepEqual(byChannel.played_by, [NTS.name]);
    assert.deepEqual(daw, [{ type: 'daw_set_track_channel', trackIdx: 1, channel: 3 }, { type: 'daw_set_track_channel', trackIdx: 0, channel: 4 }]);
    assert.deepEqual(presets, []);
});

test('daw_set_track_channel changes nothing on a bad request', async () => {
    const { server, daw } = setup({ [FREAK.name]: 3 }, { tracks: [{ clips: [] }], recording: { track: 0 } });
    assert.ok((await call(server, { track: 0, channel: 2 })).isError, 'recording');
    assert.ok((await call(server, { track: 7, channel: 2 })).isError, 'no such track');
    const other = setup({});
    assert.ok((await call(other.server, { track: 0 })).isError, 'neither channel nor device');
    assert.ok((await call(other.server, { track: 0, channel: 17 })).isError);
    assert.deepEqual([...daw, ...other.daw], []);
});

test('setTrackChannel moves the track and its notes, leaving other channels of a multi-part clip', () => {
    const daw = new DAWEngine();
    daw.setClipNotes(0, 0, [{ note: 60, start: 0, dur: 1, velocity: 90 }, { note: 62, start: 1, dur: 1, velocity: 90, channel: 9 }], 2);
    assert.equal(daw.setTrackChannel(0, 5), true);
    assert.equal(daw.tracks[0].channel, 5);
    assert.deepEqual(daw.tracks[0].clips[0].notes.map(n => n.channel), [5, 9]);
    assert.equal(daw.setTrackChannel(1, 7), true, 'an empty track takes a channel too');
    assert.equal(daw.tracks[1].channelAssigned, true);
    assert.equal(daw.setTrackChannel(99, 5), false);
    assert.equal(daw.setTrackChannel(0, 17), false);
});
