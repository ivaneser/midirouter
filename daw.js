/* === DAW / Clip Engine ===
 * Turns the router into something like Ableton Live:
 *  - Track  = MIDI channel (1..8)
 *  - Clip   = recorded pattern on a channel (set of note-on/off events with timestamps in beats)
 *  - Pad    = clip trigger: press starts/stops playback (loop <-> stop)
 *  - Post-record mode (what happens when the initial take stops): 'none' (Play),
 *    'overdub' (Overdub)
 *
 * The engine does NOT work with ALSA directly. It only holds state, accepts
 * incoming MIDI events for recording and emits playNote/playOff events for
 * forwarding to the outputs. Timing is computed in beats from the clip start.
 */

import { MidiClock } from './midi-clock.js';

const PPQ = 192;                 // pulses per quarter note (timing)
const DEFAULT_SLOTS_PER_TRACK = 2;
const TRACK_COUNT = 8;           // 8 tracks (MIDI channels 1..8)

// Round note start/duration to the nearest hundredth of a beat.
function roundBeats(x) {
    return Math.round(x * 100) / 100;
}

// ---- Helpers: MIDI byte format (status, data1, data2) ----
function noteOn(channel, note, velocity) {
    return [0x90 | (channel & 0x0f), note & 0x7f, velocity & 0x7f];
}
function noteOff(channel, note) {
    return [0x80 | (channel & 0x0f), note & 0x7f, 0];
}

class DAWEngine {
    constructor(opts = {}) {
        this.tempo = opts.tempo || 120;          // BPM
        this.slotsPerTrack = opts.slotsPerTrack || DEFAULT_SLOTS_PER_TRACK;
        this.recordMode = opts.recordMode || 'none'; // Post-record: 'none' (Play) | 'overdub' (Overdub)
        this.loopLenBeats = 16;             // quarter-note beats in four bars
        // Quantization grid (beats, quarter note = 1) for quantizeClip;
        // default 0.125 (1/32 note). The worker syncs it on daw_quantize_grid.
        this.quantizeGrid = 0.125;

        // tracks[channel(1..8)] -> { channel, clips: [ {notes:[], length:beats} ] }
        this.tracks = [];
        for (let c = 1; c <= TRACK_COUNT; c++) {
            this.tracks.push({ 
                channel: c, 
                channelAssigned: false,
                clips: this._makeClips(),
                armed: false,
                muted: false,
                soloed: false
            });
        }

        // currently playing state per clip: trackIdx -> slotIdx | -1 stopped
        this.clipState = new Array(TRACK_COUNT).fill(-1);

        // recording session state
        // noteStarts: Map<key, NoteStart[]> — FIFO queue of starts per key.
        this.recording = null; // { track, slot, mode, startTime, startBeat, notes, noteStarts:Map }

        // playback scheduler state
        this.playing = false;               // global "transport play"
        this._playLoopTimer = null;
        this._playAnchorTime = 0;           // performance.now() at the start of the current cycle
        this._currentBeat = 0;              // beats of the current cycle [0, loopLen)
        this._lastProgressBeat = null;

        // Metronome / click track
        this._metronomeEnabled = false;
        this._preRecordTwoBarRemainingBeats = null; // two-bar mode after project reset
        this._metronomeTimer = null;
        this._metronomeNote = 57;          // default click note — A3 on off-beats (MIDI 57)
        this._metronomeAccentNote = 60;   // downbeat click — C4 on first beat of measure (MIDI 60)
        this._metronomeBeatsPerMeasure = 4; // 4/4 default
        this._currentMetronomeNote = null;     // sustained pre-record click note being held (legacy)
        this._metronomeAnchorTime = 0;         // anchor for free-running pre-record timing
        this._metronomeNoteOffTimer = null;    // scheduled Note Off timer from _emitMetronomeClick
        this._metronomeBeatInMeasure = -1;     // external-clock beat tracker (F8-driven)

        // Callback fired as soon as a recording session begins. Kept as an
        // extension point; the worker leaves the metronome running for count-in.
        this._onRecordingStarted = () => {};
        this._onMetronomeStart = () => {};
        this._onMetronomeStop = () => {};
        this._onMetronomeTempo = () => {};
        this._onMetronomeMeter = () => {};
        // Session Record is a live controller state; it is intentionally not
        // restored when loading a saved session.
        this.sessionRecording = false;

        this._onEvent = () => {};           // (evt) => void  — callback that forwards MIDI
        this._onProgress = () => {};        // (beat, progress) => void — for the UI

        // === MIDI Clock (MTC) — 24 PPQN, syncs external gear ===
        this._midiClockEnabled = true;
        this._midiClock = new MidiClock({ bpm: this.tempo, emit: (evt) => this._onEvent(evt) });
        this._externalClock = false;

        // Global cycle: true after the first completed recording locks loopLenBeats.
        this._globalCycleLocked = false;
        // External clock: the tick at which the global cycle starts (beat 0). Beats are
        // counted from here without wrapping, so takes that cross a loop boundary keep
        // their timing.
        this._externalCycleOriginTick = 0;

        // Explicit master loop length in bars (UI setting). When set, every clip
        // repeats for exactly this many bars and the global cycle is locked.
        this.masterLoopBars = null;

        // Two-bar count-in flag for first empty-clip recording start.
        this._countInRunning = false;
        this._countInTimer = null;          // pending setTimeout — canceled on stop
        this._countInGeneration = 0;
        this._onCountInComplete = () => {};
    }

    _makeClips() {
        const clips = [];
        for (let s = 0; s < this.slotsPerTrack; s++) {
            clips.push({ notes: [], length: this.loopLenBeats });
        }
        return clips;
    }

    // ---- Transport / tempo ----
    setTempo(bpm) {
        // Reject non-number input (null, strings, booleans, objects...) and
        // non-finite numbers before any state mutation.
        if (typeof bpm !== 'number' || !Number.isFinite(bpm)) {
            return;
        }
        this.tempo = Math.max(20, Math.min(300, bpm));
        // Keep MIDI clock in sync with tempo changes
        if (this._midiClock) this._midiClock.setTempo(this.tempo);
        this._onMetronomeTempo(this.tempo);
    }

    tapTempo(now) {
        const prev = this._lastTap;
        if (prev == null) {
            this._lastTap = now;
            this._tapCount = 1;
            return;
        }
        const interval = (now - prev) / 1000;
        this._tapCount = (this._tapCount || 1) + 1;
        if (this._tapCount >= 2) {
            // average of the last 4 taps
            if (!this._tapBuffer) this._tapBuffer = [];
            this._tapBuffer.push(interval);
            if (this._tapBuffer.length > 4) this._tapBuffer.shift();
            const avg = this._tapBuffer.reduce((a, b) => a + b, 0) / this._tapBuffer.length;
            this.setTempo(60 / avg);
        }
        this._lastTap = now;
    }

