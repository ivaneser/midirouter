/**
 * Synthesizer catalog for Craft Synth, Korg NTS-1, Arturia MicroFreak, Waldorf Blofeld and PreenFM2 ports.
 * Provides port classification, authoritative control-map loading, and safe MIDI
 * CC payload construction for the expandable synth cards.
 *
 * Classification is case-insensitive against the ALSA device names the server
 * reports in `msg.outputs`. Supported families are recognised here:
 *   - "Craft Synth"      -> model 'craft-synth'
 *   - "NTS-1 digital kit" -> model 'korg-nts-1'  (with or without "Korg" prefix)
 *   - "MicroFreak"       -> model 'arturia-microfreak'
 *
 * Anything that does not match is marked supported: false / model: null so the
 * UI can render it as an unsupported port instead of silently dropping it.
 */

// Canonical lowercase signatures used for matching.
const CRAFT_SYNTH_SIG = 'craft synth';
const KORG_NTS1_SIG = 'nts-1 digital kit';

// ---------------------------------------------------------------------------
// Map files — the authoritative control definitions, served by the server at
// /device_maps/<file>.json in production and read from disk during tests.
// ---------------------------------------------------------------------------

export const MAP_FILES = {
    'craft-synth': 'modal_craft_synth_v2',
    'korg-nts-1': 'korg_nts1',
    'arturia-microfreak': 'arturia_microfreak',
    'waldorf-blofeld': 'waldorf_blofeld',
    'preenfm2': 'preenfm2',
};

// Multitimbral instruments: each part listens on its own MIDI channel and is shown as its own
// card under the instrument.
export const MULTITIMBRAL_PARTS = { 'waldorf-blofeld': 16 };

// A map lists its controls in `controls`, or split over several `controls_<section>` arrays.
export function flattenControls(map) {
    if (Array.isArray(map?.controls)) return map.controls;
    // Each controls_<section> array keeps its section so a layout can place it.
    return Object.entries(map || {}).filter(([key, value]) => key.startsWith('controls_') && Array.isArray(value))
        .flatMap(([key, value]) => value.map(control => ({ section: key.slice('controls_'.length), ...control })));
}

// ---------------------------------------------------------------------------
// Classification (existing slice-1 behaviour, unchanged).
// ---------------------------------------------------------------------------

/**
 * Safely classify a single MIDI output port name into a supported model.
 * Returns { supported: true, model } or { supported: false, model: null }.
 * Never throws — defensive against unexpected input types from the server.
 *
 * @param {string} name - ALSA device name from `msg.outputs`.
 * @returns {{supported: boolean, model: string|null}}
 */
export function classifySynthPortName(name) {
    if (name == null) {
        return { supported: false, model: null };
    }

    const look = String(name).toLowerCase().trim();

    if (look.includes(CRAFT_SYNTH_SIG)) {
        return { supported: true, model: 'craft-synth' };
    }

    if (look.includes(KORG_NTS1_SIG)) {
        return { supported: true, model: 'korg-nts-1' };
    }

    if (/micro[\s_-]*freak/.test(look)) {
        return { supported: true, model: 'arturia-microfreak' };
    }

    if (/pre[\s_-]*enfm[\s_-]*2?/.test(look)) {
        return { supported: true, model: 'preenfm2' };
    }

    if (look.includes('blofeld')) {
        return { supported: true, model: 'waldorf-blofeld' };
    }

    return { supported: false, model: null };
}

/**
 * Build render-ready card data for every output port.
 * Each card carries exactly what the synth-card template needs:
 *   id, name, supported, model
 *
 * @param {Array<{id:string, name:string}>} outputs - DeviceManager output list.
 * @returns {Array<{id:string, name:string, supported:boolean, model:string|null}>}
 */
export function getSynthRenderData(outputs) {
    if (!Array.isArray(outputs)) {
        return [];
    }

    const cards = [];
    for (const out of outputs) {
        const classification = classifySynthPortName(out?.name);
        cards.push({
            id: out.id,
            name: String(out.name),
            supported: classification.supported,
            model: classification.model,
        });
    }
    return cards;
}

// ---------------------------------------------------------------------------
// Slice 2 — expandable controls for supported synth cards.
// ---------------------------------------------------------------------------

/**
 * Get the control definitions for a supported synth model.
 * In the browser this fetches `/device_maps/<file>.json` and returns the
 * `controls` array after checking `response.ok`.  Returns a fresh copy each
 * call (safe to mutate), or `undefined` for unknown/unsupported models.
 *
 * @param {string} model - One of 'craft-synth' or 'korg-nts-1'.
 * @returns {Promise<Array<object>|undefined>}
 */
