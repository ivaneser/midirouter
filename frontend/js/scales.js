// Scales as semitone offsets from the root note.
export const SCALES = [
    // Western
    { group: 'Western', id: 'major', name: 'Major (Ionian, Bilawal, Ajam)', steps: [0, 2, 4, 5, 7, 9, 11] },
    { group: 'Western', id: 'minor', name: 'Natural minor (Aeolian, Asavari)', steps: [0, 2, 3, 5, 7, 8, 10] },
    { group: 'Western', id: 'harmonic-minor', name: 'Harmonic minor (Nahawand)', steps: [0, 2, 3, 5, 7, 8, 11] },
    { group: 'Western', id: 'melodic-minor', name: 'Melodic minor', steps: [0, 2, 3, 5, 7, 9, 11] },
    { group: 'Western', id: 'dorian', name: 'Dorian (Kafi)', steps: [0, 2, 3, 5, 7, 9, 10] },
    { group: 'Western', id: 'phrygian', name: 'Phrygian (Bhairavi, Kurd)', steps: [0, 1, 3, 5, 7, 8, 10] },
    { group: 'Western', id: 'lydian', name: 'Lydian (Kalyan)', steps: [0, 2, 4, 6, 7, 9, 11] },
    { group: 'Western', id: 'mixolydian', name: 'Mixolydian (Khamaj)', steps: [0, 2, 4, 5, 7, 9, 10] },
    { group: 'Western', id: 'locrian', name: 'Locrian', steps: [0, 1, 3, 5, 6, 8, 10] },
    { group: 'Western', id: 'major-pentatonic', name: 'Major pentatonic (Bhupali)', steps: [0, 2, 4, 7, 9] },
    { group: 'Western', id: 'minor-pentatonic', name: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
    { group: 'Western', id: 'blues', name: 'Blues', steps: [0, 3, 5, 6, 7, 10] },
    { group: 'Western', id: 'whole-tone', name: 'Whole tone', steps: [0, 2, 4, 6, 8, 10] },
    { group: 'Western', id: 'diminished-wh', name: 'Diminished (whole-half)', steps: [0, 2, 3, 5, 6, 8, 9, 11] },
    { group: 'Western', id: 'diminished-hw', name: 'Diminished (half-whole)', steps: [0, 1, 3, 4, 6, 7, 9, 10] },
    { group: 'Western', id: 'lydian-dominant', name: 'Lydian dominant', steps: [0, 2, 4, 6, 7, 9, 10] },
    { group: 'Western', id: 'altered', name: 'Altered (super Locrian)', steps: [0, 1, 3, 4, 6, 8, 10] },
    { group: 'Western', id: 'harmonic-major', name: 'Harmonic major', steps: [0, 2, 4, 5, 7, 8, 11] },
    { group: 'Western', id: 'hungarian-minor', name: 'Hungarian minor', steps: [0, 2, 3, 6, 7, 8, 11] },
    { group: 'Western', id: 'persian', name: 'Persian', steps: [0, 1, 4, 5, 6, 8, 11] },
    { group: 'Western', id: 'neapolitan-major', name: 'Neapolitan major', steps: [0, 1, 3, 5, 7, 9, 11] },
    // Indian, Japanese and Arabic scales that match a Western one carry their names in that scale's
    // label above (a scale is listed once), so these are the ones with their own notes.
    { group: 'Indian', id: 'raga-bhairav', name: 'Bhairav (Double harmonic, Hijaz Kar)', steps: [0, 1, 4, 5, 7, 8, 11] },
    { group: 'Indian', id: 'raga-todi', name: 'Todi', steps: [0, 1, 3, 6, 7, 8, 11] },
    { group: 'Indian', id: 'raga-purvi', name: 'Purvi', steps: [0, 1, 4, 6, 7, 8, 11] },
    { group: 'Indian', id: 'raga-marwa', name: 'Marwa', steps: [0, 1, 4, 6, 7, 9, 11] },
    { group: 'Indian', id: 'raga-ahir-bhairav', name: 'Ahir Bhairav', steps: [0, 1, 4, 5, 7, 9, 10] },
    { group: 'Indian', id: 'raga-charukesi', name: 'Charukesi', steps: [0, 2, 4, 5, 7, 8, 10] },
    { group: 'Indian', id: 'raga-malkauns', name: 'Malkauns', steps: [0, 3, 5, 8, 10] },
    { group: 'Indian', id: 'raga-madhyamavati', name: 'Madhyamavati', steps: [0, 2, 5, 7, 10] },
    { group: 'Indian', id: 'raga-hamsadhvani', name: 'Hamsadhvani', steps: [0, 2, 4, 7, 11] },
    // Japanese
    { group: 'Japanese', id: 'hirajoshi', name: 'Hirajoshi', steps: [0, 2, 3, 7, 8] },
    { group: 'Japanese', id: 'in-sen', name: 'In Sen (Insen)', steps: [0, 1, 5, 7, 10] },
    { group: 'Japanese', id: 'iwato', name: 'Iwato', steps: [0, 1, 5, 6, 10] },
    { group: 'Japanese', id: 'yo', name: 'Yo', steps: [0, 2, 5, 7, 9] },
    { group: 'Japanese', id: 'kumoi', name: 'Kumoi', steps: [0, 2, 3, 7, 9] },
    { group: 'Japanese', id: 'miyako-bushi', name: 'Miyako-bushi', steps: [0, 1, 5, 7, 8] },
    { group: 'Japanese', id: 'ryukyu', name: 'Ryukyu', steps: [0, 4, 5, 7, 11] },
    // Arabic and Turkish (maqamat, in twelve-tone approximation: quarter tones cannot be played on MIDI notes)
    { group: 'Arabic', id: 'maqam-hijaz', name: 'Hijaz (Phrygian dominant)', steps: [0, 1, 4, 5, 7, 8, 10] },
    { group: 'Arabic', id: 'maqam-nikriz', name: 'Nikriz', steps: [0, 2, 3, 6, 7, 9, 10] },
    { group: 'Arabic', id: 'maqam-athar-kurd', name: 'Athar Kurd', steps: [0, 1, 3, 5, 7, 8, 11] },
];

// How tense each interval above the root sounds (0 = at rest). It only breaks ties: a note that
// is equally far from two allowed notes moves to the calmer one.
const TENSION = [0, 6, 4, 2, 2, 3, 6, 1, 5, 3, 4, 5];

export function scaleById(id) {
    return SCALES.find(s => s.id === id) || null;
}

export function isAllowed(note, root, scale) {
    if (!scale) return true;
    return scale.steps.includes((((note - root) % 12) + 12) % 12);
}

// The allowed note closest to `note` (0-127). Equal distance goes to the lower tension, then the lower note.
export function nearestAllowed(note, root, scale) {
    if (!scale || isAllowed(note, root, scale)) return note;
    let best = null;
    for (let distance = 1; distance <= 12 && best === null; distance++) {
        const options = [note - distance, note + distance]
            .filter(n => n >= 0 && n <= 127 && isAllowed(n, root, scale))
            .sort((a, b) => TENSION[(((a - root) % 12) + 12) % 12] - TENSION[(((b - root) % 12) + 12) % 12] || a - b);
        if (options.length) best = options[0];
    }
    return best ?? note;
}

// Moves every note into the scale. Notes that land on the same pitch and start are merged.
export function fitNotesToScale(notes, root, scale) {
    const seen = new Set();
    const fitted = [];
    for (const n of notes) {
        const moved = { ...n, note: nearestAllowed(n.note, root, scale) };
        const key = `${moved.channel}:${moved.note}:${moved.start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        fitted.push(moved);
    }
    return fitted;
}
