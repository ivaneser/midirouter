import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

export const FILTER_CHOICES = ['off', 'light', 'strong'];
// How the audio travels to listeners: raw PCM (about 1.5 Mbit/s each) or Opus at a bitrate.
export const QUALITY_CHOICES = ['pcm', 'opus-128', 'opus-96', 'opus-64', 'opus-32'];

// The noise filter and the stream quality of the incoming audio, kept across restarts (audio-settings.json).
// `fallback` is the filter used until it has been chosen in the UI (MIDIROUTER_AUDIO_FILTER, else light).
export class AudioSettings {
    constructor(path, fallback = 'light') {
        this.path = path;
        this.filter = FILTER_CHOICES.includes(fallback) ? fallback : 'light';
        this.quality = 'opus-96';
        try {
            if (existsSync(path)) {
                const saved = JSON.parse(readFileSync(path, 'utf8'));
                if (FILTER_CHOICES.includes(saved.filter)) this.filter = saved.filter;
                if (QUALITY_CHOICES.includes(saved.quality)) this.quality = saved.quality;
            }
        } catch (error) {
            console.error('[SERVER] Could not load audio settings:', error.message);
        }
    }

    _save() {
        writeFileSync(`${this.path}.tmp`, JSON.stringify({ filter: this.filter, quality: this.quality }, null, 2));
        renameSync(`${this.path}.tmp`, this.path);
    }

    // Returns the new level, or null for one that does not exist.
    setFilter(level) {
        if (!FILTER_CHOICES.includes(level)) return null;
        this.filter = level;
        this._save();
        return level;
    }

    // Returns the new quality, or null for one that does not exist.
    setQuality(quality) {
        if (!QUALITY_CHOICES.includes(quality)) return null;
        this.quality = quality;
        this._save();
        return quality;
    }
}