    // ---- Metronome ----
    // First take on an empty project while the pre-record metronome is already
    // ticking (after Reset): that metronome grid IS the count-in. Start the count-in
    // on its next bar line, keep the same grid, and begin recording two bars later,
    // so the performer hears exactly one two-bar count-in.
    adoptPreRecordCount(now = performance.now()) {
        if (this.playing || !this.recording || !this._metronomeTimer) return false;
        if (!this._isPreRecordMetronomeMode() || !this._metronomeAnchorTime) return false;
        const spbMs = this._secondsPerBeatMs();
        const bar = Math.max(1, this._metronomeBeatsPerMeasure);
        const sinceAnchor = (now - this._metronomeAnchorTime) / spbMs;
        let nextBar = Math.ceil(sinceAnchor / bar) * bar;
        if ((this._metronomeAnchorTime + nextBar * spbMs) - now < 5) nextBar += bar;
        const countInEnd = this._metronomeAnchorTime + (nextBar + 2 * bar) * spbMs;
        this._preRecordTwoBarRemainingBeats = null;
        this.playing = true;
        this._currentBeat = 0;
        this._playAnchorTime = this._metronomeAnchorTime;
        this._lastProgressBeat = 0;
        this.recording.startTime = countInEnd;
        this._countInRunning = true;
        this._countInGeneration++;
        const generation = this._countInGeneration;
        this._countInTimer = setTimeout(() => {
            if (generation !== this._countInGeneration || !this._countInRunning) return;
            this._countInTimer = null;
            this._countInRunning = false;
            this._onCountInComplete();
        }, Math.max(0, countInEnd - now));
        return true;
    }

    setMetronome(enabled) {
        this._metronomeEnabled = !!enabled;
        if (this._metronomeEnabled) {
            // Do not restart if the metronome is already active.
            if (!this._metronomeTimer) {
                if (this.playing) {
                    this._startMetronome();
                } else if (this._isPreRecordMetronomeMode()) {
                    // Enable pre-record metronome while transport is idle and every
                    // clip is empty — the performer hears tempo before recording.
                    this._metronomeAnchorTime = performance.now();
                    this._startMetronome();
                }
            }
        } else {
            this._stopMetronome();
        }
    }

    setMetronomeNote(note) {
        // Reject non-number input (null, strings, booleans, objects...) and
        // non-finite numbers before any state mutation.
        if (typeof note !== 'number' || !Number.isFinite(note)) {
            return;
        }
        this._metronomeNote = Math.max(0, Math.min(127, note));
    }

    setMetronomeAccentNote(note) {
        // Reject non-number input (null, strings, booleans, objects...) and
        // non-finite numbers before any state mutation.
        if (typeof note !== 'number' || !Number.isFinite(note)) {
            return;
        }
        this._metronomeAccentNote = Math.max(0, Math.min(127, note));
    }

    setMetronomeBeatsPerMeasure(n) {
        // Reject non-number input (null, strings, booleans, objects...) and
        // non-finite numbers before any state mutation.
        if (typeof n !== 'number' || !Number.isFinite(n)) {
            return;
        }
        this._metronomeBeatsPerMeasure = Math.max(1, Math.min(16, n));
        // Keep an explicit master loop measured in bars (not beats): re-derive
        // the shared cycle and clip lengths from the new meter.
        if (this.masterLoopBars != null) {
            this.loopLenBeats = this.masterLoopBars * this._metronomeBeatsPerMeasure;
            for (const track of this.tracks) {
                for (const clip of track.clips) {
                    clip.length = this.loopLenBeats;
                }
            }
        }
        this._onMetronomeMeter(this._metronomeBeatsPerMeasure);
    }

    // ---- MIDI Clock (MTC) ----
    setMidiClock(enabled) {
        this._midiClockEnabled = !!enabled;
        if (!this._midiClock) return;
        if (this._midiClockEnabled && this.playing && !this._externalClock) {
            // If transport is already running, restart clock to apply
            this._midiClock.start();
        } else if (!this._midiClockEnabled) {
            this._midiClock.stop();
        }
    }

    getMidiClockState() {
        return !!this._midiClockEnabled;
    }

    getClockSource() {
        if (this._externalClock) return 'external';
        if (this.playing && this._midiClockEnabled) return 'internal';
        return 'none';
    }

    isMidiClockOutputActive() {
        return this.getClockSource() === 'internal';
    }

    setExternalClock(enabled) {
        this._externalClock = !!enabled;
        if (this._externalClock) {
            this._midiClock?.pause();
        } else if (this.playing && this._midiClockEnabled && this._midiClock) {
            this._midiClock.start();
        }
    }

    _startMetronome() {
        if (this._metronomeTimer) return;
        this._externalClickPrimed = false;
        this._onMetronomeStart(this.tempo, this._metronomeBeatsPerMeasure);

        // When external clock is active the metronome tick is driven from the
        // worker's _handleMidiClock on every F8 tick (24 PPQN).  For internal
        // clock we fall back to a setInterval that follows _playAnchorTime.
        if (this._externalClock) {
            // External-clock path: metronome is driven synchronously from each
            // incoming MIDI clock tick.  The worker calls `this._metronomeTick`
            // on every F8.  We just store the callback and a beat tracker.
            this._metronomeBeatInMeasure = -1;
        } else {
            const self = this;
            let beatInMeasure = -1;

            this._metronomeTimer = setInterval(() => {
                // Pre-record mode ticks even when transport is stopped so the performer
                // hears tempo before recording.  Once playing, only tick while active.
                if (!this.playing && !this._isPreRecordMetronomeMode()) { this._stopMetronome(); return; }

                // In transport mode _playAnchorTime is non-zero and authoritative;
                // fall back to the free-running pre-record anchor when stopped.
                const anchor = this._playAnchorTime || this._metronomeAnchorTime;
                const elapsed = performance.now() - anchor;
                const currentBeatFloat = elapsed / this._secondsPerBeatMs();
                const tickInMeasure = Math.floor(currentBeatFloat % this.loopLenBeats);
                const isAccent = (tickInMeasure % this._metronomeBeatsPerMeasure === 0);

                if (tickInMeasure !== beatInMeasure && tickInMeasure >= 0) {
                    const note = isAccent ? this._metronomeAccentNote : this._metronomeNote;
                    const vel = isAccent ? 100 : 70;
                    this._emitMetronomeClick(note, vel);
                    // Drive the actual audio click for this authoritative beat.
                    if (this._onAudioBeat) {
                        this._onAudioBeat(isAccent);
                    }
                    beatInMeasure = tickInMeasure;
                }
            }, 10);
        }
    }

