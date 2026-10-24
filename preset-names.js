import { readFileSync, readdirSync } from 'node:fs';
import { deviceChannelKey } from './frontend/js/device-channels.js';

// Read-only SysEx adapters. No patch upload or arbitrary command discovery.
export class PresetNames {
    constructor(directory) {
        this.profiles = [];
        this.pending = new Map();
        this.sequence = 0;
        for (const file of readdirSync(directory).filter(f => f.endsWith('.json'))) {
            const profile = JSON.parse(readFileSync(`${directory}/${file}`, 'utf8')).presetName;
            if (profile) this.profiles.push(profile);
        }
    }

    request(target, channel, program) {
        const profile = this.profiles.find(p => p.match.some(name => target.toLowerCase().includes(name.toLowerCase())));
        if (!profile) return null;
        const sequence = this.sequence++ % 128;
        const values = { program, channel: channel - 1, sequence };
        const bytes = profile.request.map(b => typeof b === 'string' ? values[b] : b);
        if (bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255)) return null;
        console.log(`[PRESET] request ${target} ch${channel} program ${program} seq ${sequence}: ${bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
        this.pending.set(deviceChannelKey(target), { target, channel, program, sequence, profile, expires: Date.now() + 2000 });
        return bytes;
    }

    receive(source, bytes) {
        const pending = this.pending.get(deviceChannelKey(source));
        if (!pending || pending.expires < Date.now()) return null;
        const reply = pending.profile.reply;
        const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
        const reason = bytes.at(-1) !== 0xf7 ? 'no F7 terminator'
            : !reply.prefix.every((b, i) => b === null || b === bytes[i]) ? 'prefix mismatch'
            : bytes.length < reply.nameOffset + reply.nameLength + 1 ? 'too short'
            : reply.sequenceOffset != null && bytes[reply.sequenceOffset] !== pending.sequence ? `sequence ${bytes[reply.sequenceOffset]} != ${pending.sequence}`
            : reply.programOffset != null && bytes[reply.programOffset] !== pending.program ? `program ${bytes[reply.programOffset]} != ${pending.program}`
            : null;
        console.log(`[PRESET] reply from ${source} (${bytes.length} bytes) ${reason ? 'REJECTED: ' + reason : 'ok'}: ${hex}`);
        if (bytes.at(-1) !== 0xf7 || !reply.prefix.every((b, i) => b === null || b === bytes[i]) ||
            bytes.length < reply.nameOffset + reply.nameLength + 1 ||
            (reply.sequenceOffset != null && bytes[reply.sequenceOffset] !== pending.sequence) ||
            (reply.programOffset != null && bytes[reply.programOffset] !== pending.program)) return null;
        const name = String.fromCharCode(...bytes.slice(reply.nameOffset, reply.nameOffset + reply.nameLength))
            .split('\0')[0].replace(/[^\x20-\x7e]/g, '').trim();
        if (!name) return null;
        this.pending.delete(deviceChannelKey(source));
        return { target: pending.target, channel: pending.channel, program: pending.program, name };
    }
}
