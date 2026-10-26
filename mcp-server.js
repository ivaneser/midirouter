import { MULTITIMBRAL_PARTS } from './frontend/js/synth-catalog.js';
import { deviceChannelKey, validMidiChannel } from './frontend/js/device-channels.js';
import { resolveOutput, findControl, encodeControlValue, decodeControlValue } from './device-catalog.js';

// Minimal MCP server (Streamable HTTP, JSON responses, stateless). It exposes the "MIDI devices"
// section of the UI -- ports, channels, instrument parameters, presets -- and the DAW transport
// to an LLM. Everything goes through `ctx`, which wraps the same router paths the browser uses,
// so the router stays the only owner of the MIDI ports.
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'midirouter', version: '0.1.0' };
const MAX_NOTES = 256;
const MAX_PLAY_SECONDS = 120;

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const DEVICE = { type: 'string', description: 'Output port: id, full name, or a unique part of the name (see list_devices)' };
const CHANNEL = { type: 'integer', minimum: 1, maximum: 16, description: 'MIDI channel 1-16; defaults to the channel set for the device in the UI' };

export const TOOLS = [
    { name: 'list_devices', description: 'List connected MIDI outputs with model, receive channel, current preset and whether a control map is available.', inputSchema: obj({}) },
    { name: 'get_device_params', description: 'Control map of a device: every parameter with CC number, range or options, category, description and its current value.', inputSchema: obj({ device: DEVICE, category: { type: 'string', description: 'Only this category (osc, filter, amp, env, fx, mod, ...)' } }, ['device']) },
    { name: 'get_device_state', description: 'Last values sent to a device (by parameter name) plus its current preset. MIDI has no readback, so this is what the router last sent.', inputSchema: obj({ device: DEVICE, channel: CHANNEL }, ['device']) },
    { name: 'set_parameter', description: 'Set one parameter by name or CC number. Sliders take the displayed value (signed ranges allowed), dropdowns an option label or index, toggles true/false. The UI knob moves too.', inputSchema: obj({ device: DEVICE, parameter: { type: ['string', 'integer'] }, value: { type: ['number', 'string', 'boolean'] }, channel: CHANNEL }, ['device', 'parameter', 'value']) },
    { name: 'set_parameters', description: 'Set several parameters at once: values maps parameter name (or CC number) to value.', inputSchema: obj({ device: DEVICE, values: { type: 'object', additionalProperties: { type: ['number', 'string', 'boolean'] } }, channel: CHANNEL }, ['device', 'values']) },
    { name: 'send_cc', description: 'Send a raw Control Change (cc 1-119 except 32) for things outside the control map, e.g. part volume (7), pan (10, 64 = centre). Prefer set_parameter when the control is listed.', inputSchema: obj({ device: DEVICE, cc: { type: 'integer', minimum: 1, maximum: 119 }, value: { type: 'integer', minimum: 0, maximum: 127 }, channel: CHANNEL }, ['device', 'cc', 'value']) },
    { name: 'list_presets', description: 'Preset catalog of a device (name, number, tags) when one is available; supports a name filter.', inputSchema: obj({ device: DEVICE, query: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['device']) },
    { name: 'select_preset', description: 'Switch preset: Bank Select + Program Change. preset is the 1-based global number (as in list_presets) or a catalog name. Returns the preset name when the device reports it.', inputSchema: obj({ device: DEVICE, preset: { type: ['integer', 'string'] }, channel: CHANNEL }, ['device', 'preset']) },
    { name: 'set_device_channel', description: 'Set the MIDI channel the router uses for UI/MCP messages to a device.', inputSchema: obj({ device: DEVICE, channel: CHANNEL }, ['device', 'channel']) },
    { name: 'panic', description: 'All notes off on every output.', inputSchema: obj({}) },
    { name: 'daw_get_state', description: 'DAW state: tempo, transport, record mode, tracks and clips.', inputSchema: obj({}) },
    { name: 'daw_set_tempo', description: 'Set DAW tempo in BPM (20-300).', inputSchema: obj({ bpm: { type: 'number', minimum: 20, maximum: 300 } }, ['bpm']) },
    { name: 'daw_set_record_mode', description: 'Record mode: none (play), replace or overdub.', inputSchema: obj({ mode: { enum: ['none', 'replace', 'overdub'] } }, ['mode']) },
    { name: 'daw_transport', description: 'Start or stop the DAW transport.', inputSchema: obj({ action: { enum: ['play', 'stop'] } }, ['action']) },
    { name: 'daw_trigger_pad', description: 'Press a clip pad (0-based track and slot): starts/stops recording or playback according to the record mode.', inputSchema: obj({ track: { type: 'integer', minimum: 0, maximum: 7 }, slot: { type: 'integer', minimum: 0, maximum: 15 } }, ['track', 'slot']) },
    { name: 'daw_sessions', description: 'List, save, load or delete DAW sessions (clips plus instrument presets and parameter values).', inputSchema: obj({ action: { enum: ['list', 'save', 'load', 'delete'] }, name: { type: 'string' } }, ['action']) },
    { name: 'daw_reset', description: 'Reset the DAW session: stop playback and transport, erase all clips, restore the default 6 tracks x 2 clips and Play mode. Does not change device presets or channels.', inputSchema: obj({}) },
    { name: 'daw_set_layout', description: 'Set the number of tracks (1-16) and/or clips per track (1-16). Stops playback; existing clips beyond the new size are dropped.', inputSchema: obj({ tracks: { type: 'integer', minimum: 1, maximum: 16 }, slots: { type: 'integer', minimum: 1, maximum: 16 } }) },
    { name: 'daw_set_clip', description: 'Write a looping clip without recording. Give device (its channel is used) or channel. notes: [{note, start beats, duration beats, velocity}], beat 0 = clip start. Length rounds up to whole bars (or set bars). Start it with daw_trigger_pad once daw_transport play is running.', inputSchema: obj({
        track: { type: 'integer', minimum: 0, maximum: 15 }, slot: { type: 'integer', minimum: 0, maximum: 15 }, device: DEVICE, channel: CHANNEL, bars: { type: 'integer', minimum: 1, maximum: 64 },
        notes: { type: 'array', maxItems: 1024, items: obj({ note: { type: 'integer', minimum: 0, maximum: 127 }, start: { type: 'number', minimum: 0 }, duration: { type: 'number', exclusiveMinimum: 0 }, velocity: { type: 'integer', minimum: 1, maximum: 127 } }, ['note', 'start', 'duration']) },
    }, ['track', 'slot', 'notes']) },
    { name: 'daw_clear_clip', description: 'Erase one clip (stops it first).', inputSchema: obj({ track: { type: 'integer', minimum: 0, maximum: 15 }, slot: { type: 'integer', minimum: 0, maximum: 15 } }, ['track', 'slot']) },
    { name: 'daw_stop_clip', description: 'Stop the clip playing on a track.', inputSchema: obj({ track: { type: 'integer', minimum: 0, maximum: 15 } }, ['track']) },
    { name: 'daw_track', description: 'Track controls: add_track, remove_track, add_clip (append a clip to the track), arm, mute or solo (arm/mute/solo toggle).', inputSchema: obj({ action: { enum: ['add_track', 'remove_track', 'add_clip', 'arm', 'mute', 'solo'] }, track: { type: 'integer', minimum: 0, maximum: 15 } }, ['action']) },
    { name: 'daw_set_loop_bars', description: 'Master loop length in bars (1-64); every clip then repeats for exactly this long.', inputSchema: obj({ bars: { type: 'integer', minimum: 1, maximum: 64 } }, ['bars']) },
    { name: 'daw_set_clock', description: 'Master clock. source: internal (the router is clock master) or external (follow the MIDI input named port). output: send MIDI clock to devices on or off.', inputSchema: obj({ source: { enum: ['internal', 'external'] }, port: { type: 'string', description: 'Input port name for external source' }, output: { type: 'boolean' } }) },
    { name: 'daw_set_metronome', description: 'Metronome on/off and beats per measure (1-16), which sets the bar length.', inputSchema: obj({ enabled: { type: 'boolean' }, beats_per_measure: { type: 'integer', minimum: 1, maximum: 16 } }) },
    { name: 'daw_set_quantize', description: 'Quantize grid for recorded takes in beats: 0 (off), 0.125, 0.25, 0.5, 1 or 2.', inputSchema: obj({ beats: { enum: [0, 0.125, 0.25, 0.5, 1, 2] } }, ['beats']) },
    { name: 'set_device_part', description: 'Add or move a part of a multitimbral instrument (e.g. Blofeld part 2 on channel 6), or remove it. Afterwards address it as "<device> part <n>".', inputSchema: obj({ device: DEVICE, part: { type: 'integer', minimum: 1, maximum: 16 }, channel: CHANNEL, remove: { type: 'boolean' } }, ['device', 'part']) },
    { name: 'play_notes', description: 'Play timed notes on a device now. An armed DAW recording captures them. notes: [{note 0-127, start beats, duration beats, velocity 1-127}].', inputSchema: obj({
        device: DEVICE, channel: CHANNEL, bpm: { type: 'number', minimum: 20, maximum: 300 },
        notes: { type: 'array', maxItems: MAX_NOTES, items: obj({ note: { type: 'integer', minimum: 0, maximum: 127 }, start: { type: 'number', minimum: 0 }, duration: { type: 'number', exclusiveMinimum: 0 }, velocity: { type: 'integer', minimum: 1, maximum: 127 } }, ['note', 'start', 'duration']) },
    }, ['device', 'notes']) },
];

class ToolError extends Error {}

export function createMcpServer(ctx) {
    const outputs = () => ctx.getOutputs();
    // "Blofeld part 3" selects part 3 of a multitimbral instrument (its own channel).
    const resolve = device => {
        const match = /^(.*?)[\s#:_-]*part[\s#:_-]*(\d{1,2})$/i.exec(String(device ?? '').trim());
        const output = resolveOutput(outputs(), match ? match[1] : device);
        if (!match) return output;
        const part = Number(match[2]);
        if (!MULTITIMBRAL_PARTS[ctx.catalog.forPort(output.name)?.model]) throw new ToolError(`"${output.name}" is not multitimbral`);
        if (!ctx.getParts(output.name).some(p => p.part === part)) throw new ToolError(`part ${part} is not added; add it in the UI or use list_devices`);
        return { ...output, part };
    };
    const channelFor = (output, channel) => {
        if (channel === undefined) return ctx.getChannel(output.name, output.part);
        if (!validMidiChannel(channel)) throw new ToolError('channel must be 1-16');
        return channel;
    };
    const catalogFor = output => {
        const entry = ctx.catalog.forPort(output.name);
        if (!entry) throw new ToolError(`no control map for "${output.name}" (supported: Craft Synth, NTS-1 digital kit, MicroFreak)`);
        return entry;
    };
    const rawValues = (output, channel) => {
        const key = deviceChannelKey(output.id);
        const values = new Map();
        for (const c of ctx.getDawState()?.deviceControls || []) {
            if (deviceChannelKey(c.target) === key && c.channel === channel) values.set(c.cc, c.value);
        }
        return values;
    };
    const currentProgram = (output, channel) => {
        const key = deviceChannelKey(output.id);
        const found = (ctx.getDawState()?.devicePresets || []).find(p => deviceChannelKey(p.target) === key && p.channel === channel);
        if (!found) return null;
        return { index: found.program, number: found.program + 1, name: ctx.presetName(output.id, channel, found.program) ?? found.name ?? presetCatalogName(output, found.program) };
    };
    const presetCatalogName = (output, index) => ctx.catalog.forPort(output.name)?.presets?.presets?.[String(index + 1)]?.name ?? null;

    const sendControl = (output, channel, control, value) => {
        const { display, raw } = encodeControlValue(control, value);
        ctx.sendMidi(output.id, [0xB0 | (channel - 1), control.cc, raw]);
        ctx.noteControl(output.id, channel, control.cc, raw);
        return { parameter: control.name, cc: control.cc, value: display, raw };
    };

    const handlers = {
        list_devices() {
            return outputs().flatMap(o => {
                const entry = ctx.catalog.forPort(o.name);
                const info = (unit, part) => {
                    const channel = ctx.getChannel(o.name, part);
                    return { id: o.id, name: o.name, ...(part ? { part, device: `${o.name} part ${part}` } : {}), model: entry?.map.model ?? null, channel, preset: currentProgram(unit, channel), controls: entry?.map.controls.length ?? 0, presetCatalog: Boolean(entry?.presets) };
                };
                if (MULTITIMBRAL_PARTS[entry?.model]) return ctx.getParts(o.name).map(({ part }) => info({ ...o, part }, part));
                return [info(o)];
            });
        },
        get_device_params({ device, category }) {
            const output = resolve(device);
            const { map } = catalogFor(output);
            const channel = ctx.getChannel(output.name, output.part);
            const raw = rawValues(output, channel);
            return {
                device: output.name, model: map.model, channel,
                parameters: map.controls.filter(c => !category || c.category === category).map(c => ({
                    name: c.name, cc: c.cc, type: c.type, category: c.category, min: c.min, max: c.max, unit: c.unit,
                    options: c.options, description: c.description, zones: c.zones, value: decodeControlValue(c, raw.get(c.cc)) ?? null,
                })),
            };
        },
        get_device_state({ device, channel }) {
            const output = resolve(device);
            const ch = channelFor(output, channel);
            const { map } = catalogFor(output);
            const raw = rawValues(output, ch);
            const values = {};
            for (const c of map.controls) if (raw.has(c.cc)) values[c.name] = decodeControlValue(c, raw.get(c.cc));
            return { device: output.name, channel: ch, preset: currentProgram(output, ch), values, note: 'Values are what the router last sent; front-panel changes are not visible.' };
        },
        set_parameter({ device, parameter, value, channel }) {
            const output = resolve(device);
            const ch = channelFor(output, channel);
            return { device: output.name, channel: ch, ...sendControl(output, ch, findControl(catalogFor(output).map.controls, parameter), value) };
        },
        set_parameters({ device, values, channel }) {
            const output = resolve(device);
            const ch = channelFor(output, channel);
            const { map } = catalogFor(output);
            const entries = Object.entries(values || {});
            if (!entries.length) throw new ToolError('values is empty');
            // Resolve every parameter before sending so a typo does not leave a half-applied sound.
            const planned = entries.map(([ref, value]) => [findControl(map.controls, ref), value]);
            planned.forEach(([control, value]) => encodeControlValue(control, value));
            return { device: output.name, channel: ch, applied: planned.map(([control, value]) => sendControl(output, ch, control, value)) };
        },
        list_presets({ device, query, offset = 0, limit = 50 }) {
            const output = resolve(device);
            const entry = catalogFor(output);
            if (!entry.presets) return { device: output.name, presets: [], note: 'No preset catalog; presets are numbered 1-128 by Program Change.' };
            const wanted = String(query ?? '').toLowerCase();
            const all = Object.entries(entry.presets.presets)
                .map(([number, p]) => ({ number: Number(number), name: p.name, tags: p.tags, description: p.description }))
                .filter(p => !wanted || `${p.name} ${(p.tags || []).join(' ')} ${p.description || ''}`.toLowerCase().includes(wanted));
            return { device: output.name, total: all.length, offset, presets: all.slice(offset, offset + limit) };
        },
        async select_preset({ device, preset, channel }) {
            const output = resolve(device);
            const ch = channelFor(output, channel);
            const entry = ctx.catalog.forPort(output.name);
            let number = preset;
            if (typeof preset === 'string' && !/^\d+$/.test(preset.trim())) {
                const wanted = preset.trim().toLowerCase();
                const matches = Object.entries(entry?.presets?.presets || {}).filter(([, p]) => p.name.toLowerCase() === wanted);
                if (matches.length !== 1) throw new ToolError(matches.length ? `preset name "${preset}" is not unique; use its number` : `unknown preset "${preset}" (use list_presets)`);
                number = Number(matches[0][0]);
            }
            number = Number(number);
            const limit = entry?.map.presetName?.programs ?? 128;
            if (!Number.isInteger(number) || number < 1 || number > limit) throw new ToolError(`preset must be 1-${limit}`);
            const index = number - 1;
            ctx.selectPreset(output.id, ch, index);
            const reported = await ctx.waitPresetName(output.id, ch, index, 1500);
            return { device: output.name, channel: ch, preset: number, name: reported ?? presetCatalogName(output, index), nameSource: reported ? 'device' : (presetCatalogName(output, index) ? 'catalog' : 'none') };
        },
        send_cc({ device, cc, value, channel }) {
            const output = resolve(device);
            const ch = channelFor(output, channel);
            if (!Number.isInteger(cc) || cc < 1 || cc > 119 || cc === 32) throw new ToolError('cc must be 1-119 (not 32)');
            if (!Number.isInteger(value) || value < 0 || value > 127) throw new ToolError('value must be 0-127');
            ctx.sendMidi(output.id, [0xB0 | (ch - 1), cc, value]);
            if (cc !== 0) ctx.noteControl(output.id, ch, cc, value);
            return { device: output.name, channel: ch, cc, value };
        },
        set_device_channel({ device, channel }) {
            const output = resolve(device);
            if (!validMidiChannel(channel) || !ctx.setChannel(output.name, channel, output.part)) throw new ToolError('channel must be 1-16');
            return { device: output.name, channel };
        },
        panic() { ctx.panic(); return { ok: true }; },
        daw_get_state() { return ctx.getDawState(); },
        daw_set_tempo({ bpm }) {
            if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) throw new ToolError('bpm must be 20-300');
            ctx.daw({ type: 'daw_set_tempo', bpm }); return { ok: true, bpm };
        },
        daw_set_record_mode({ mode }) {
            if (!['none', 'replace', 'overdub'].includes(mode)) throw new ToolError('mode must be none, replace or overdub');
            ctx.daw({ type: 'daw_set_record_mode', mode }); return { ok: true, mode };
        },
        daw_transport({ action }) {
            if (!['play', 'stop'].includes(action)) throw new ToolError('action must be play or stop');
            ctx.daw({ type: action === 'play' ? 'daw_start_transport' : 'daw_stop_transport' }); return { ok: true, action };
        },
        daw_trigger_pad({ track, slot }) {
            if (!Number.isInteger(track) || track < 0 || track > 7 || !Number.isInteger(slot) || slot < 0 || slot > 15) throw new ToolError('track 0-7, slot 0-15');
            ctx.daw({ type: 'daw_pad_trigger', trackIdx: track, slot }); return { ok: true, track, slot };
        },
        daw_sessions({ action, name }) {
            if (action === 'list') return ctx.listSessions();
            if (typeof name !== 'string' || !/^[\w .-]{1,64}$/.test(name)) throw new ToolError('name is required (letters, digits, space, . _ -)');
            const types = { save: 'daw_save_session', load: 'daw_load_session', delete: 'daw_delete_session' };
            if (!types[action]) throw new ToolError('action must be list, save, load or delete');
            ctx.daw({ type: types[action], name }); return { ok: true, action, name };
        },
        daw_reset() { ctx.daw({ type: 'daw_reset_arm_record' }); return { ok: true }; },
        daw_set_layout({ tracks, slots }) {
            if (tracks === undefined && slots === undefined) throw new ToolError('give tracks and/or slots');
            for (const [key, v, max] of [['tracks', tracks, 16], ['slots', slots, 16]]) {
                if (v !== undefined && (!Number.isInteger(v) || v < 1 || v > max)) throw new ToolError(`${key} must be 1-${max}`);
            }
            ctx.daw({ type: 'daw_set_layout', tracks, slots }); return { ok: true, tracks, slots };
        },
        daw_set_clip({ track, slot, device, channel, bars, notes }) {
            const state = ctx.getDawState();
            const clips = state?.tracks?.[track]?.clips;
            if (!clips) throw new ToolError(`no track ${track} (see daw_get_state / daw_set_layout)`);
            if (!clips[slot]) throw new ToolError(`track ${track} has no slot ${slot} (it has ${clips.length})`);
            if (!Array.isArray(notes) || notes.length > 1024) throw new ToolError('notes must hold 0-1024 entries');
            let ch = channel;
            if (device !== undefined) ch = channelFor(resolve(device), channel);
            if (!validMidiChannel(ch)) throw new ToolError('give device or channel (1-16)');
            if (bars !== undefined && (!Number.isInteger(bars) || bars < 1 || bars > 64)) throw new ToolError('bars must be 1-64');
            const clean = notes.map(n => {
                const velocity = n?.velocity === undefined ? 100 : n.velocity;
                if (!Number.isInteger(n?.note) || n.note < 0 || n.note > 127 || !(n.start >= 0) || !(n.duration > 0) || !Number.isInteger(velocity) || velocity < 1 || velocity > 127) {
                    throw new ToolError('each note needs note 0-127, start >= 0, duration > 0 and velocity 1-127');
                }
                return { note: n.note, start: n.start, dur: n.duration, velocity };
            });
            ctx.daw({ type: 'daw_set_clip', trackIdx: track, slot, channel: ch, bars, notes: clean });
            return { ok: true, track, slot, channel: ch, notes: clean.length };
        },
        daw_clear_clip({ track, slot }) {
            if (!Number.isInteger(track) || track < 0 || track > 15 || !Number.isInteger(slot) || slot < 0 || slot > 15) throw new ToolError('track 0-15, slot 0-15');
            ctx.daw({ type: 'daw_clear_clip', trackIdx: track, slot }); return { ok: true, track, slot };
        },
        daw_stop_clip({ track }) {
            if (!Number.isInteger(track) || track < 0 || track > 15) throw new ToolError('track 0-15');
            ctx.daw({ type: 'daw_stop_clip', trackIdx: track }); return { ok: true, track };
        },
        daw_track({ action, track }) {
            const types = { add_track: 'daw_add_track', remove_track: 'daw_remove_track', add_clip: 'daw_add_clip', arm: 'daw_arm_track', mute: 'daw_mute_track', solo: 'daw_solo_track' };
            if (!types[action]) throw new ToolError(`action must be one of ${Object.keys(types).join(', ')}`);
            if (action !== 'add_track' && (!Number.isInteger(track) || track < 0 || track > 15)) throw new ToolError('track 0-15 is required');
            ctx.daw({ type: types[action], trackIdx: track }); return { ok: true, action, track };
        },
        daw_set_loop_bars({ bars }) {
            if (!Number.isInteger(bars) || bars < 1 || bars > 64) throw new ToolError('bars must be 1-64');
            ctx.daw({ type: 'daw_set_master_loop_bars', bars }); return { ok: true, bars };
        },
        daw_set_clock({ source, port, output }) {
            if (source === undefined && output === undefined) throw new ToolError('give source and/or output');
            if (source !== undefined) {
                if (!['internal', 'external'].includes(source)) throw new ToolError('source must be internal or external');
                if (source === 'external' && typeof port !== 'string') throw new ToolError('external source needs port (an input name)');
                ctx.daw({ type: 'clock_source_select', kind: source, portName: port });
            }
            if (output !== undefined) ctx.daw({ type: output ? 'daw_midi_clock_on' : 'daw_midi_clock_off' });
            return { ok: true, source, port, output };
        },
        daw_set_metronome({ enabled, beats_per_measure: beats }) {
            if (enabled === undefined && beats === undefined) throw new ToolError('give enabled and/or beats_per_measure');
            if (enabled !== undefined) ctx.daw({ type: enabled ? 'daw_metronome_on' : 'daw_metronome_off' });
            if (beats !== undefined) {
                if (!Number.isInteger(beats) || beats < 1 || beats > 16) throw new ToolError('beats_per_measure must be 1-16');
                ctx.daw({ type: 'daw_metronome_beats_per_measure', bpm: beats });
            }
            return { ok: true, enabled, beats_per_measure: beats };
        },
        daw_set_quantize({ beats }) {
            if (![0, 0.125, 0.25, 0.5, 1, 2].includes(beats)) throw new ToolError('beats must be 0, 0.125, 0.25, 0.5, 1 or 2');
            ctx.daw({ type: 'daw_quantize_grid', beats }); return { ok: true, beats };
        },
        set_device_part({ device, part, channel, remove }) {
            const output = resolveOutput(outputs(), device);
            if (!MULTITIMBRAL_PARTS[ctx.catalog.forPort(output.name)?.model]) throw new ToolError(`"${output.name}" is not multitimbral`);
            if (!ctx.setPart(output.name, part, remove ? undefined : channel, !!remove)) throw new ToolError('part must be 1-16' + (remove ? '' : ' and channel 1-16 is required'));
            return { device: output.name, part, channel: remove ? null : channel, removed: !!remove, parts: ctx.getParts(output.name) };
        },
        play_notes({ device, channel, bpm = 120, notes }) {
            const output = resolve(device);
            const ch = channelFor(output, channel);
            if (!Array.isArray(notes) || !notes.length || notes.length > MAX_NOTES) throw new ToolError(`notes must hold 1-${MAX_NOTES} entries`);
            if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) throw new ToolError('bpm must be 20-300');
            const seconds = 60 / bpm;
            let end = 0;
            const events = [];
            for (const n of notes) {
                if (!Number.isInteger(n?.note) || n.note < 0 || n.note > 127 || !(n.start >= 0) || !(n.duration > 0)) throw new ToolError('each note needs note 0-127, start >= 0 and duration > 0');
                const velocity = n.velocity === undefined ? 100 : n.velocity;
                if (!Number.isInteger(velocity) || velocity < 1 || velocity > 127) throw new ToolError('velocity must be 1-127');
                events.push([n.start * seconds, [0x90 | (ch - 1), n.note, velocity]], [(n.start + n.duration) * seconds, [0x80 | (ch - 1), n.note, 0]]);
                end = Math.max(end, (n.start + n.duration) * seconds);
            }
            if (end > MAX_PLAY_SECONDS) throw new ToolError(`melody longer than ${MAX_PLAY_SECONDS}s`);
            // Note-offs sort before note-ons at equal times so repeated notes retrigger cleanly.
            events.sort((a, b) => a[0] - b[0] || (a[1][0] & 0xF0) - (b[1][0] & 0xF0));
            for (const [at, bytes] of events) ctx.later(at * 1000, () => ctx.sendPerformance([output.id], bytes));
            return { device: output.name, channel: ch, notes: notes.length, seconds: Math.round(end * 100) / 100 };
        },
    };

    async function callTool(name, args) {
        const handler = handlers[name];
        if (!handler && ctx.upstream?.has(name)) return ctx.upstream.callTool(name, args);
        if (!handler) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
        try {
            const result = await handler(args || {});
            return { content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }] };
        } catch (error) {
            return { isError: true, content: [{ type: 'text', text: error.message }] };
        }
    }

    async function handleMessage(message) {
        if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
            return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
        }
        if (message.id === undefined) return null;   // notification
        const reply = result => ({ jsonrpc: '2.0', id: message.id, result });
        switch (message.method) {
            case 'initialize': {
                const requested = message.params?.protocolVersion;
                return reply({
                    protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: SERVER_INFO,
                    instructions: 'Control MIDI instruments connected to the midirouter: list_devices, then get_device_params / list_presets to choose sounds, select_preset and set_parameter(s) to apply them. DAW tools record and play clips. All MIDI goes through the router.',
                });
            }
            case 'ping': return reply({});
            case 'tools/list': {
                const own = new Set(TOOLS.map(t => t.name));
                const forwarded = ctx.upstream ? (await ctx.upstream.listTools()).filter(t => !own.has(t.name)) : [];
                return reply({ tools: [...TOOLS, ...forwarded] });
            }
            case 'tools/call': return reply(await callTool(message.params?.name, message.params?.arguments));
            default: return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
        }
    }

    // Returns { status, body } for a parsed or raw JSON-RPC POST body.
    async function handlePost(raw) {
        let payload;
        try { payload = typeof raw === 'string' ? JSON.parse(raw) : raw; }
        catch { return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } }; }
        if (Array.isArray(payload)) {
            const replies = (await Promise.all(payload.map(handleMessage))).filter(Boolean);
            return replies.length ? { status: 200, body: replies } : { status: 202 };
        }
        const reply = await handleMessage(payload);
        return reply ? { status: 200, body: reply } : { status: 202 };
    }

    return { handlePost, callTool };
}