    /**
     * Called from worker._handleMidiClock on every F8 tick when external clock
     * is active.  Determines the current quarter-note beat and emits a click
     * whenever we cross into a new beat (accent on first beat of each measure).
     */
    _metronomeTick() {
        if (!this.playing) return;
        const cb = this._currentBeat;
        if (cb == null || cb < 0) return;

        const tickInMeasure = Math.floor(cb);
        const isAccent = (tickInMeasure % this._metronomeBeatsPerMeasure === 0);

        if (tickInMeasure !== this._metronomeBeatInMeasure && tickInMeasure >= 0) {
            const note = isAccent ? this._metronomeAccentNote : this._metronomeNote;
            const vel = isAccent ? 100 : 70;
            this._emitMetronomeClick(note, vel);
            if (this._externalClock && this._onAudioBeatAhead) {
                // The audio path has a fixed latency, so the click for this beat was
                // already scheduled one beat earlier (see below). Only the very first
                // beat, which cannot be predicted, is triggered here.
                if (!this._externalClickPrimed && this._onAudioBeat) {
                    this._onAudioBeat(isAccent);
                }
                this._externalClickPrimed = true;
                // Predict the next beat from the estimated tempo and schedule its click.
                const nextAccent = ((tickInMeasure + 1) % this._metronomeBeatsPerMeasure === 0);
                this._onAudioBeatAhead(nextAccent, this._secondsPerBeatMs());
            } else if (this._onAudioBeat) {
                // Drive the actual audio click for this authoritative beat.
                this._onAudioBeat(isAccent);
            }
            this._metronomeBeatInMeasure = tickInMeasure;
        }
    }

    _secondsPerBeatMs() {
        return (60 / this.tempo) * 1000;
    }

    // Emits a single metronome click with a real, bounded duration so the note
    // is not zero-width. Channel 1 only (0-based index 0). The Note Off is
    // scheduled via a timer that _stopMetronome(true) cancels on hard stop.
    _emitMetronomeClick(note, vel) {
        if (this._metronomeNoteOffTimer) {
            clearTimeout(this._metronomeNoteOffTimer);
            this._metronomeNoteOffTimer = null;
        }
        // noteOn uses a 0-based channel index: 0 → MIDI ch 1.
        // Keep an internal event for DAW visualization/debugging. The worker
        // never routes tagged metronome events to MIDI outputs.
        this._onEvent({ type: 'midi', data: noteOn(0, note, vel), _tag: 'metronome' });
        // Remember the sustained note so a hard stop (forceNow) can release it
        // immediately via a proper Note Off in _stopMetronome.
        this._currentMetronomeNote = { note, vel };
        // Bounded fraction of one beat — long enough to be audible as a click,
        // short enough not to blur into the next beat (min 80 ms).
        const durationMs = Math.max(80, this._secondsPerBeatMs() * 0.15);
        this._metronomeNoteOffTimer = setTimeout(() => {
            this._onEvent({ type: 'midi', data: noteOff(0, note), _tag: 'metronome' });
            this._metronomeNoteOffTimer = null;
        }, durationMs);
    }

    _isPreRecordMetronomeMode() {
        if (this._countInRunning) return true;  // explicit flag wins
        // Recording was created with a future startTime — still in count-in delay.
        if (this.recording && this.recording.startTime > performance.now()) return true;
        // While transport is stopped, pre-record mode stays active as long as
        // every clip is empty (the in-flight recording's notes are not committed
        // to the clip until _stopRecording finishes).  This keeps the metronome
        // ticking through the entire count-in window.
        return this.isEmptyProject();
    }

    _secondsPerBeat() {
        return 60 / this.tempo;
    }

    // True while every clip of every track/slot is empty ("empty project").
    // The in-flight recording session does not count — its notes are appended
    // to the clip only when the session stops.
    isEmptyProject() {
        for (let t = 0; t < this.tracks.length; t++) {
            const clips = this.tracks[t].clips;
            for (let s = 0; s < clips.length; s++) {
                if (clips[s] && clips[s].notes && clips[s].notes.length > 0) return false;
            }
        }
        return true;
    }

    _stopMetronome(forceNow) {
        this._onMetronomeStop();
        if (this._metronomeTimer) {
            clearInterval(this._metronomeTimer);
            this._metronomeTimer = null;
        }
        this._metronomeBeatInMeasure = -1;
        this._preRecordTwoBarRemainingBeats = null;
        this._countInRunning = false;
        // Cancel any scheduled Note Off so a hard stop silences the click dead.
        if (this._metronomeNoteOffTimer) {
            clearTimeout(this._metronomeNoteOffTimer);
            this._metronomeNoteOffTimer = null;
        }
        // Immediately release any note still being sustained by the current
        // interval tick so the click stops dead on the user-facing trigger
        // (first empty-clip recording start).  _emitMetronomeClick keeps no
        // lingering state — each tick's Note Off is owned by its timer above.
        if (forceNow && this._currentMetronomeNote != null) {
            const { note } = this._currentMetronomeNote;
            // Tag the forced Note Off for internal event consumers only.
            this._onEvent({ type: 'midi', data: noteOff(0, note), _tag: 'metronome' });
            this._currentMetronomeNote = null;
        }
    }

    // Post-record mode decides what a clip becomes when its initial take stops:
    //   none (Play)   → the take loops
    //   overdub       → the take loops and new notes are recorded on top (layers)
    // An empty clip always starts recording, regardless of the mode.
    setRecordMode(mode) {
        if (['none', 'overdub'].includes(mode)) {
            this.recordMode = mode;
        }
        // Clear count-in on any mode change to avoid stale state.
        this._countInRunning = false;
    }

