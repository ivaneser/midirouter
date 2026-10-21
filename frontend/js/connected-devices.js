const nameKey = name => String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Deduplicate repeated inventory entries while retaining distinct physical IDs. */
export function uniquePorts(ports) {
    const seen = new Set();
    return (Array.isArray(ports) ? ports : []).filter(port => {
        if (!port || typeof port.name !== 'string') return false;
        const key = port.id ?? nameKey(port.name);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function displayName(name) {
    const clean = String(name).trim().replace(/\s+/g, ' ').replace(/\s+\d+:\d+$/, '');
    const colon = clean.indexOf(':');
    if (colon < 0) return clean;
    const device = clean.slice(0, colon).trim();
    const port = clean.slice(colon + 1).trim();
    // ALSA commonly repeats the device prefix in its port name.
    const suffix = port.toLowerCase().startsWith(device.toLowerCase())
        ? port.slice(device.length).replace(/^[\s_:-]+/, '') : port;
    return suffix ? `${device} · ${suffix}` : device;
}

/** One card per matching input/output pair; never merge two same-direction IDs. */
export function connectedDevices(inputs, outputs) {
    const cards = uniquePorts(inputs).map(port => ({ ...port, input: true, output: false }));
    for (const port of uniquePorts(outputs)) {
        const match = cards.find(card => card.input && !card.output && nameKey(card.name) === nameKey(port.name));
        if (match) {
            // Controls must address the output, even when its ID differs from input.
            Object.assign(match, port, { output: true });
        } else cards.push({ ...port, input: false, output: true });
    }
    const counts = new Map();
    for (const card of cards) {
        card.displayName = displayName(card.name);
        const key = nameKey(card.displayName);
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    const labels = new Set();
    for (const card of cards) {
        const base = card.displayName;
        if (counts.get(nameKey(base)) > 1) {
            const address = card.name.match(/\s+(\d+:\d+)\s*$/)?.[1];
            card.displayName = `${base} (${address || card.id})`;
        }
        const label = card.displayName;
        let index = 2;
        while (labels.has(nameKey(card.displayName))) card.displayName = `${label} · ${index++}`;
        labels.add(nameKey(card.displayName));
    }
    return cards;
}
