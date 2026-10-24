// Reading order follows sound creation, shaping, effects, then modulation.
const SECTIONS = [
    ['sound', 'Sound'], ['osc', 'Oscillator'],
    ['filter', 'Filter'], ['filter_env', 'Filter envelope'], ['amp', 'Amplifier'], ['env', 'Envelope'], ['mod_env', 'Modulation envelope'],
    ['cycl_env', 'Cycling envelope'],
    ['fx', 'Effects'], ['fx_mod', 'Modulation effect'],
    ['delay', 'Delay'], ['fx_delay', 'Delay effect'],
    ['reverb', 'Reverb'], ['fx_reverb', 'Reverb effect'], ['mix', 'Mix'],
    ['mod', 'Modulation'], ['lfo', 'LFO'], ['sweep', 'Filter sweep'],
    ['vibrato', 'Vibrato'], ['tremolo', 'Tremolo'],
    ['glide', 'Glide'], ['portamento', 'Portamento'], ['keyboard', 'Keyboard'], ['arp', 'Arpeggiator / sequencer'],
];

export function groupSynthControls(controls) {
    const groups = new Map();
    for (const control of controls) {
        const category = control.category || 'parameters';
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(control);
    }
    const known = new Map(SECTIONS);
    const categories = [
        ...SECTIONS.map(([category]) => category).filter(category => groups.has(category)),
        ...[...groups.keys()].filter(category => !known.has(category)).sort(),
    ];
    return categories.map(category => ({
        category,
        label: known.get(category) || category.replaceAll('_', ' '),
        controls: groups.get(category),
    }));
}
