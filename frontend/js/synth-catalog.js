/**
 * frontend/js/synth-catalog.js — Synthesizer catalog for the Synth Controls area.
 *
 * Serves ONLY slice 1 of feature/synth-control-panels: displaying cards for
 * connected Craft Synth and Korg NTS-1 output ports. No modal controls, no
 * MIDI sending (those are later slices).
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
