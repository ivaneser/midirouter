/**
 * Synthesizer catalog for supported Craft Synth and Korg NTS-1 output ports.
 * Provides port classification, authoritative control-map loading, and safe MIDI
 * CC payload construction for the expandable synth cards.
 *
 * Classification is case-insensitive against the ALSA device names the server
 * reports in `msg.outputs`. Two supported families are recognised here:
 *   - "Craft Synth"      -> model 'craft-synth'
 *   - "NTS-1 digital kit" -> model 'korg-nts-1'  (with or without "Korg" prefix)
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

const MAP_FILES = {
    'craft-synth': 'modal_craft_synth_v2',
    'korg-nts-1': 'korg_nts1',
};

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
    const controls = Array.isArray(parsed.controls) ? parsed.controls : [];

    // Return a deep copy so callers never share mutation surface.
    return JSON.parse(JSON.stringify(controls));
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
export function buildMidiCcBytes(model, cc, value) {
    const clamped = Math.max(0, Math.min(127, Number(value) | 0));
    return [0xB0, Number(cc) | 0, clamped];
}
