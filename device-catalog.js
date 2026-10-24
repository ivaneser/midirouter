import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { classifySynthPortName, MAP_FILES, flattenControls } from './frontend/js/synth-catalog.js';

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

// A control by CC number or by name ("filter_cutoff", "Filter Cutoff" and "cutoff" all match).
export function findControl(controls, ref) {
    if (typeof ref === 'number' || /^\d+$/.test(String(ref).trim())) {
        const cc = Number(ref);
        const control = controls.find(c => c.cc === cc);
        if (!control) throw new Error(`no control with CC ${cc}`);
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
    const raw = Math.max(0, Math.min(127, clamped + offsetOf(control)));
    return { display: clamped, raw };
}

// Raw CC byte back to what the UI displays.
export function decodeControlValue(control, raw) {
    if (raw === undefined) return undefined;
    if (control.type === 'toggle') return raw > 0;
    const display = raw - offsetOf(control);
    if (control.type === 'dropdown') {
        return { value: display, option: (control.options || [])[display - Number(control.min || 0)] };
    }
    return display;
}
