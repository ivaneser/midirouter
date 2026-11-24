// Evens out the network delay of live notes (a phone or laptop playing over Wi-Fi). Each event carries the time the
// key was pressed on the router's clock (`at`); how long it took to arrive (its age) varies from event to event.
// The smoother holds every event back so that all of them sound the same time after the key press: the delay is
// the target minus the extra delay the event had over the fastest ones seen recently. The cost is a small steady
// delay (the target) instead of an uneven one.
//
// Modes: 'off' (send at once), 'auto' (the target follows the jitter that was seen), or a fixed number of ms.
export const MIN_TARGET_MS = 10;
export const MAX_TARGET_MS = 80;
const MAX_AGE_MS = 2000;         // an event older than this is not trusted (clock jump): sent at once
const BASELINE_DRIFT_MS = 0.5;   // the fastest-arrival baseline creeps up this much per second, to follow route changes
const PEAK_DECAY_PER_S = 0.9;    // a jitter peak fades by this factor per second

export class NetworkSmoother {
    constructor(mode = 'auto') {
        this.setMode(mode);
        this.baseline = null;   // smallest age seen (ms)
        this.baselineAt = 0;
        this.peak = 0;          // recent largest excess over the baseline (ms)
        this.peakAt = 0;
        this.lastDue = 0;       // events keep their order: none is due before the one sent before it
    }

    setMode(mode) {
        const fixed = Number(mode);
        this.mode = mode === 'off' || mode === 'auto' ? mode : Number.isFinite(fixed) && fixed > 0 ? Math.min(MAX_TARGET_MS * 2, fixed) : 'auto';
    }

    get target() {
        if (this.mode === 'off') return 0;
        if (this.mode === 'auto') return Math.max(MIN_TARGET_MS, Math.min(MAX_TARGET_MS, this.peak * 1.25 + 4));
        return this.mode;
    }

    // Milliseconds to hold an event pressed at `at` (router clock), given the router's clock `now` (both Date.now()-style).
    delay(at, now) {
        if (this.mode === 'off' || !Number.isFinite(at)) return 0;
        const age = now - at;
        if (age < -50 || age > MAX_AGE_MS) return 0;
        if (this.baseline === null || age < this.baseline) { this.baseline = age; this.baselineAt = now; }
        else {
            this.baseline += Math.max(0, now - this.baselineAt) / 1000 * BASELINE_DRIFT_MS;
            this.baselineAt = now;
            if (age < this.baseline) this.baseline = age;
        }
        const excess = age - this.baseline;
        this.peak *= Math.pow(PEAK_DECAY_PER_S, Math.max(0, now - this.peakAt) / 1000);
        this.peakAt = now;
        if (excess > this.peak) this.peak = excess;
        let wait = Math.max(0, this.target - excess);
        const due = now + wait;
        if (due < this.lastDue) wait = this.lastDue - now;   // never overtake the event before
        this.lastDue = now + wait;
        return wait;
    }
}
