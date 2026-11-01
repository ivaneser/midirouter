import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Presets the user saves for instruments that have none of their own (the NTS-1): a name, a sound group and
// the CC values that were set, kept per device map in `<directory>/<file>.json` as
// { presets: { "<id>": { name, group, controls: [{ cc, value }] } } }. Loading one sends its CCs.
export class UserPresetStore {
    constructor(directory) {
        this.directory = directory;
        this.files = new Map();
    }

    static validFile(file) { return typeof file === 'string' && /^[\w-]+$/.test(file); }

    _load(file) {
        if (!this.files.has(file)) {
            let presets = {};
            try { presets = JSON.parse(readFileSync(join(this.directory, `${file}.json`), 'utf8')).presets ?? {}; } catch { /* none saved yet */ }
            this.files.set(file, presets);
        }
        return this.files.get(file);
    }

    list(file) {
        return UserPresetStore.validFile(file) ? { ...this._load(file) } : {};
    }

    get(file, id) {
        return UserPresetStore.validFile(file) ? this._load(file)[id] ?? null : null;
    }

    // Saves `controls` ([{ cc, value }]) under `name`; a preset of the same name (any case) is overwritten.
    // Returns the id, or null when the input is not usable.
    save(file, { name, group, controls }) {
        const cleanName = typeof name === 'string' ? name.trim().slice(0, 48) : '';
        const cleanControls = (Array.isArray(controls) ? controls : [])
            .filter(c => Number.isInteger(c?.cc) && c.cc > 0 && c.cc < 120 && Number.isInteger(c.value) && c.value >= 0 && c.value <= 127)
            .map(({ cc, value }) => ({ cc, value }));
        if (!UserPresetStore.validFile(file) || !cleanName || !cleanControls.length) return null;
        const presets = this._load(file);
        const existing = Object.keys(presets).find(id => presets[id].name.toLowerCase() === cleanName.toLowerCase());
        const id = existing ?? String(Math.max(0, ...Object.keys(presets).map(Number)) + 1);
        presets[id] = { name: cleanName, group: (typeof group === 'string' && group.trim().slice(0, 32)) || 'Misc', controls: cleanControls };
        this._write(file);
        return id;
    }

    remove(file, id) {
        if (!UserPresetStore.validFile(file) || !(id in this._load(file))) return false;
        delete this._load(file)[id];
        this._write(file);
        return true;
    }

    _write(file) {
        mkdirSync(this.directory, { recursive: true });
        const target = join(this.directory, `${file}.json`);
        writeFileSync(`${target}.tmp`, JSON.stringify({ presets: this._load(file) }, null, 1));
        renameSync(`${target}.tmp`, target);
    }
}
