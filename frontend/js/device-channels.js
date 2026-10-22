// ALSA client numbers change after reconnecting; retain the port number.
export function deviceChannelKey(name) {
    return String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
        .replace(/\s+\d+:(\d+)$/, ' port:$1');
}

export function validMidiChannel(channel) {
    return Number.isInteger(channel) && channel >= 1 && channel <= 16;
}