    // Full reset: all clips of all tracks/slots to zero (empty notes,
    // length 1 bar), close the active recording and clear the playing state.
    // Prepares the session for a new recording "from scratch". After the reset
    // the metronome starts automatically for TWO full bars or until the end of
    // the current bar (limited inside _startMetronome).
    resetAllClips() {
        this._stopRecording();
        this.sessionRecording = false;
        // With an explicit master loop the emptied clips keep the full cycle
        // length so the next take repeats for the selected number of bars.
        const resetLength = this.masterLoopBars != null ? this.loopLenBeats : this._snapToBars(0);
        for (const track of this.tracks) {
            for (const clip of track.clips) {
                clip.notes = [];
                clip.length = resetLength;
            }
        }
        // Clear MIDI channel assignments: the next recording on each track
        // takes its channel from the first incoming note.
        this.tracks.forEach((track, i) => {
            track.channel = i + 1;
            track.channelAssigned = false;
        });
        this.clipState.fill(-1);
        if (!this.playing) {
            // Restart: if the pre-record metronome was already ticking, reset its timer
            // and anchor — the new count runs for exactly two bars.
            this._stopMetronome();
            this._metronomeEnabled = true;
            this._preRecordTwoBarRemainingBeats = Math.max(2, 2 * this._metronomeBeatsPerMeasure);
            this._metronomeAnchorTime = performance.now();
            this._startMetronome();
        }
    }

    setSlotsPerTrack(n) {
        // Reject non-number input (null, strings, booleans, objects...) and
        // non-finite numbers before any state mutation.
        if (typeof n !== 'number' || !Number.isFinite(n)) {
            return;
        }
        const slots = Math.trunc(n);
        this.slotsPerTrack = Math.max(1, Math.min(16, slots));
        for (const track of this.tracks) {
            const base = track.clips.slice(0, this.slotsPerTrack);
            while (base.length < this.slotsPerTrack) {
                base.push({ notes: [], length: this.loopLenBeats });
            }
            track.clips = base;
        }
        // Reset clipState for tracks that no longer have the active slot
        for (let i = 0; i < this.clipState.length; i++) {
            if (this.clipState[i] >= this.slotsPerTrack) {
                this.clipState[i] = -1;
            }
        }
    }

    // Round up to a whole number of bars (minimum one bar).
    // Milliseconds from `now` until the transport cycle reaches `phase` (a beat
    // position inside the global cycle). 0 when transport is stopped or when we are
    // already at that position (a few ms of timer lateness counts as "there").
    msUntilPhase(phase, now = performance.now()) {
        if (!this.playing) return 0;
        const spb = this._secondsPerBeat();
        const cycle = Math.max(1, this.loopLenBeats);
        const cyclePos = ((now - this._playAnchorTime) / 1000 / spb) % cycle;
        const ahead = (((cyclePos - phase) % cycle) + cycle) % cycle; // beats since phase
        if (ahead * spb * 1000 < 5) return 0;
        return (cycle - ahead) * spb * 1000;
    }

    // Whole bars, rounded up. A quarter beat of tolerance absorbs the few ms by
    // which a take's start and the bar grid can differ, so a take of N bars never
    // becomes N+1 bars.
    _snapToBars(beats) {
        const bar = Math.max(1, this._metronomeBeatsPerMeasure);
        return Math.max(bar, Math.ceil((beats - 0.25) / bar) * bar);
    }

    // Explicit master loop length in bars. Locks the shared transport cycle to
    // exactly `bars` measures and resizes every clip so playback repeats for
    // the full master cycle. Returns false on invalid input.
    setMasterLoopBars(bars) {
        // Reject non-number input, non-integers, and out-of-range values before
        // any state mutation.
        if (typeof bars !== 'number' || !Number.isInteger(bars)) return false;
        if (bars < 1 || bars > 64) return false;
        this.masterLoopBars = bars;
        this.loopLenBeats = bars * Math.max(1, this._metronomeBeatsPerMeasure);
        // The explicit setting locks the global cycle: auto-derivation from a
        // first completed recording must not overwrite it.
        this._globalCycleLocked = true;
        for (const track of this.tracks) {
            for (const clip of track.clips) {
                clip.length = this.loopLenBeats;
            }
        }
        return true;
    }

