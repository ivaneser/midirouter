// ---------------------------------------------------------------------------
// `clock-master.js` — Clock source selection + one-to-one fanout logic.
//
// Pure JavaScript module (no ALSA / worker_threads dependencies) so it can be:
//  1. Used by the worker thread under test, and
//  2. Imported by unit tests without bootstrapping MIDI ports.
//
// Two things are needed for correct MIDI clock master handling:
//
//  1. Selection of a single clock master:
//       - `internal` — DAW engine's MidiClock (0xFA/0xFB/0xFC + 24 PPQN)
//       - `external` — one named input port whose 0xF8/0xFA/0xFB/0xFC is used
//         for sync and retransmitted to the allowed outputs.
//
//  2. Fanout of the master clock to every *allowed* output, excluding:
//       - the master input port itself (never loop back),
//       - controller feedback-excluded outputs (`controllerEngine.isExcludedOutput`),
//       - non-clock destinations unless `isMidiClockOutput` permits them,
//       - user-configured explicit exclusions (safe fallback when an input
//         name and an output name do not form a reliable pair).
//
// The worker holds one `ClockMaster` instance.  On each tick it sends the
// master bytes to exactly the ports returned by `clockOutputsFor(clockMaster)`.
// ---------------------------------------------------------------------------

const INTERNAL_SOURCE = { kind: 'internal', masterPortName: null };

/**
 * @param {{ outputs?: Array<{name:string, send?: (bytes:number[])=>void}>, explicitExclusions?: string[] }} [opts]
 */
export class ClockMaster {
    constructor(opts = {}) {
        this.source = { ...INTERNAL_SOURCE }; // 'internal' | { kind:'external', masterPortName: string }
        /** @type {{ name: string, send?: (bytes: number[]) => void }[]} */
        this.outputs = [...(opts.outputs || [])];
        /** @type {string[]} */
        this.explicitExclusions = [...(opts.explicitExclusions || [])];
    }

    get kind() {
        return this.source.kind;
    }

    get masterPortName() {
        return this.source.kind === 'external' ? this.source.masterPortName : null;
    }

    /** Outputs that may receive clock right now (candidates minus current master). */
    get activeOutputs() {
        if (this.source.kind === 'internal') {
            return this.candidateOutputs;
        }
        const masterName = this.source.masterPortName;
        return this.candidateOutputs.filter((p) => p.name !== masterName);
    }

    /** All outputs that are candidates for clock fanout (before master exclusion). */
    get candidateOutputs() {
        return this.outputs.filter(
            (p) => !this.explicitExclusions.includes(p.name),
        );
    }

    selectInternal() {
        this.source = { ...INTERNAL_SOURCE };
    }

    /** @param {string} portName — name of the selected external input port */
    selectExternal(portName) {
        this.source = { kind: 'external', masterPortName: portName ?? null };
    }

    /** Reset external sync state (BPM history / phase) when master disappears. */
    resetExternalState() {
        this.selectInternal();
    }

    /** Replace user-configured explicit output exclusions. */
    setExplicitExclusions(names) {
        this.explicitExclusions = [...(names || [])];
    }

    // ---- Syncing real outputs (worker ↔ clock-master) ----------------------

    /**
     * Register a real output port by name with a send adapter.
     * The worker calls this each time an RtMidiOut is opened so the ClockMaster
     * holds live destinations instead of an empty list.
     * @param {string} name
     * @param {(bytes: number[]) => void} [sendFn]  — adapts .sendMessage(Buffer) → .send(bytes)
     */
    registerOutput(name, sendFn = () => {}) {
        const existing = this.outputs.find((p) => p.name === name);
        if (existing) {
            existing.send = sendFn;
            return existing;
        }
        const entry = { name, send: sendFn };
        this.outputs.push(entry);
        return entry;
    }

    /** Unregister a real output port (hot-plug disconnect). */
    deregisterOutput(name) {
        this.outputs = this.outputs.filter((p) => p.name !== name);
    }
}

/**
 * Compute the destinations that should receive the master clock right now.
 *
 * Rules:
 *  - Internal source → every candidate output (master is virtual, no port to exclude).
 *  - External source → every candidate output EXCEPT the master input port itself.
 *  - `predicate(port)` may further filter destinations (e.g. controller engine
 *    exclusion / midiClockOutput policy).
 */
export function clockOutputsFor(clockMaster, predicate) {
    const candidates = clockMaster.candidateOutputs;

    if (clockMaster.source.kind === 'internal') {
        return candidates.filter(predicate);
    }

    // Exclude the physical master port to prevent feedback loops.
    // If the selected master is not among the available outputs (hot-plug
    // disconnect, name mismatch), all candidate outputs remain valid targets —
    // we never guess a pairing beyond what the user explicitly configured.
    const masterName = clockMaster.source.masterPortName;
    return candidates.filter(
        (p) => p.name !== masterName && predicate(p),
    );
}
