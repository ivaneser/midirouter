import fs from 'node:fs';
import path from 'node:path';

const ACTIONS = new Set(['play', 'stop', 'record', 'loop']);
const VARIABLES = new Set(['$number', '$index', '$track', '$slot']);
const INPUT_MESSAGES = new Set(['note', 'cc', 'program', 'sysex']);

function matches(name, matcher) {
    if (!matcher) return false;
    if (matcher.exact) return name.toLowerCase() === matcher.exact.toLowerCase();
    return Array.isArray(matcher.containsAll) && matcher.containsAll.length > 0
        && matcher.containsAll.every(token => name.toLowerCase().includes(token.toLowerCase()));
}

function validMatcher(matcher) {
    return !!matcher && (typeof matcher.exact === 'string' && matcher.exact.length > 0
        || Array.isArray(matcher.containsAll) && matcher.containsAll.length > 0
            && matcher.containsAll.every(token => typeof token === 'string' && token.length > 0));
}

function validByte(value) {
    return Number.isInteger(value) && value >= 0 && value <= 255;
}

function validateTemplate(template, label) {
    if (!Array.isArray(template) || !template.length
        || template.some(value => !validByte(value) && !VARIABLES.has(value))) {
        throw new Error(`${label}: expected MIDI bytes or $number/$index/$track/$slot`);
    }
}

function expandPadGroups(groups, id) {
    const pads = [];
    for (const group of groups || []) {
        if (!INPUT_MESSAGES.has(group.message) || !validInputAddress(group)
            || !Array.isArray(group.numbers)
            || !group.numbers.length || !Number.isInteger(group.trackStart)
            || !Number.isInteger(group.slot) || group.trackStart < 0 || group.trackStart + group.numbers.length > 16
            || group.slot < 0 || group.slot > 15 || group.numbers.some(n => !Number.isInteger(n) || n < 0 || n > 127)
            || group.ledNumbers && (group.ledNumbers.length !== group.numbers.length
                || group.ledNumbers.some(n => !Number.isInteger(n) || n < 0 || n > 127))
            || group.indexStart != null && (!Number.isInteger(group.indexStart) || group.indexStart < 0 || group.indexStart + group.numbers.length > 128)) {
            throw new Error(`${id}: invalid pad group`);
        }
        group.numbers.forEach((number, index) => pads.push({
            message: group.message, channel: group.channel, number,
            trackIdx: group.trackStart + index, slot: group.slot,
            ledNumber: group.ledNumbers?.[index] ?? number,
            index: group.indexStart == null ? index : group.indexStart + index,
            prefix: group.prefix, numberByte: group.numberByte, valueByte: group.valueByte,
        }));
    }
    return pads;
}

function validInputAddress(control) {
    if (control.message === 'sysex') {
        return Array.isArray(control.prefix) && control.prefix.length > 0
            && control.prefix[0] === 0xf0 && control.prefix.every(validByte)
            && Number.isInteger(control.numberByte) && control.numberByte >= control.prefix.length
            && Number.isInteger(control.valueByte) && control.valueByte >= control.prefix.length;
    }
    return Number.isInteger(control.channel) && control.channel >= 1 && control.channel <= 16;
}

function compileProfile(profile) {
    if (!profile || typeof profile.id !== 'string' || !profile.id || !validMatcher(profile.input)) {
        throw new Error('controller profile requires id and input matcher');
    }
    if (profile.passthrough && !['none', 'cc', 'all'].includes(profile.passthrough)) {
        throw new Error(`${profile.id}: passthrough must be none, cc, or all`);
    }
    if (profile.excludeOutputs?.some(matcher => !validMatcher(matcher))) {
        throw new Error(`${profile.id}: invalid excluded output matcher`);
    }
    if (profile.midiClockOutput && !validMatcher(profile.midiClockOutput)) {
        throw new Error(`${profile.id}: invalid MIDI clock output matcher`);
    }
    const pads = expandPadGroups(profile.pads, profile.id);
    const padAddresses = new Set();
    for (const pad of pads) {
        const address = `${pad.message}:${pad.channel || pad.prefix?.join(',')}:${pad.number}`;
        if (padAddresses.has(address)) throw new Error(`${profile.id}: duplicate pad input ${address}`);
        padAddresses.add(address);
    }
    for (const control of profile.transport || []) {
        if (!INPUT_MESSAGES.has(control.message) || !ACTIONS.has(control.action)
            || !validInputAddress(control)
            || !Number.isInteger(control.number) || control.number < 0 || control.number > 127) {
            throw new Error(`${profile.id}: invalid transport control`);
        }
    }
    for (const bytes of profile.feedback?.init || []) {
        if (!Array.isArray(bytes) || !bytes.length || bytes.some(value => !validByte(value))) {
            throw new Error(`${profile.id}: init expects literal MIDI bytes`);
        }
    }
    for (const [state, bytes] of Object.entries(profile.feedback?.states || {})) {
        if (!['playing', 'recording', 'off'].includes(state)) throw new Error(`${profile.id}: unknown LED state ${state}`);
        validateTemplate(bytes, `${profile.id} ${state}`);
    }
    if (profile.feedback?.states && !profile.feedback.states.off) {
        throw new Error(`${profile.id}: feedback states require off`);
    }
    if (profile.feedback && !validMatcher(profile.feedback.output)) {
        throw new Error(`${profile.id}: feedback requires output matcher`);
    }
    return { ...profile, pads };
}