    // ---- Recording ----
    // armed: if a recording is already running on this track/slot (overdub), the new button adds a layer
    armRecording(trackIdx, slot, now, options = {}) {
        const existing = this.tracks[trackIdx].clips[slot];

        if (this.recording && this.recording.track === trackIdx && this.recording.slot === slot) return;
        this._stopRecording();

        // Snapshot project state before arming; count-in selection must reflect
        // the project state at the user's trigger.
        const projectWasEmptyBeforeArm = this.isEmptyProject();

        // An existing take is kept: a recording on it adds layers (overdub).
        // Length is recomputed when recording ends (from the actual span).
        if (existing.notes.length === 0) {
            existing.length = this._snapToBars(0);
        }

        // If there is already a recording on this track/slot, close it first (finish the layer)
        // Requirement: the start of a new clip's recording is aligned to the NEXT
        // bar boundary, and recording beat 0 = 0 (local), not global time. The alignment
        // is done by moving startTime forward to the boundary:
        //   - transport playing → delay = (ceil(curBeat/bar)*bar - curBeat) * spb;
        //     if the press is on a bar boundary (<= 5 ms) — delay = 0;
        //   - transport stopped and track armed → two full bars of count-in;
        //     otherwise recording starts immediately.
        // _beatAt(now) uses startTime, so recording beat 0 matches the start of the
        // next bar. The transport anchor (_playAnchorTime) is NOT changed — the MTC phase
        // of external devices does not shift.
        //
        // Exception: if the transport is ALREADY playing (we did not start it with this
        // press) and we record into another slot, the recording must capture the
        // current live phase — startTime = now, startBeat = live phase.
        const bar = Math.max(1, this._metronomeBeatsPerMeasure);
        let startTime = now;
        let startBeat = 0;
        if (this.playing) {
            const spb = this._secondsPerBeat();
            // When count-in is requested during active transport:
            //   - first pad on empty project → two complete bars (handled by the
            //     caller setting _countInRunning before startTransport).
            //   - subsequent pad on a non-empty project → snap to the NEXT bar
            //     boundary so recording begins immediately after a short orange
            //     pending state.
            if (options.countIn) {
                this._countInRunning = true;
                this._countInGeneration++;
                // First pad on empty project → two full bars of count-in.
                // Subsequent pad on non-empty project → snap to next bar boundary.
                if (!projectWasEmptyBeforeArm) {
                    const curBeat = ((now - this._playAnchorTime) / 1000) / spb;
                    const nextBar = Math.ceil(curBeat / bar) * bar;
                    let delayMs = (nextBar - curBeat) * spb * 1000;
                    // If pressed within 5 ms of the boundary, start immediately.
                    if (delayMs <= 5) delayMs = 0;
                    startTime = now + delayMs;
                } else {
                    // First pad on empty project → two full bars count-in.
                    startTime = now + 2 * bar * spb * 1000;
                }
            } else {
                const curBeat = ((now - this._playAnchorTime) / 1000) / spb;
                // Only align to bar boundary when this pad press is the one that
                // STARTS the transport (first clip in an empty project). In that
                // case the new recording _is_ the cycle and must snap forward to
                // its start. When transport is already running and we record into
                // another slot, capture the live phase within the current global
                // cycle — not from absolute transport start.
                const isTransportStarter = this._globalCycleLocked === false;
                if (isTransportStarter) {
                    const nextBar = Math.ceil(curBeat / bar) * bar;
                    let delayMs = (nextBar - curBeat) * spb * 1000;
                    // If the press is within 5 ms of a bar boundary, start exactly at that moment,
                    // without waiting for the next bar.
                    if (delayMs <= 5) delayMs = 0;
                    // First take while the transport already runs (e.g. external clock):
                    // one two-bar count-in on the bar line, then recording starts.
                    startTime = now + delayMs + 2 * bar * spb * 1000;
                    this._countInRunning = true;
                    this._countInGeneration++;
                } else {
                    // Transport is already running and global cycle is locked:
                    // snap forward to the next bar boundary so each recording
                    // starts from beat 0 of its bar — all clips stay phase-aligned.
                    const curCycleBeat = curBeat % this.loopLenBeats;
                    const nextBar = Math.ceil(curCycleBeat / bar) * bar;
                    startBeat = nextBar;
                    let delayMs = (nextBar - curCycleBeat) * spb * 1000;
                    // If pressed within 5 ms of the boundary, start immediately.
                    if (delayMs <= 5) delayMs = 0;
                    startTime = now + delayMs;
                }
            }
        } else if (options.countIn || this.tracks[trackIdx].armed) {
            // Controller recording can request a two-bar count-in while the
            // transport is stopped. The worker starts transport at pad press.
            startTime = now + 2 * bar * this._secondsPerBeat() * 1000;
        }
        this.recording = {
            track: trackIdx,
            slot,
            mode: this.recordMode,
            startTime,              // recording start time (aligned to a bar)
            startBeat: Math.round(startBeat * 100) / 100,
            // Phase origin of the clip: the transport cycle start that contains the
            // snapped start bar. Clips always play from the cycle start, so notes
            // are stored relative to this (not to startBeat, which is the bar inside
            // the cycle where recording began and would shift the take).
            originBeat: startBeat,
            // Cycle position where this take starts; the clip plays from here.
            phase: ((startBeat % Math.max(1, this.loopLenBeats)) + Math.max(1, this.loopLenBeats)) % Math.max(1, this.loopLenBeats),
            clipWasEmpty: existing.notes.length === 0,
            // Live MIDI clock phase at the moment recording starts. If an external
            // master is active, _beatAt() measures beats from the F8 anchor (updated on every
            // tick), so quantization stays locked to the master's tick grid.
            liveBaseBeat: (this._externalClock && this._playAnchorTime > 0)
                ? ((startTime - this._playAnchorTime) / 1000) / this._secondsPerBeat()
                : null,
            notes: existing.notes,  // write into the same array (overdub accumulates)
            noteStarts: new Map(),  // `note:${channel}:${note}` -> start beat
        };

        // Notify listeners as soon as a recording session exists.  The worker
        // uses this to silence the pre-record metronome on the first empty-clip
        // trigger that begins recording (see worker-midi.js).
        this._onRecordingStarted(this);

        // If transport is already running and we started a count-in from pad
        // press, fire the timer now — startTransport() isn't called in this path
        // so the timer won't be set there. The delay equals startTime - now (the
        // computed bar-boundary offset), which is two full bars for the first-pad
        // empty-project case and a short snap-to-next-bar delay for subsequent pads.
        if (this.playing && this._countInRunning) {
            const self = this;
            let generation = ++self._countInGeneration;
            const countInDelayMs = startTime - now;
            self._countInTimer = setTimeout(() => {
                if (generation !== self._countInGeneration || !self._countInRunning) return;
                self._countInTimer = null;
                self._countInRunning = false;
                self._onCountInComplete();
            }, countInDelayMs);
        }
    }

    // Overdub status after the initial take: a new layer starts at the cycle
    // position where the take ended (atBeat == clip beat 0 modulo clip length),
    // so notes are stored relative to the loop start of the same clip.
    beginOverdubLayer(trackIdx, slot, startTime, atBeat) {
        const clip = this.tracks[trackIdx].clips[slot];
        this.recording = {
            track: trackIdx,
            slot,
            mode: 'overdub',
            startTime,
            startBeat: Math.round(atBeat * 100) / 100,
            originBeat: Math.round(atBeat * 100) / 100,
            phase: 0,
            clipWasEmpty: false,
            liveBaseBeat: (this._externalClock && this._playAnchorTime > 0)
                ? ((startTime - this._playAnchorTime) / 1000) / this._secondsPerBeat()
                : null,
            notes: clip.notes,
            noteStarts: new Map(),
        };
        this._onRecordingStarted(this);
    }

    _stopRecording(endBeat, closeHeldNotesAtEnd = false) {
        if (!this.recording) return;
        const r = this.recording;
        // Close all open note-ons (velocity 0 / noteOff)
        for (const [key, q] of r.noteStarts) {
            const [, , note] = key.split(':');
            for (const start of q) {
                let duration;
                if (closeHeldNotesAtEnd && Number.isFinite(endBeat)) {
                    duration = Math.max(0.125, endBeat - start.beat);
                } else {
                    duration = 0.25;
                }
                r.notes.push({ channel: start.channel, note: +note, velocity: start.velocity, start: roundBeats(start.beat), dur: roundBeats(duration) });
            }
        }
        r.noteStarts.clear();
        // Clip length = length of the recording itself: covers up to the last note,
        // rounded UP to a whole number of bars. Each clip has its own
        // Clip length is its own whole number of bars; it loops on that length from
        // its start phase. The first completed take defines the global cycle.
        // First completed recording: the global cycle is derived from its elapsed
        // span, rounded UP to whole bars of the configured meter (at least one bar).
        if (!this._globalCycleLocked && r.notes.length) {
            const end = typeof endBeat === 'number' ? endBeat : r.startBeat;
            const elapsedSpan = Math.max(0, end - r.startBeat);
            const bar = Math.max(1, this._metronomeBeatsPerMeasure);
            const bars = Math.ceil((elapsedSpan - 0.25) / bar);
            this.loopLenBeats = Math.max(bar, bars * bar);
            this._globalCycleLocked = true;
        }
        if (r.notes.length) {
            const maxEnd = r.notes.reduce((m, n) => Math.max(m, n.start + (n.dur || 0)), 0);
            const end = typeof endBeat === 'number' ? endBeat : r.startBeat;
            const span = Math.max(0, end - r.originBeat);
            if (this.masterLoopBars != null) {
                // Explicit master loop: the take always repeats for the full
                // selected cycle, regardless of note density.
                this.tracks[r.track].clips[r.slot].length = this.loopLenBeats;
            } else {
                const clip = this.tracks[r.track].clips[r.slot];
                const snapped = this._snapToBars(Math.max(maxEnd, span));
                // A layer added on top of a looping clip keeps the clip's loop length.
                const isLayer = r.mode === 'overdub' && !r.clipWasEmpty;
                clip.length = isLayer ? Math.max(clip.length, snapped) : snapped;
                if (r.clipWasEmpty) this.tracks[r.track].clips[r.slot].phase = r.phase;
            }
        }

        this.recording = null;
    }

