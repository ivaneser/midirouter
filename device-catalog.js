import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { classifySynthPortName, MAP_FILES, flattenControls, dropdownRaw, dropdownIndex } from './frontend/js/synth-catalog.js';

const normalize = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Control maps (device_maps/*.json) and optional preset catalogs (device_maps/presets/*.json),
// looked up by output port name. Maps are read once and cached.
export class DeviceCatalog {
    constructor(directory) {
        this.directory = directory;
        this.cache = new Map();
    }

    _load(path) {
        if (!this.cache.has(path)) {
            this.cache.set(path, existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);
        }
        return this.cache.get(path);
    }

    // { model, map, presets } for a supported port name, else null.
    forPort(portName) {
        const { supported, model } = classifySynthPortName(portName);
        const file = supported && MAP_FILES[model];
        if (!file) return null;
        const map = this._load(join(this.directory, `${file}.json`));
        if (!map) return null;
        map.controls = flattenControls(map);
        return { model, map, presets: this._load(join(this.directory, 'presets', `${file}.json`)) };
    }

    // Favourite presets are the ones whose catalog entry carries the tag "favorite".
    favorites(file) {
        const presets = /^[\w-]+$/.test(file) ? this._load(join(this.directory, 'presets', `${file}.json`))?.presets : null;
        return Object.entries(presets ?? {}).filter(([, p]) => p.tags?.includes('favorite')).map(([number]) => Number(number)).sort((a, b) => a - b);
    }

    // Tags or untags one preset (1-based number) and saves the catalog; false when there is no such preset.
    setFavorite(file, number, favorite) {
        if (!/^[\w-]+$/.test(file)) return false;
        const path = join(this.directory, 'presets', `${file}.json`);
        const preset = this._load(path)?.presets?.[String(number)];
        if (!preset) return false;
        const tags = new Set(preset.tags ?? []);
        if (favorite) tags.add('favorite'); else tags.delete('favorite');
        if (tags.size) preset.tags = [...tags]; else delete preset.tags;
        writeFileSync(`${path}.tmp`, `${JSON.stringify(this._load(path), null, 1)}\n`);
        renameSync(`${path}.tmp`, path);
        return true;
    }
}

// Find one output by exact id, exact name, or unique case-insensitive name fragment.
export function resolveOutput(outputs, query) {
    const wanted = String(query ?? '').trim();
    if (!wanted) throw new Error('device is required (use list_devices)');
    const exact = outputs.filter(o => o.id === wanted || o.name === wanted);
    if (exact.length === 1) return exact[0];
    const fragment = normalize(wanted);
    const partial = outputs.filter(o => normalize(o.name).includes(fragment));
    if (partial.length === 1) return partial[0];
    const names = (partial.length ? partial : outputs).map(o => o.name).join('; ');
    throw new Error(partial.length > 1
        ? `device "${wanted}" is ambiguous: ${names}`
        : `no connected output matches "${wanted}". Connected outputs: ${names || 'none'}`);
}

// A control by CC number (or NRPN number with key 'nrpn') or by name ("filter_cutoff",
// "Filter Cutoff" and "cutoff" all match).
export function findControl(controls, ref, key = 'cc') {
    if (typeof ref === 'number' || /^\d+$/.test(String(ref).trim())) {
        const number = Number(ref);
        const control = controls.find(c => c[key] === number);
        if (!control) throw new Error(`no control with ${key.toUpperCase()} ${number}`);
        return control;
    }
    const wanted = normalize(ref);
    const exact = controls.filter(c => normalize(c.name) === wanted);
    if (exact.length === 1) return exact[0];
    const partial = controls.filter(c => normalize(c.name).includes(wanted));
    if (partial.length === 1) return partial[0];
    throw new Error(partial.length > 1
        ? `parameter "${ref}" is ambiguous: ${partial.map(c => c.name).join(', ')}`
        : `unknown parameter "${ref}"`);
}

const offsetOf = control => (Number(control.min) < 0 ? -Number(control.min) : 0);

// Turn a user value into the raw CC byte, exactly as the UI knobs do:
// sliders take display values (signed ranges add an offset), dropdowns an option index or
// label, toggles a boolean.
export function encodeControlValue(control, value) {
    let display;
    if (control.type === 'toggle') {
        if (typeof value === 'boolean') display = value ? 127 : 0;
        else if (typeof value === 'string' && /^(on|off)$/i.test(value)) display = /^on$/i.test(value) ? 127 : 0;
        else display = Number(value);
    } else if (control.type === 'dropdown' && typeof value === 'string' && !/^-?\d+(\.\d+)?$/.test(value.trim())) {
        const index = (control.options || []).findIndex(o => normalize(o) === normalize(value));
        if (index < 0) throw new Error(`"${control.name}" options: ${(control.options || []).join(', ')}`);
        display = index + Number(control.min || 0);
    } else {
        display = Number(value);
    }
    if (!Number.isFinite(display)) throw new Error(`value for "${control.name}" must be a number`);
    const low = control.type === 'toggle' ? 0 : Number(control.min ?? 0);
    const high = control.type === 'toggle' ? 127 : Number(control.max ?? 127);
    const clamped = Math.max(low, Math.min(high, Math.round(display)));
    const raw = control.type === 'dropdown' && Array.isArray(control.values)
        ? dropdownRaw(control, clamped - Number(control.min || 0))
        : Math.max(0, Math.min(127, clamped + offsetOf(control)));
    return { display: clamped, raw };
}

// NRPN parameters of a map (controls_nrpn.parameters entries that carry an nrpn number).
export function nrpnControls(map) {
    return (map?.controls_nrpn?.parameters || []).filter(p => Number.isInteger(p.nrpn));
}

// Turn a user value into NRPN writes [{ nrpn, raw }] (raw is 14-bit). Values are in the synth's
// units: sliders with a scale are sent as (value - min) * scale, other sliders and dropdowns as
// the value itself; text is one character code per consecutive NRPN, padded with spaces.
export function encodeNrpnValue(control, value) {
    if (control.type === 'text') {
        const text = String(value ?? '');
        if (!/^[\x20-\x7E]*$/.test(text)) throw new Error(`"${control.name}" takes plain ASCII text`);
        const display = text.slice(0, control.maxLength).padEnd(control.maxLength, ' ');
        return { display: display.trimEnd(), writes: [...display].map((ch, i) => ({ nrpn: control.nrpn + i, raw: ch.charCodeAt(0) })) };
    }
    let display;
    if (control.type === 'dropdown' && typeof value === 'string' && !/^-?\d+(\.\d+)?$/.test(value.trim())) {
        const index = (control.options || []).findIndex(o => normalize(o) === normalize(value));
        if (index < 0) throw new Error(`"${control.name}" options: ${(control.options || []).join(', ')}`);
        display = index + Number(control.min || 0);
    } else {
        display = Number(value);
    }
    if (!Number.isFinite(display)) throw new Error(`value for "${control.name}" must be a number`);
    const min = Number(control.min ?? 0);
    const clamped = Math.max(min, Math.min(Number(control.max ?? 16383), display));
    const raw = control.scale ? Math.round((clamped - min) * control.scale) : Math.round(clamped);
    if (raw < 0 || raw > 16383) throw new Error(`"${control.name}" value is outside the NRPN range`);
    const shown = control.scale ? Math.round((min + raw / control.scale) * control.scale) / control.scale : raw;
    if (control.type === 'dropdown') return { display: { value: shown, option: control.options?.[shown - min] }, writes: [{ nrpn: control.nrpn, raw }] };
    return { display: shown, writes: [{ nrpn: control.nrpn, raw }] };
}

// Remembered raw NRPN values (Map nrpn -> raw) back to the value encodeNrpnValue displayed.
export function decodeNrpnValue(control, raws) {
    if (control.type === 'text') {
        const codes = Array.from({ length: control.maxLength }, (_, i) => raws.get(control.nrpn + i));
        return codes.some(code => code === undefined) ? undefined : String.fromCharCode(...codes).trimEnd();
    }
    const raw = raws.get(control.nrpn);
    if (raw === undefined) return undefined;
    const min = Number(control.min ?? 0);
    const value = control.scale ? Math.round((min + raw / control.scale) * control.scale) / control.scale : raw;
    return control.type === 'dropdown' ? { value, option: control.options?.[value - min] } : value;
}

// Raw CC byte back to what the UI displays.
export function decodeControlValue(control, raw) {
    if (raw === undefined) return undefined;
    if (control.type === 'toggle') return raw > 0;
    const display = raw - offsetOf(control);
    if (control.type === 'dropdown') {
        const index = dropdownIndex(control, display);
        return { value: index + Number(control.min || 0), option: (control.options || [])[index] };
    }
    return display;
}
