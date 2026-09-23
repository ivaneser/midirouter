// Launchkey MK3 Session layout on the DAW MIDI port.
export const SESSION_PAD_NOTES = [
    ...Array.from({ length: 8 }, (_, i) => 112 + i),
    ...Array.from({ length: 8 }, (_, i) => 96 + i),
];

export function isSessionPad(note, channel) {
    return channel === 1 && SESSION_PAD_NOTES.includes(note);
}

export function padNoteForIndex(index) {
    return SESSION_PAD_NOTES[index] ?? null;
}