    // Incoming MIDI event during recording
    recordEvent(statusByte, data1, data2, now) {
        if (!this.recording) return false;
        if (now < this.recording.startTime) return false;
        const inputChannel = (statusByte & 0x0f) + 1;
        const track = this.tracks[this.recording.track];
        if (!track.channelAssigned && (statusByte & 0xf0) === 0x90 && data2 > 0) {
            track.channel = inputChannel;
            track.channelAssigned = true;
        }
        const channel = track.channelAssigned ? track.channel : inputChannel;
        const beat = this._beatAt(now);

        if ((statusByte & 0xf0) === 0x90 && data2 > 0) {
            // noteOn (not zero velocity)
            const key = `note:${channel}:${data1}`;
            let q = this.recording.noteStarts.get(key);
            if (!q) { q = []; this.recording.noteStarts.set(key, q); }
            q.push({ beat, channel, velocity: data2 });
            return true;
        }
        if ((statusByte & 0xf0) === 0x80 || ((statusByte & 0xf0) === 0x90 && data2 === 0)) {
            // noteOff / zero noteOn
            const key = `note:${channel}:${data1}`;
            const q = this.recording.noteStarts.get(key);
            if (q && q.length > 0) {
                const start = q.shift();
                if (q.length === 0) this.recording.noteStarts.delete(key);
                const recorded = {
                    channel, note: data1, velocity: start.velocity,
                    // The minimum duration is applied BEFORE rounding:
                    // 0.125 (minimum) -> 0.13; exact time -> nearest hundredth.
                    // Store relative to the clip start (startBeat = 0), so that
                    // playback always starts at beat 0 regardless of which beat of the
                    // global cycle the recording started on.
                    start: roundBeats(start.beat - this.recording.originBeat), dur: roundBeats(Math.max(0.125, beat - start.beat)),
                };
                this.recording.notes.push(recorded);
                // Overdub: the clip keeps looping while we layer on top. Notify so
                // the newly completed note is scheduled into the live playback and
                // is heard on the next loop (current notes keep playing meanwhile).
                if (this.recording.mode === 'overdub') {
                    this._onNoteRecorded?.(this.recording.track, this.recording.slot, recorded);
                }
            }
            return true;
        }
        return false; // other messages (CC) are ignored for now
    }

    _beatAt(now) {
        const r = this.recording;
        // Stick to the live MIDI clock phase: when an external master is active the
        // beat is measured from the F8-driven anchor (updated on every tick), so
        // quantization snaps to the master's tick grid instead of drifting with
        // wall-clock interpolation.
        if (r.liveBaseBeat != null && this._externalClock && this._playAnchorTime > 0) {
            return r.startBeat + (((now - this._playAnchorTime) / 1000) / this._secondsPerBeat() - r.liveBaseBeat);
        }
        return ((now - r.startTime) / 1000) / this._secondsPerBeat() + r.startBeat;
    }

    _secondsPerBeat() {
        return 60 / this.tempo; // one quarter-note beat
    }

    // Quantize: move start times to the grid (divide by gridSize, round)
    quantizeClip(trackIdx, slot, gridSize = 0.125) {
        const clip = this.tracks[trackIdx].clips[slot];
        for (const n of clip.notes) {
            // snap to grid, then round stored start to nearest hundredth beat.
            n.start = roundBeats(Math.round(n.start / gridSize) * gridSize);
            // start/dur are stored to the nearest hundredth of a beat.
            n.dur = roundBeats(Math.max(0.125, n.dur || 0.25));
        }
        // re-sort and recompute length
        clip.notes.sort((a, b) => a.start - b.start);
        let maxEnd = 0;
        for (const n of clip.notes) {
            maxEnd = Math.max(maxEnd, n.start + n.dur);
        }
        // grow the length only if the notes became longer; keep a whole number of bars
        clip.length = Math.max(this._snapToBars(clip.length), this._snapToBars(maxEnd));
    }

    // ---- Pad trigger: record / play-stop toggle depending on the selected Mode ----
    // returns { action:'play'|'stop'|'record'|'overdub'|'record-stop', track, slot }
    // Scenarios:
    //   1) The recording slot itself is pressed → recording ends and the clip
    //      loops ('record-stop'). With a running transport the initial take of an
    //      Overdub clip continues into the overdub status instead
    //      (see worker-midi.js _scheduleRecordingStop).
    //   2) Empty clip (no notes) → ALWAYS recording ('record'), regardless of
    //      the mode. Any active clip on the same track is stopped
    //      (the worker closes track playback on action 'record'/'overdub').
    //   3) Playing clip → 'stop' in Play; a new overdub layer in Overdub.
    //   4) Stopped non-empty clip → 'play' in Play; an overdub layer in Overdub.
    triggerPad(trackIdx, slot, now, options = {}) {
        const clip = this.tracks[trackIdx]?.clips[slot];
        if (!clip) return { action: 'invalid', track: trackIdx, slot };
        const wasPlaying = this.clipState[trackIdx] === slot;
        const mode = this.recordMode;

        // (1) This slot is being recorded now — finish it and follow the Mode.
        if (this.recording && this.recording.track === trackIdx && this.recording.slot === slot) {
            this._stopRecording(this._beatAt(now));
            this.quantizeClip(trackIdx, slot, this.quantizeGrid ?? 0.125);
            // Play, or the end of an overdub layer: the clip loops from its beat 0.
            this.clipState[trackIdx] = clip.notes.length ? slot : -1;
            return { action: 'record-stop', track: trackIdx, slot };
        }

        // (2) Empty clip — always recording (default), any Mode.
        if (clip.notes.length === 0 && !this._countInRunning) {
            this.armRecording(trackIdx, slot, now, options); // stops any other take
            return { action: 'record', track: trackIdx, slot };
        }

        // (3) Playing clip — stop in Play; a new overdub layer in Overdub.
        if (wasPlaying) {
            if (mode === 'none') {
                this.clipState[trackIdx] = -1;
                return { action: 'stop', track: trackIdx, slot };
            }
            this.armRecording(trackIdx, slot, now, options);
            return { action: mode === 'overdub' ? 'overdub' : 'record', track: trackIdx, slot };
        }

        // (4) Stopped non-empty clip.
        if (mode === 'none') {
            this.clipState[trackIdx] = slot;
            return { action: 'play', track: trackIdx, slot };
        }
        this.armRecording(trackIdx, slot, now, options);
        return { action: mode === 'overdub' ? 'overdub' : 'record', track: trackIdx, slot };
    }