export async function getControlsForModel(model) {
    const file = MAP_FILES[model];
    if (!file) return undefined;

    // Browser environment — runtime GET from the server.
    const resp = await fetch(`/device_maps/${file}.json`);
    if (!resp.ok) return [];

    const parsed = await resp.json();
    const controls = flattenControls(parsed);

    // Return a deep copy so callers never share mutation surface.
    const copy = JSON.parse(JSON.stringify(controls));
    // Optional signal-flow layout (map.ui) travels with the controls.
    if (parsed.ui) copy.layout = JSON.parse(JSON.stringify(parsed.ui));
    return copy;
}

/**
 * Render a single control definition into a safe DOM instruction object.
 * The instruction describes what the UI should build; it does NOT send MIDI.
 * MIDI is only sent via `buildMidiCcBytes` in response to user events.
 *
 * Label text is always rendered with `textContent` by the consumer — this
 * object structure makes that explicit and guards against innerHTML injection.
 *
 * @param {object} def - A control definition from a device map (`controls[]`).
 * @returns {{tag:string, attrs:Object<string,string>, label:{text:string, useTextContent:true}, options?:Array<string>}}
 */
export function renderControlDefinition(def) {
    const attrs = {};

    // Common attributes present on every control instruction.
    attrs['data-cc'] = String(def.cc);
    if (def.category) attrs['data-category'] = def.category;

    switch (def.type) {
        case 'slider':
            attrs.type = 'range';
            attrs.min = String(def.min != null ? def.min : 0);
            attrs.max = String(def.max != null ? def.max : 127);
            const min = Number(attrs.min);
            const max = Number(attrs.max);
            const initial = def.default ?? def.center ?? (min < 0 && max >= 0 ? 0 : min);
            attrs.value = String(Math.max(min, Math.min(max, Number(initial))));
            if (def.unit) attrs['data-unit'] = def.unit;
            return {
                tag: 'input',
                attrs,
                label: { text: String(def.name), useTextContent: true },
            };

        case 'dropdown':
            attrs.type = 'select';
            // Value semantics for dropdowns: the selected OPTION index.
            if (def.min != null) attrs['data-min'] = String(def.min);
            if (def.max != null) attrs['data-max'] = String(def.max);
            if (Array.isArray(def.values)) attrs['data-values'] = JSON.stringify(def.values);
            return {
                tag: 'select',
                attrs,
                label: { text: String(def.name), useTextContent: true },
                options: Array.isArray(def.options) ? def.options.slice() : [],
            };

        case 'toggle':
            attrs.type = 'checkbox';
            if (def.on_threshold != null) attrs['data-on-threshold'] = String(def.on_threshold);
            return {
                tag: 'input',
                attrs,
                label: { text: String(def.name), useTextContent: true },
            };

        default:
            // Unknown control type — render a labelled spacer, never MIDI.
            attrs['data-unknown'] = String(def.type);
            return {
                tag: 'div',
                attrs,
                label: { text: String(def.name), useTextContent: true },
            };
    }
}

/**
 * Dropdown options and CC values. Most synths take the option number, but some (the NTS-1) spread their
 * types over 0..127; such a control lists the CC value to send for each option in `values`.
 */
export function dropdownRaw(def, index) {
    const value = Array.isArray(def?.values) ? def.values[index] : undefined;
    return Number.isFinite(value) ? value : index + Number(def?.min || 0);
}

// Option shown for a CC value: the option whose value is nearest (the synth takes whole ranges of values).
export function dropdownIndex(def, raw) {
    const values = Array.isArray(def?.values) ? def.values : null;
    if (!values?.length) return raw - Number(def?.min || 0);
    let best = 0;
    values.forEach((value, index) => { if (Math.abs(value - raw) < Math.abs(values[best] - raw)) best = index; });
    return best;
}

/**
 * Build a raw MIDI Continuous Controller message from a control value.
 * Returns a NEW array `[0xB0, cc, value]` — never mutates input and never
 * returns the same reference twice.  Clamps `value` to 0..127 for MIDI safety.
 *
 * This function is pure: it does NOT send anything.  The caller (a change
 * handler on a control element) must invoke `this.sendMidi(card.id, bytes)`
 * with the returned bytes to actually transmit on the correct output port.
 *
 * @param {string} model - The synth model (used for validation only).
 * @param {number} cc    - MIDI CC number from the control definition.
 * @param {number} value - Desired controller value (will be clamped 0..127).
 * @returns {[number, number, number]}
 */
export function buildMidiCcBytes(model, cc, value, definition) {
    // Signed display ranges such as -64..63 map onto unsigned MIDI 0..127.
    const offset = Number(definition?.min) < 0 ? -Number(definition.min) : 0;
    const clamped = Math.max(0, Math.min(127, (Number(value) + offset) | 0));
    return [0xB0, Number(cc) | 0, clamped];
}
