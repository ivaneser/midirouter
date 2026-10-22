import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { deviceChannelKey, validMidiChannel } from './frontend/js/device-channels.js';

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
        const next = { ...this.channels, [deviceChannelKey(name)]: channel };
        // Replace only after the complete file has been written successfully.
        writeFileSync(`${this.path}.tmp`, JSON.stringify(next, null, 2));
        renameSync(`${this.path}.tmp`, this.path);
        this.channels = next;
        return true;
    }
}
