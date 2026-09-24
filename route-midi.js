/**
 * route-midi.js — shared, testable routing decision logic.
 *
 * This module holds the pure part of `_onIncomingMessage`'s routing tail:
 * loopback/sys-realtime guards, per-route channel filtering and CC transform,
 * and output selection (all-to-all vs explicit routes).
 *
 * It is imported by worker-midi.js at runtime AND by unit tests so that test
 * assertions always describe what production code actually does — no mirrored
 * reimplementation of the algorithm in the test layer.
 */

const LOOPBACK_PATTERNS = [/loopback/i, /timer/i, /midi through/i];

/**
 * Normalise a route input/output entry to its port name string.
 *
 * `_buildMapping` in worker-midi.js stores ports as `{name: portName}` objects,
 * but the routing logic only ever needs the name. Accepts both strings (for
 * tests that build `mappings` manually) and object entries produced at runtime.
 */
export function normalisePortName(entry) {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object' && entry.name != null) return entry.name;
    return String(entry ?? '');
}

/**
 * Decide where a MIDI message goes and with which transformed bytes.
 *
 * @param {number[]}  bytes         Raw MIDI bytes (status + data).
 * @param {string}    deviceName    Logical input port name (stable, by-name).
 * @param {{outputs: Map<string, any>, mappings: Map<string, any>, ccMapper: object}} opts
 *   outputs  — Map<outputDeviceName, RtMidiOut-like record> (production) or names (tests).
 *   mappings — Map<routeId, {inputs:string[], outputs:string[], filters:Filter[]}>.
 *   ccMapper — CCMapper instance (or a test double exposing transformCC).
 * @returns {{dropped: string|null, message:number[]|null, delivered:Array<{output:string, bytes:number[], channel:number}>}}
 */
export function computeRoutingStep(bytes, deviceName, { outputs = new Map(), mappings = new Map(), ccMapper = null }) {
    const status = bytes[0];
    const type = (status & 0xf0) >> 4;
    const channel = type >= 8 ? (status & 0x0f) + 1 : 1;

    // Guard: loopback / timer / Midi Through ports — feedback prevention.
    for (const p of LOOPBACK_PATTERNS) {
        if (p.test(deviceName)) return { dropped: 'loopback', message: null };
    }

    // System real-time bytes are forwarded as-is by the caller; routing does not touch them.
    if (status >= 0xf8 && status <= 0xff) return { dropped: 'sys-realtime', message: bytes };

    const delivered = [];

    // ---- ALL-TO-ALL (default path when no explicit routes are configured) ----
    if (mappings.size === 0) {
        for (const [outName, _record] of outputs) {
            let outMsg = Buffer.from(bytes);

            // CC transform per real output target — the same path used in worker-midi.js.
            if (type === 11 && ccMapper) {
                const transformed = ccMapper.transformCC(
                    { bytes: Buffer.from(outMsg), type, channel: channel - 1, velocity: bytes[2] || 0, note: bytes[1] || 0 },
                    deviceName, outName, 'default' // routeId is meaningless in all-to-all
                );
                if (transformed && transformed.bytes) outMsg = Buffer.from(transformed.bytes);
            }

            delivered.push({ output: outName, bytes: Array.from(outMsg), channel });
        }
        return { dropped: null, message: bytes, delivered };
    }

    // ---- EXPLICIT ROUTED PATH ----
    for (const [mappingName, mapping] of mappings) {
        const inputMatch = mapping.inputs.some((inp) => deviceName.includes(normalisePortName(inp)));
        if (!inputMatch) continue;

        // Per-route fresh context + own Buffer copy — a filter in one route must
        // never mutate another route's context (ChannelFilter._process mutates via map).
        let filterCtx = {
            bytes: Buffer.from(bytes),
            type,
            channel: channel - 1, // ChannelFilter works on 0-based internally, +1 in its _process
            velocity: bytes[2] || 0,
            note: bytes[1] || 0,
        };

        let filtered = true;
        for (const f of mapping.filters) {
            const result = f.process({ ...filterCtx });
            if (result === false) { filtered = false; break; }
            if (result && result.bytes) filterCtx.bytes = Buffer.from(result.bytes);
            if (result && result.channel !== undefined) filterCtx.channel = result.channel;
        }
        if (!filtered) continue;

        // Transform CC per route before sending to matched outputs.
        let outBytes = Buffer.from(filterCtx.bytes);
        let transformed = null;
        if (type === 11 && ccMapper) {
            transformed = ccMapper.transformCC(
                { bytes: outBytes, type, channel: filterCtx.channel, velocity: filterCtx.velocity, note: filterCtx.note },
                deviceName, normalisePortName(mapping.outputs[0] || 'default'), mappingName
            );
            if (transformed && transformed.bytes) outBytes = Buffer.from(transformed.bytes);
        }

        const ch = (transformed && transformed.channel !== undefined)
            ? transformed.channel + 1
            : filterCtx.channel + 1;

        for (const outName of mapping.outputs) {
            delivered.push({ output: normalisePortName(outName), bytes: Array.from(outBytes), channel: ch });
        }
    }

    return { dropped: null, message: bytes, delivered };
}

/**
 * Helper used by worker-midi.js to turn a computeRoutingStep result into
 * actual MIDI transmissions. Keeps the "decide vs act" separation clean.
 */
export function deliverRoutedMessages(result, sendFn) {
    let sent = 0;
    for (const d of result.delivered) {
        sendFn(d.output, Buffer.from(d.bytes));
        sent++;
    }
    return sent;
}
