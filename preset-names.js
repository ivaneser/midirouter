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
            if (profile) this.profiles.push({ ...profile, file: file.replace(/\.json$/, '') });
        }
    }

    // `program` is the full preset index: bank * 128 + Program Change number.
    request(target, channel, program) {
        const profile = this.profiles.find(p => p.match.some(name => target.toLowerCase().includes(name.toLowerCase())));
        if (!profile) return null;
        const sequence = this.sequence++ % 128;
        const values = { program: program & 127, bank: program >> 7, channel: channel - 1, sequence };
        // Some synths (Craft Synth) cannot be asked: they announce the name by themselves when the preset
        // changes, so there is nothing to send, only a reply to wait for.
        const bytes = profile.request ? profile.request.map(b => typeof b === 'string' ? values[b] : b) : null;
        if (bytes && bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255)) return null;
        console.log(`[PRESET] ${bytes ? `request ${target} ch${channel} program ${program} seq ${sequence}: ${bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')}` : `waiting for ${target} ch${channel} program ${program} to announce its name`}`);
        this.pending.set(deviceChannelKey(target), { target, channel, program, sequence, profile, expires: Date.now() + 2000 });
        return bytes;
    }

    // Preset count and bank-select CC for a port, or null when it only has 128 presets.
    bankInfo(target) {
        const profile = this.profiles.find(p => p.match.some(name => target.toLowerCase().includes(name.toLowerCase())));
        return profile?.programs > 128 ? { programs: profile.programs, cc: profile.bankSelectCc ?? 0 } : null;
    }

    // Anything a device sends that carries a preset's name or sound, whether or not we asked for it (the
    // synth's own buttons, a dump request from elsewhere): { file, program, name?, dump? } or null.
    // `file` is the device map the profile belongs to; `program` is the full index (bank * 128 + program).
    learn(source, bytes) {
        if (bytes[0] !== 0xf0 || bytes.at(-1) !== 0xf7) return null;
        const profile = this.profiles.find(p => p.match.some(name => source.toLowerCase().includes(name.toLowerCase())));
        if (!profile) return null;
        const matches = (format, minimum = 0) => format && bytes.length >= minimum && format.prefix.every((b, i) => b === null || b === bytes[i]);
        const programOf = format => format.programOffset == null || bytes[format.programOffset] == null ? null
            : (format.bankOffset != null ? bytes[format.bankOffset] << 7 : 0) + bytes[format.programOffset];
        const reply = profile.reply;
        const out = { file: profile.file };
        if (matches(reply, reply.nameOffset + 2)) {
            const program = programOf(reply);
            const name = this._nameOf(reply, bytes);
            if (program != null && name) {
                out.program = program;
                out.name = name;
                if (!profile.dump) out.dump = bytes.slice();   // the same message is the whole sound
            }
        }
        if (matches(profile.dump, (profile.dump?.programOffset ?? 0) + 2)) {
            const program = programOf(profile.dump);
            if (program != null) { out.program = program; out.dump = bytes.slice(); }
        }
        return out.program == null ? null : out;
    }

    _nameOf(reply, bytes) {
        const length = reply.nameLength ?? Math.max(0, bytes.length - 1 - reply.nameOffset);
        return String.fromCharCode(...bytes.slice(reply.nameOffset, reply.nameOffset + length))
            .split('\0')[0].replace(/[^\x20-\x7e]/g, '').trim();
    }

    receive(source, bytes) {
        const pending = this.pending.get(deviceChannelKey(source));
        if (!pending || pending.expires < Date.now()) return null;
        const reply = pending.profile.reply;
        // nameLength null: the name runs up to the F7.
        const nameLength = reply.nameLength ?? Math.max(0, bytes.length - 1 - reply.nameOffset);
        const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
        const reason = bytes.at(-1) !== 0xf7 ? 'no F7 terminator'
            : !reply.prefix.every((b, i) => b === null || b === bytes[i]) ? 'prefix mismatch'
            : bytes.length < reply.nameOffset + Math.max(1, nameLength) + 1 ? 'too short'
            : reply.sequenceOffset != null && bytes[reply.sequenceOffset] !== pending.sequence ? `sequence ${bytes[reply.sequenceOffset]} != ${pending.sequence}`
            : reply.bankOffset != null && bytes[reply.bankOffset] !== pending.program >> 7 ? `bank ${bytes[reply.bankOffset]} != ${pending.program >> 7}`
            : reply.programOffset != null && bytes[reply.programOffset] !== (pending.program & 127) ? `program ${bytes[reply.programOffset]} != ${pending.program & 127}`
            : null;
        console.log(`[PRESET] reply from ${source} (${bytes.length} bytes) ${reason ? 'REJECTED: ' + reason : 'ok'}: ${hex}`);
        if (bytes.at(-1) !== 0xf7 || !reply.prefix.every((b, i) => b === null || b === bytes[i]) ||
            bytes.length < reply.nameOffset + Math.max(1, nameLength) + 1 ||
            (reply.sequenceOffset != null && bytes[reply.sequenceOffset] !== pending.sequence) ||
            (reply.bankOffset != null && bytes[reply.bankOffset] !== pending.program >> 7) ||
            (reply.programOffset != null && bytes[reply.programOffset] !== (pending.program & 127))) return null;
        const name = String.fromCharCode(...bytes.slice(reply.nameOffset, reply.nameOffset + nameLength))
            .split('\0')[0].replace(/[^\x20-\x7e]/g, '').trim();
        if (!name) return null;
        this.pending.delete(deviceChannelKey(source));
        return { target: pending.target, channel: pending.channel, program: pending.program, name };
    }
}