    // ---- Transport play / loop playback ----
    // Track controls
    armTrack(trackIdx) {
        const track = this.tracks[trackIdx];
        if (!track) return;
        track.armed = !track.armed;
        // Reset channel assignment so the next recording auto-detects
        // the MIDI channel from incoming notes.
        track.channelAssigned = false;
    }
    
    muteTrack(trackIdx) {
        const track = this.tracks[trackIdx];
        if (!track) return;
        track.muted = !track.muted;
    }
    
    soloTrack(trackIdx) {
        const track = this.tracks[trackIdx];
        if (!track) return;
        track.soloed = !track.soloed;
    }

    startTransport() {
        if (this.playing) return;
        // Preserve count-in flag through the metronome stop/start cycle so the
        // two-bar timeout fires after transport starts.
        const wasCountIn = this._countInRunning;
        // If the pre-record metronome is already ticking, reset it so that the
        // transport metronome starts from a clean anchor.
        this._stopMetronome();
        if (wasCountIn) { this._countInRunning = true; }
        this.playing = true;
        this._currentBeat = 0;
        this._playAnchorTime = performance.now();
        this._lastProgressBeat = 0;

        // Two-bar count-in: delay the actual recording before capture.
        if (this._countInRunning) {
            const self = this;
            let generation = ++self._countInGeneration;
            const barMs = 2 * self._metronomeBeatsPerMeasure * self._secondsPerBeat() * 1000;
            self._countInTimer = setTimeout(() => {
                // Guard against a canceled/stale timer: the token must still be
                // the current generation AND _countInRunning must not have been
                // cleared by stopTransport(). A late completion after stop is
                // therefore impossible.
                if (generation !== self._countInGeneration || !self._countInRunning) return;
                self._countInTimer = null;
                self._countInRunning = false;
                // Notify worker that count-in is over — it will advance the
                // recording's startTime to begin actual capture.
                self._onCountInComplete();
            }, barMs);
        }

        this._onProgress(0, 0, {
            playing: true,
            barStart: true,
            cycleStart: true,
            meter: this._metronomeBeatsPerMeasure,
        });
        // Tick every half beat for progress + cycle rescheduling
        this._playLoopTimer = setInterval(() => {
            const elapsed = (performance.now() - this._playAnchorTime) / 1000;
            let beat = (elapsed / this._secondsPerBeat()) % this.loopLenBeats;
            if (beat < 0) beat += this.loopLenBeats;
            this._currentBeat = beat;
            const previousBeat = this._lastProgressBeat;
            const cycleStart = previousBeat != null && beat < previousBeat;
            const meter = this._metronomeBeatsPerMeasure;
            const barStart = cycleStart || (previousBeat != null
                && Math.floor(beat / meter) !== Math.floor(previousBeat / meter));
            this._onProgress(beat, beat / this.loopLenBeats, {
                playing: true,
                barStart,
                cycleStart,
                meter,
            });
            this._lastProgressBeat = beat;

            // If the tempo changed, the cycle is already running; correction on the next tick is fine
        }, 50);
        // Start metronome when transport starts
        if (this._metronomeEnabled) {
            this._startMetronome();
        }
        // === Start MIDI clock (MTC) — syncs external gear to same tempo ===
        if (this._midiClockEnabled && !this._externalClock && this._midiClock) {
            this._midiClock.start();
        }
    }
    stopTransport() {
        this.playing = false;
        if (this._playLoopTimer) clearInterval(this._playLoopTimer);
        this._playLoopTimer = null;
        this._currentBeat = 0;
        this._lastProgressBeat = null;
        // Cancel the pending two-bar count-in timer so a late completion callback
        // cannot fire after stop and mutate state (or restart a fresh pad).
        if (this._countInTimer) {
            clearTimeout(this._countInTimer);
            this._countInTimer = null;
            // If a count-in was pending, the recording session was created for
            // a future start — cancel it so daw.recording is null. This only
            // affects in-flight count-in takes, not ordinary active recordings.
            if (this.recording != null) {
                this._stopRecording();
            }
        }

        // For normal non-count-in stops: do NOT touch recording state — the user
        // may still be actively recording into a clip and will stop that session
        // separately via triggerPad or _stopRecording.

        this._countInRunning = false;
        this._onProgress(0, 0, {
            playing: false,
            barStart: false,
            cycleStart: false,
            meter: this._metronomeBeatsPerMeasure,
        });
        // Stop metronome when transport stops
        this._stopMetronome();
        // === Stop MIDI clock — send MIDI Stop to all devices ===
        if (this._midiClock) {
            this._midiClock.stop();
        }
    }

    // Output MIDI bytes to the outputs (forwarded to the worker)
    _emit(byteArray, delayMs) {
        if (delayMs < 0) delayMs = 0;
        setTimeout(() => this._onEvent({ type: 'midi', data: byteArray }), delayMs);
    }

    // Record/stop a specific clip on a pad press (in play mode)
    setClipPlay(trackIdx, slot, now) {
        const clip = this.tracks[trackIdx].clips[slot];
        if (this.clipState[trackIdx] === slot) {
            this.clipState[trackIdx] = -1;
            return false; // stopped
        }
        this.clipState[trackIdx] = slot;
        return true; // playing
    }

    // Get the current beats of the cycle for synchronizing a clip start
    currentBeat() {
        return this._currentBeat;
    }

