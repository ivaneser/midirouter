/**
 * ============================================================
 *  Precise MIDI Clock (MTC) Generator
 * ============================================================
 *
 * Generates standard MIDI Time Code (MTC): 24 PPQN (pulses per
 * quarter note). Emits `{ type: 'midi', data: number[] }` events
 * through an emit callback so they get routed to all connected
 * MIDI outputs.
 *
 * Messages produced:
 *   Start       0xFA   — sent once at transport start
 *   Continue    0xFB   — sent when resuming from pause
 *   Stop        0xFC   — sent on transport stop
 *   Clock tick  0xF8   — 24 per quarter note, precise to the ms
 *
 * Designed to be driven by DAWEngine's transport so external gear
 * (NTS-1, Craft Synth, Launchkey DAW mode…) stays locked to the
 * same tempo as the audio click track.
 */

const CLOCK_TICK  = 0xF8;   // MIDI timing clock tick
const MIDI_START  = 0xFA;   // MIDI Start
const MIDI_CONT   = 0xFB;   // MIDI Continue
const MIDI_STOP   = 0xFC;   // MIDI Stop

const PULSES_PER_QTR = 24;  // standard MIDI clock resolution

class MidiClock {
    /**
     * @param {object} opts
     * @param {number} [opts.bpm=120]
     * @param {function} opts.emit   — (evt: {type:'midi', data:number[]}) => void
     */
    constructor(opts = {}) {
        this.bpm       = Math.max(20, Math.min(300, Number(opts.bpm) || 120));
        this._emit     = typeof opts.emit === 'function' ? opts.emit : () => {};
        this._playing  = false;
        this._timer    = null;
        this._tickIdx  = 0;       // which tick we're on (resets per start)

        // ms per quarter-note — recomputed whenever bpm changes
        Object.defineProperty(this, '_msPerBeat', {
            get: () => 60000 / this.bpm,
            enumerable: false,
        });
    }

    setTempo(bpm) {
        this.bpm = Math.max(20, Math.min(300, Number(bpm)));
        // If already playing, reschedule with the new interval so the
        // next tick lands at the correct time.
        if (this._playing) {
            this._reschedule();
        }
    }

    /** Send MIDI Start + begin clock ticks */
    start() {
        if (this._playing) return;
        this._playing = true;
        this._tickIdx = 0;
        this._emit({ type: 'midi', data: [MIDI_START] });
        this._reschedule();
    }

    /** Send MIDI Continue + resume ticks */
    continue() {
        if (this._playing) return;
        this._playing = true;
        this._emit({ type: 'midi', data: [MIDI_CONT] });
        this._reschedule();
    }

    /** Send MIDI Stop + halt ticks */
    stop() {
        if (!this._playing) return;
        this._playing = false;
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        this._emit({ type: 'midi', data: [MIDI_STOP] });
    }

    /** Pause without sending stop (for future transport pause support) */
    pause() {
        if (!this._playing) return;
        this._playing = false;
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    // ---- internal ----
    _reschedule() {
        const interval = this._msPerBeat / PULSES_PER_QTR;
        const self = this;
        // Use a tight interval (2x the tick rate) and check the exact
        // boundary each time — this corrects for any JS timer drift.
        if (this._timer) clearInterval(this._timer);
        this._timer = setInterval(() => {
            if (!self._playing) return;
            self._tickIdx++;
            self._emit({ type: 'midi', data: [CLOCK_TICK] });
        }, interval);
    }
}

export { MidiClock, CLOCK_TICK, MIDI_START, MIDI_CONT, MIDI_STOP, PULSES_PER_QTR };
