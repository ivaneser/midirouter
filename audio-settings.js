import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

export const FILTER_CHOICES = ['off', 'light', 'strong'];

// The noise filter of the incoming audio, kept across restarts (audio-settings.json). `fallback` is used until
// the level has been chosen in the UI (MIDIROUTER_AUDIO_FILTER, else light).
export class AudioSettings {
    constructor(path, fallback = 'light') {
        this.path = path;
        this.filter = FILTER_CHOICES.includes(fallback) ? fallback : 'light';
        try {
            if (existsSync(path)) {
                const saved = JSON.parse(readFileSync(path, 'utf8')).filter;
                if (FILTER_CHOICES.includes(saved)) this.filter = saved;
            }
        } catch (error) {
            console.error('[SERVER] Could not load audio settings:', error.message);
        }
    }

    // Returns the new level, or null for one that does not exist.
    setFilter(level) {
        if (!FILTER_CHOICES.includes(level)) return null;
        writeFileSync(`${this.path}.tmp`, JSON.stringify({ filter: level }, null, 2));
        renameSync(`${this.path}.tmp`, this.path);
        this.filter = level;
        return level;
    }
}
