// ---------------------------------------------------------------------------
// `external-midi-clock.js` — Pure external MIDI Clock slave logic.
//
// Extracted from `worker-midi.js` (`_handleMidiClock`) so it can be:
//  1. Used directly by the worker under test (single source of truth), and
//  2. Imported by unit tests without bootstrapping ALSA / worker_threads /
//     metronome or reading `config.json`.
//
// MIDI subsystem real-time contract: 24 timing-clock (0xF8) ticks span one
// quarter-note beat (PPQN = 24).  Given an array of captured tick timestamps,
// the first of any consecutive 25 samples bounds exactly one quarter note:
//
//     quarterMs = timestamp[24] - timestamp[0]
//     rawBpm    = 60_000 / quarterMs            // 1 min = 60_000 ms
//
// The first estimate (tick #25) is used raw; subsequent estimates are
// exponentially smoothed with the stored tempo as the prior:
//
//     smoothed = smoothed * 0.75 + rawEstimate * 0.25
//
// Values outside the [20, 300] BPM range (the same clamp DAWEngine.setTempo
// applies) are discarded so a silent gap or clock glitch never drives the
// downstream tempo to an absurd value.
// ---------------------------------------------------------------------------

const MIN_HISTORY = 25;       // ticks needed before any BPM estimate is valid
const MAX_HISTORY = 49;       // cap: keep ~2 quarter notes of margin (shift when exceeded)
const SMOOTH_FACTOR = 0.75;   // prior weight in the exponential moving average
const TEMPO_CHANGE_THRESHOLD = 0.005; // avoid DAW/UI updates for <0.5% jitter

/**
 * Compute a raw BPM estimate from a history array of tick timestamps.
 *
 * @param {number[]} history - Monotonic `performance.now()` samples, length >= MIN_HISTORY.
 * @returns {number|null}    The estimated BPM (20..300), or null if the sample is
 *                           invalid / out of range.
 */
function estimateBpmFromHistory(history) {
    if (!Array.isArray(history) || history.length < MIN_HISTORY) return null;

    // We only care about the last `MIN_HISTORY` samples — older ones cannot
    // belong to a complete 24-interval quarter note window.
    const tail = history.slice(-MIN_HISTORY);
    const first = tail[0];
    const last = tail[tail.length - 1];
    const quarterMs = last - first;

    if (quarterMs <= 0) return null;

    // 24 ticks = 23 intervals inside the window... but MIDI clock convention:
    // 24 *tick events* span one beat, so 25 timestamps bound exactly one beat.
    const rawBpm = 60_000 / quarterMs;
    if (rawBpm < 20 || rawBpm > 300) return null;

    return rawBpm;
}

class ExternalMidiClock {
    /**
     * @param {{ now: () => number, onActivate?: () => void, onDeactivate?: () => void, onTempoChange?: (bpm: number) => void, setTempo: (bpm: number) => void }} opts
     */
    constructor(opts) {
        this._now = opts.now;
        this._onActivate = opts.onActivate || (() => {});
        this._onDeactivate = opts.onDeactivate || (() => {});
        this._onTempoChange = opts.onTempoChange || (() => {});
        this._setTempo = opts.setTempo;

        this.reset();
    }

    /** @returns {boolean} */
    get externalClockActive() {
        return this._externalClockActive;
    }

    /** @returns {number|null} */
    get estimatedBpm() {
        return this._externalTempo;
    }

    /** @returns {number} */
    get tickCount() {
        return this._externalClockTick + 1;
    }

    reset() {
        this._externalClockActive = false;
        this._externalClockTick = -1;
        this._externalClockHistory = [];
        this._externalTempo = null;
        this._lastBroadcastTempo = null;
    }

    /**
     * Feed a single incoming 0xF8 timing-clock tick.
     *
     * @param {number} now - `performance.now()` timestamp of the tick.
     */
    tick(now) {
        const newlyActive = !this._externalClockActive;

        if (newlyActive) {
            this._externalClockTick = -1;
            this._externalClockActive = true;
            this._onActivate();
        }

        this._lastExternalClockAt = now;

        // Keep a rolling window of recent tick timestamps.  We need 25 samples
        // to bound one quarter note (24 intervals), but keeping ~50 gives the
        // DAW a small safety margin and matches worker-midi.js exactly.
        this._externalClockTick++;
        this._externalClockHistory.push(now);
        if (this._externalClockHistory.length > MAX_HISTORY) {
            this._externalClockHistory.shift();
        }

        // 24 MIDI clock ticks span one quarter note.  With 25 timestamps we can
        // measure the duration of exactly one beat.
        if (this._externalClockHistory.length >= MIN_HISTORY) {
            const rawEstimate = estimateBpmFromHistory(this._externalClockHistory);

            if (rawEstimate != null) {
                this._externalTempo = this._externalTempo == null
                    ? rawEstimate
                    : this._externalTempo * SMOOTH_FACTOR + rawEstimate * (1 - SMOOTH_FACTOR);
                const changedEnough = this._lastBroadcastTempo == null
                    || Math.abs(this._externalTempo - this._lastBroadcastTempo) / this._lastBroadcastTempo >= TEMPO_CHANGE_THRESHOLD;
                if (changedEnough) {
                    this._lastBroadcastTempo = this._externalTempo;
                    this._setTempo(this._externalTempo);
                    this._onTempoChange(this._externalTempo);
                }
            }
        }
    }

    /** @returns {number|null} Current smoothed BPM estimate, or null before any measurement. */
    static estimateBpmFromHistory(history) {
        return estimateBpmFromHistory(history);
    }
}

export { ExternalMidiClock, estimateBpmFromHistory };