    getState() {
        const tracks = this.tracks.map((t, i) => ({
            channel: t.channel,
            channelAssigned: t.channelAssigned,
            slotCount: this.slotsPerTrack,
            clips: t.clips.map(c => ({ notes: c.notes.length, length: c.length })),
            playing: this.clipState[i] >= 0,
            activeSlot: this.clipState[i],
            armed: t.armed,
            muted: t.muted,
            soloed: t.soloed,
        }));
        return {
            tempo: this.tempo,
            recordMode: this.recordMode,
            // Top-level transport state (per-track `playing` is clip playback).
            playing: this.playing,
            recording: this.recording ? { track: this.recording.track, slot: this.recording.slot } : null,
            // True while a pad-triggered count-in is pending (recording not
            // started yet) so the UI can blink the armed slot red.
            countInPending: !!(this._countInRunning && this.recording != null),
            slotsPerTrack: this.slotsPerTrack,
            loopLenBeats: this.loopLenBeats,
            masterLoopBars: this.masterLoopBars,
            metronomeEnabled: this._metronomeEnabled,
            sessionRecording: this.sessionRecording,
            midiClockEnabled: this._midiClockEnabled,
            clockSource: this.getClockSource(),
            midiClockOutputActive: this.isMidiClockOutputActive(),
            tracks,
        };
    }

    // ---- Sessions: full serialization/restore (for disk) ----
    // toData() — all clips with notes + settings; transport/recording are not restored
    // on load (a session is "content", not live state).
    toData() {
        return {
            version: 1,
            savedAt: new Date().toISOString(),
            tempo: this.tempo,
            recordMode: this.recordMode,
            slotsPerTrack: this.slotsPerTrack,
            loopLenBeats: this.loopLenBeats,
            masterLoopBars: this.masterLoopBars,
            globalCycleLocked: this._globalCycleLocked,
            midiClockEnabled: this._midiClockEnabled,
            metronome: {
                enabled: this._metronomeEnabled,
                note: this._metronomeNote,
                accentNote: this._metronomeAccentNote,
                beatsPerMeasure: this._metronomeBeatsPerMeasure,
            },
            tracks: this.tracks.map((t) => ({
                channel: t.channel,
                channelAssigned: t.channelAssigned,
                armed: t.armed,
                muted: t.muted,
                soloed: t.soloed,
                clips: t.clips.map((c) => ({
                    length: c.length,
                    phase: c.phase || 0,
                    notes: c.notes.map((n) => ({
                        channel: n.channel, note: n.note, velocity: n.velocity,
                        start: n.start, dur: n.dur,
                    })),
                })),
            })),
        };
    }

    loadData(data) {
        if (!data || !Array.isArray(data.tracks)) {
            throw new Error('invalid session data');
        }
        // A session restores content, never live transport or recording state.
        // Stop schedulers before applying settings so a pre-record timer cannot
        // keep clicking after the loaded session disables the metronome.
        if (this.playing) this.stopTransport();
        this._stopRecording();
        this._stopMetronome(true);
        this.setTempo(Number.isFinite(data.tempo) ? data.tempo : this.tempo);
        this.recordMode = ['none', 'overdub'].includes(data.recordMode)
            ? data.recordMode : 'none';
        if (Number.isInteger(data.slotsPerTrack)) this.setSlotsPerTrack(data.slotsPerTrack);
        if (Number.isFinite(data.loopLenBeats) && data.loopLenBeats >= 1) {
            this.loopLenBeats = Math.ceil(data.loopLenBeats);
        }
        this._globalCycleLocked = !!data.globalCycleLocked;
        // Restore an explicit master loop setting (bars), if persisted.
        this.masterLoopBars = Number.isInteger(data.masterLoopBars) && data.masterLoopBars >= 1
            ? data.masterLoopBars : null;
        this._midiClockEnabled = data.midiClockEnabled !== false;
        const m = data.metronome || {};
        this._metronomeEnabled = !!m.enabled;
        if (Number.isInteger(m.note)) this._metronomeNote = Math.max(0, Math.min(127, m.note));
        if (Number.isInteger(m.accentNote)) this._metronomeAccentNote = Math.max(0, Math.min(127, m.accentNote));
        if (Number.isInteger(m.beatsPerMeasure)) this._metronomeBeatsPerMeasure = Math.max(1, Math.min(16, m.beatsPerMeasure));
        this._onMetronomeMeter(this._metronomeBeatsPerMeasure);

        data.tracks.forEach((td, i) => {
            const track = this.tracks[i];
            if (!track || !td || !Array.isArray(td.clips)) return;
            track.armed = !!td.armed;
            track.muted = !!td.muted;
            track.soloed = !!td.soloed;
            const savedChannel = Number.isInteger(td.channel) && td.channel >= 1 && td.channel <= 16
                ? td.channel : track.channel;
            td.clips.forEach((cd, s) => {
                const clip = track.clips[s];
                if (!clip || !cd || !Array.isArray(cd.notes)) return;
                clip.notes = cd.notes
                    .filter((n) => n && Number.isFinite(n.note) && Number.isFinite(n.start))
                    .map((n) => ({
                        channel: Math.max(1, Math.min(16, Math.trunc(n.channel || 1))),
                        note: Math.max(0, Math.min(127, Math.trunc(n.note))),
                        velocity: Math.max(1, Math.min(127, Math.trunc(n.velocity || 80))),
                        start: roundBeats(Math.max(0, n.start)),
                        dur: roundBeats(Math.max(0.125, Number.isFinite(n.dur) ? n.dur : 0.25)),
                    }));
                // normalize the length to a whole number of bars
                clip.length = this._snapToBars(Number.isFinite(cd.length) ? cd.length : 0);
                clip.phase = Number.isFinite(cd.phase) ? ((cd.phase % Math.max(1, this.loopLenBeats)) + Math.max(1, this.loopLenBeats)) % Math.max(1, this.loopLenBeats) : 0;
            });
            const firstNote = track.clips.flatMap((clip) => clip.notes)[0];
            track.channel = savedChannel;
            track.channelAssigned = typeof td.channelAssigned === 'boolean'
                ? td.channelAssigned
                : !!firstNote;
            // Older session files did not persist a separate assignment flag;
            // their first note's channel is the best track-channel evidence.
            if (typeof td.channelAssigned !== 'boolean' && firstNote) {
                track.channel = firstNote.channel;
            }
        });

        // Loading does not enable transport: all pads are "recorded" but not "playing".
        this.clipState.fill(-1);
        this.sessionRecording = false;
        this._lastProgressBeat = null;
        return this;
    }
}

export { DAWEngine, noteOn, noteOff, PPQ, DEFAULT_SLOTS_PER_TRACK };