function midiEvent(bytes) {
    if (!bytes || bytes.length < 2) return null;
    const status = bytes[0];
    const kind = status & 0xf0;
    if (kind === 0xc0) return {
        message: 'program', channel: (status & 0x0f) + 1,
        number: bytes[1], pressed: true,
    };
    if (bytes.length < 3 || kind !== 0x80 && kind !== 0x90 && kind !== 0xb0) return null;
    return {
        message: kind === 0xb0 ? 'cc' : 'note',
        channel: (status & 0x0f) + 1,
        number: bytes[1],
        pressed: kind !== 0x80 && bytes[2] > 0,
    };
}

function inputMatches(control, bytes, event) {
    if (control.message === 'sysex') {
        return bytes.length > Math.max(control.numberByte, control.valueByte)
            && control.prefix.every((byte, index) => bytes[index] === byte)
            && bytes[control.numberByte] === control.number;
    }
    return event?.message === control.message && event.channel === control.channel
        && event.number === control.number;
}

function inputPressed(control, bytes, event) {
    return control.message === 'sysex' ? bytes[control.valueByte] > 0 : event.pressed;
}

function render(template, pad) {
    const values = { '$number': pad.ledNumber, '$index': pad.index, '$track': pad.trackIdx, '$slot': pad.slot };
    return template.map(value => typeof value === 'string' ? values[value] : value);
}

export class ControllerEngine {
    constructor(profiles = []) {
        const ids = new Set();
        this.profiles = profiles.map(compileProfile);
        for (const profile of this.profiles) {
            if (ids.has(profile.id)) throw new Error(`duplicate controller id ${profile.id}`);
            ids.add(profile.id);
        }
    }

    static fromDirectory(directory) {
        if (!fs.existsSync(directory)) return new ControllerEngine();
        const profiles = [];
        const ids = new Set();
        for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
            try {
                const profile = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
                compileProfile(profile);
                if (ids.has(profile.id)) throw new Error(`duplicate id ${profile.id}`);
                ids.add(profile.id);
                profiles.push(profile);
            } catch (error) {
                console.warn(`[CONTROLLER] Cannot load ${file}: ${error.message}`);
            }
        }
        return new ControllerEngine(profiles);
    }

    profileForInput(name) {
        return this.profiles.find(profile => matches(name, profile.input)) || null;
    }

    inputEvent(name, bytes) {
        const profile = this.profileForInput(name);
        if (!profile) return null;
        const event = midiEvent(bytes);
        const pad = profile.pads.find(p => inputMatches(p, bytes, event));
        if (pad) return { kind: 'pad', profile, pad, pressed: inputPressed(pad, bytes, event), consume: true };
        const transport = (profile.transport || []).find(control => inputMatches(control, bytes, event));
        if (transport) return { kind: 'transport', profile, action: transport.action,
            pressed: inputPressed(transport, bytes, event), consume: true };
        const policy = profile.passthrough || 'none';
        return { kind: 'other', profile, consume: policy !== 'all' && !(policy === 'cc' && event?.message === 'cc') };
    }

    isExcludedOutput(name) {
        return this.profiles.some(profile => matches(name, profile.feedback?.output)
            || (profile.excludeOutputs || []).some(matcher => matches(name, matcher)));
    }

    isMidiClockOutput(name) {
        return this.profiles.some(profile => matches(name, profile.midiClockOutput));
    }

    initMessagesFor(name) {
        return this.profiles.filter(profile => matches(name, profile.feedback?.output))
            .flatMap(profile => profile.feedback.init || []);
    }

    feedbackMessagesFor(name, trackIdx, slot, state) {
        const result = [];
        for (const profile of this.profiles) {
            if (!matches(name, profile.feedback?.output)) continue;
            const template = profile.feedback.states?.[state];
            if (!template) continue;
            for (const pad of profile.pads) {
                if (pad.trackIdx === trackIdx && pad.slot === slot) result.push(render(template, pad));
            }
        }
        return result;
    }

    padMappings() {
        return this.profiles.flatMap(profile => profile.pads.map(pad => ({
            profileId: profile.id, message: pad.message, channel: pad.channel,
            note: pad.number, trackIdx: pad.trackIdx, slot: pad.slot,
        })));
    }
}
