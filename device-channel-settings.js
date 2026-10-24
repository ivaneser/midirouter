import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { deviceChannelKey, validMidiChannel } from './frontend/js/device-channels.js';

const validPart = part => Number.isInteger(part) && part >= 1 && part <= 16;

export class DeviceChannelSettings {
    constructor(path) {
        this.path = path;
        this.channels = Object.create(null);
        try {
            if (!existsSync(path)) return;
            const saved = JSON.parse(readFileSync(path, 'utf8'));
            for (const [key, channel] of Object.entries(saved)) {
                if (validMidiChannel(channel)) this.channels[key] = channel;
            }
        } catch (error) {
            console.error('[SERVER] Could not load device channels:', error.message);
        }
    }

    set(name, channel) {
        if (!name || !validMidiChannel(channel)) return false;
        return this._save({ ...this.channels, [deviceChannelKey(name)]: channel });
    }

    // Parts of a multitimbral instrument are stored as "<device key>#<part>"; a part exists
    // while it has a channel.
    setPart(name, part, channel) {
        if (!name || !validPart(part) || !validMidiChannel(channel)) return false;
        return this._save({ ...this.channels, [`${deviceChannelKey(name)}#${part}`]: channel });
    }

    removePart(name, part) {
        if (!name || !validPart(part)) return false;
        const { [`${deviceChannelKey(name)}#${part}`]: _removed, ...next } = this.channels;
        return this._save(next);
    }

    _save(next) {
        // Replace only after the complete file has been written successfully.
        writeFileSync(`${this.path}.tmp`, JSON.stringify(next, null, 2));
        renameSync(`${this.path}.tmp`, this.path);
        this.channels = next;
        return true;
    }
}
