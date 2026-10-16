// ---------------------------------------------------------------------------
// `alsa-subscriptions.js` — Parse `aconnect -l` to check ALSA subscriptions.
//
// A device can be re-plugged while the router keeps its RtMidi input open. The
// kernel then drops the subscription between the device port and our input
// client, and the input silently receives nothing (no clock, no notes).
// RtMidi only subscribes at openPort(), so the router must reopen such inputs.
//
// Pure functions (no child processes) so they can be unit-tested with listings.
// ---------------------------------------------------------------------------

/**
 * Port name as `aconnect -l` displays it:
 * "NTS-1 digital kit:NTS-1 digital kit _ SOUND 20:0" -> "NTS-1 digital kit _ SOUND".
 * @param {string} name
 */
export function aconnectPortDisplayName(name) {
    return String(name ?? '').split(':').slice(1).join(':').replace(/ \d+:\d+$/, '');
}

/**
 * Whether the device port `portDisplay` is subscribed (sends) to an RtMidi input
 * client in an `aconnect -l` listing.
 *
 * @param {string} listing      output of `aconnect -l`
 * @param {string} portDisplay  display name from aconnectPortDisplayName()
 * @returns {boolean|null} true = subscribed, false = port listed but no
 *                         subscription to our input, null = port not listed
 */
export function isInputSubscribed(listing, portDisplay) {
    const text = String(listing ?? '');
    const clientNames = new Map();
    for (const m of text.matchAll(/^client (\d+): '([^']*)'/gm)) clientNames.set(m[1], m[2]);

    const portIdx = text.indexOf(`'${portDisplay}'`);
    if (portIdx === -1) return null;
    const blockEnd = text.indexOf('\nclient ', portIdx);
    const block = text.slice(portIdx, blockEnd === -1 ? undefined : blockEnd);

    const connectingTo = block.match(/Connecting To: (.*)/);
    if (!connectingTo) return false;
    for (const m of connectingTo[1].matchAll(/(\d+):\d+/g)) {
        if (/RtMidi Input/i.test(clientNames.get(m[1]) ?? '')) return true;
    }
    return false;
}
