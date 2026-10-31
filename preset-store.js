import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Preset names and sounds learned from the devices, kept per device map in `<directory>/<file>.json` (names:
// { presets: { "<number>": { name } } }, number = full index + 1, the same as the shipped catalogs) and
// `<file>.dumps.json` (the raw SysEx of the sound, as hex). A newly learned name replaces the stored one.
export class PresetStore {
    constructor(directory, delayMs = 300) {
        this.directory = directory;
        this.delayMs = delayMs;
        this.files = new Map();
        this.timer = null;
    }

    _load(file) {
        if (!this.files.has(file)) {
            const read = suffix => { try { return JSON.parse(readFileSync(join(this.directory, `${file}${suffix}.json`), 'utf8')); } catch { return null; } };
            this.files.set(file, { names: read('')?.presets ?? {}, dumps: read('.dumps') ?? {}, dirty: false });
        }
        return this.files.get(file);
    }

    // Returns true when the stored name or sound changed.
    learn({ file, program, name, dump }) {
        if (typeof file !== 'string' || !/^[\w-]+$/.test(file) || !Number.isInteger(program) || program < 0 || program > 1023) return false;
        const entry = this._load(file);
        const key = String(program + 1);
        let changed = false;
        if (typeof name === 'string' && name && entry.names[key]?.name !== name) { entry.names[key] = { name }; changed = true; }
        if (Array.isArray(dump) && dump.length) {
            const hex = Buffer.from(dump).toString('hex');
            if (entry.dumps[key] !== hex) { entry.dumps[key] = hex; changed = true; }
        }
        if (changed) { entry.dirty = true; this._schedule(); }
        return changed;
    }

    _schedule() {
        if (this.timer) return;
        this.timer = setTimeout(() => this.flush(), this.delayMs);
        this.timer.unref?.();
    }

    flush() {
        clearTimeout(this.timer);
        this.timer = null;
        for (const [file, entry] of this.files) {
            if (!entry.dirty) continue;
            try {
                mkdirSync(this.directory, { recursive: true });
                const write = (suffix, data) => {
                    const target = join(this.directory, `${file}${suffix}.json`);
                    writeFileSync(`${target}.tmp`, JSON.stringify(data));
                    renameSync(`${target}.tmp`, target);
                };
                write('', { presets: entry.names });
                write('.dumps', entry.dumps);
                entry.dirty = false;
            } catch (error) { console.error(`[PRESET] could not save learned presets for ${file}:`, error.message); }
        }
    }
}
