/* === DAW / Clip Engine ===
 * Dелает из роутера что-то вроде Ableton Live:
 *  - Track  = MIDI channel (1..8)
 *  - Clip   = записанный паттерн на канале (набор note-on/off с таймстампами в битах)
 *  - Pad    = триггер клипа: нажатие включает/выключает проигрывание (loop <-> stop)
 *  - Record modes: 'none' (play), 'replace', 'overdub'
 *
 * Движок НЕ работает с ALSA напрямую — он только держит состояние, принимает
 * входящие MIDI-события для записи и эмитит события playNote/playOff для
 * форварда на выходы. Тайминг считается в битах от начала клипа.
 */

import { MidiClock } from './midi-clock.js';

const PPQ = 192;                 // pulses per quarter note (тайминг)
const DEFAULT_SLOTS_PER_TRACK = 2;
const TRACK_COUNT = 8;           // 8 треков (MIDI-каналы 1..8)

// Округляем время начала/длительность нот до сотых бита (nearest hundredth).
function roundBeats(x) {
    return Math.round(x * 100) / 100;
}

// ---- Вспомогательные: байт-формат MIDI (status, data1, data2) ----
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
        this.recordMode = opts.recordMode || 'none'; // 'none' | 'replace' | 'overdub'
        this.loopLenBeats = 16;             // quarter-note beats in four bars

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

        // текущее проигрываемое состояние по клипам: trackIdx -> slotIdx | -1 stopped
        this.clipState = new Array(TRACK_COUNT).fill(-1);

        // recording session state
        this.recording = null; // { track, slot, mode, startTime, startBeat, notes, noteStarts:Map }

        // playback scheduler state
        this.playing = false;               // глобальный "transport play"
        this._playLoopTimer = null;
        this._playAnchorTime = 0;           // performance.now() начала текущего цикла
        this._currentBeat = 0;              // биты текущего цикла [0, loopLen)
        this._lastProgressBeat = null;

        // Metronome / click track
        this._metronomeEnabled = false;
        this._preRecordOneBarRemainingBeats = null; // one-bar mode after project reset
        this._metronomeTimer = null;
        this._metronomeNote = 57;          // default click note — A3 on off-beats (MIDI 57)
        this._metronomeAccentNote = 60;   // downbeat click — C4 on first beat of measure (MIDI 60)
        this._metronomeBeatsPerMeasure = 4; // 4/4 default
        this._currentMetronomeNote = null;     // sustained pre-record click note being held (legacy)
        this._metronomeAnchorTime = 0;         // anchor for free-running pre-record timing
        this._metronomeNoteOffTimer = null;    // scheduled Note Off timer from _emitMetronomeClick

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

        this._onEvent = () => {};           // (evt) => void  — колбэк для форварда MIDI
        this._onProgress = () => {};        // (beat, progress) => void — для UI

        // === MIDI Clock (MTC) — 24 PPQN, syncs external gear ===
        this._midiClockEnabled = true;
        this._midiClock = new MidiClock({ bpm: this.tempo, emit: (evt) => this._onEvent(evt) });
        this._externalClock = false;

        // Global cycle: true after the first completed recording locks loopLenBeats.
        this._globalCycleLocked = false;
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
            // среднее между последними 4 тапами
            if (!this._tapBuffer) this._tapBuffer = [];
            this._tapBuffer.push(interval);
            if (this._tapBuffer.length > 4) this._tapBuffer.shift();
            const avg = this._tapBuffer.reduce((a, b) => a + b, 0) / this._tapBuffer.length;
            this.setTempo(60 / avg);
        }
        this._lastTap = now;
    }

    // ---- Metronome ----
    setMetronome(enabled) {
        this._metronomeEnabled = !!enabled;
        if (this._metronomeEnabled) {
            // Не перезапускаем, если метроном уже активен.
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
        this._metronomeNote = Math.max(0, Math.min(127, note));
    }

    setMetronomeAccentNote(note) {
        this._metronomeAccentNote = Math.max(0, Math.min(127, note));
    }

    setMetronomeBeatsPerMeasure(n) {
        this._metronomeBeatsPerMeasure = Math.max(1, Math.min(16, n));
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
        this._onMetronomeStart(this.tempo, this._metronomeBeatsPerMeasure);
        const self = this;
        let beatInMeasure = -1;

        // When an external master is the selected clock source, the metronome
        // must be phase-aligned to that master's 24 PPQN tick grid — not an
        // independent BPM scheduler. The worker's _handleMidiClock refreshes
        // _playAnchorTime on every F8 tick; we derive the current cycle beat
        // from it directly instead of relying on the separately polled
        // _currentBeat, which lags by a poll interval.
        this._metronomeTimer = setInterval(() => {
            let tickInMeasure, isAccent;

            if (this.playing) {
                // Normal transport-synced path: stop with the transport.
                if (!this.playing) {
                    this._stopMetronome();
                    return;
                }

                if (this._externalClock) {
                    // Derive the current cycle beat from the external-clock
                    // anchor (_playAnchorTime, refreshed by _handleMidiClock on
                    // every F8 tick) so tempo changes and non-120 BPM clocks
                    // cannot skew metronome/bar alignment. Floor for the
                    // beat-transition/accent logic below.
                    const elapsed = performance.now() - this._playAnchorTime;
                    const currentBeatFloat = (elapsed / this._secondsPerBeatMs()) % this.loopLenBeats;
                    tickInMeasure = Math.floor(currentBeatFloat);

                    // Downbeat = first beat of each measure, not just the start
                    // of the (possibly multi-bar) global clip cycle.
                    isAccent = (tickInMeasure % this._metronomeBeatsPerMeasure === 0);
                } else {
                    // Internal clock: BPM-driven beat scheduler (unchanged path).
                    const elapsed = performance.now() - this._playAnchorTime;
                    const currentBeatFloat = elapsed / this._secondsPerBeatMs();
                    tickInMeasure = Math.floor(currentBeatFloat % this.loopLenBeats);
                    isAccent = (tickInMeasure % this._metronomeBeatsPerMeasure === 0);
                }

                // Якщо перешли на новый бит — тикаем
                if (tickInMeasure !== beatInMeasure && tickInMeasure >= 0) {
                    // Акцент на первую долю такта (по новому биту)
                    const note = isAccent ? this._metronomeAccentNote : this._metronomeNote;
                    const vel = isAccent ? 100 : 70;
                    this._emitMetronomeClick(note, vel);
                    beatInMeasure = tickInMeasure;
                }
            } else if (this._isPreRecordMetronomeMode()) {
                // Pre-record mode: metronome is enabled but transport is not
                // running and every clip is empty.  Emit quarter-note pulses so
                // the performer hears tempo while recording is still idle.
                const elapsed = performance.now() - this._metronomeAnchorTime;
                const currentBeatFloat = elapsed / this._secondsPerBeatMs();
                tickInMeasure = Math.floor(currentBeatFloat);
                isAccent = (tickInMeasure % this._metronomeBeatsPerMeasure === 0);

                // One-bar mode (after project reset): play exactly one full bar,
                // then stop on its own.
                if (this._preRecordOneBarRemainingBeats != null) {
                    if (tickInMeasure >= this._metronomeBeatsPerMeasure ||
                        this._preRecordOneBarRemainingBeats <= 0) {
                        this._stopMetronome();
                        return;
                    }
                }

                if (tickInMeasure !== beatInMeasure && tickInMeasure >= 0) {
                    const note = isAccent ? this._metronomeAccentNote : this._metronomeNote;
                    const vel = isAccent ? 100 : 70;
                    this._emitMetronomeClick(note, vel);
                    beatInMeasure = tickInMeasure;

                    if (this._preRecordOneBarRemainingBeats != null) {
                        this._preRecordOneBarRemainingBeats -= 1;
                        // Let the last click's own Note Off timer finish before
                        // tearing the scheduler down.
                        const waitMs = Math.max(80, this._secondsPerBeatMs() * 0.15);
                        setTimeout(() => { this._stopMetronome(); }, waitMs + 20);
                    }
                }
            }
        }, 10);
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
        // Pre-record metronome runs only while transport is idle and every clip
        // on every track is empty — i.e. no recording has begun yet.
        if (this.recording) return false;
        return this.isEmptyProject();
    }

    // True while every clip of every track/slot is empty ("пустой проект").
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
        this._preRecordOneBarRemainingBeats = null;
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

    // Mode определяет, во что переходит клип ПОСЛЕ окончания записи:
    //   none (Play)   → запускать воспроизведение записи
    //   overdub       → продолжать запись поверх дубля (слои)
    //   replace       → остаться остановленным (дубль сохранён, повторное
    //                   нажатие начнёт новую запись поверх старой)
    // Пустой клип всегда начинает запись независимо от Mode.
    setRecordMode(mode) {
        if (['none', 'replace', 'overdub'].includes(mode)) {
            this.recordMode = mode;
        }
    }

    // Полный сброс: все клипы всех треков/слотов в ноль (пустые ноты,
    // длина 1 такт), закрыть активную запись и снять playing-состояние.
    // Готовит сессию для новой записи "с чистого листа". После обнуления
    // метроном автоматически запускается на ОДИН полный такт или до
    // завершения этого такта (ограничение внутри _startMetronome).
    resetAllClips() {
        this._stopRecording();
        this.sessionRecording = false;
        for (const track of this.tracks) {
            for (const clip of track.clips) {
                clip.notes = [];
                clip.length = this._snapToBars(0);
            }
        }
        this.clipState.fill(-1);
        if (!this.playing) {
            // Перезапуск: если pre-record метроном уже тикал, сбрасываем
            // его таймер и якорь — новый счётчик идёт ровно на один такт.
            this._stopMetronome();
            this._metronomeEnabled = true;
            this._preRecordOneBarRemainingBeats = Math.max(1, this._metronomeBeatsPerMeasure);
            this._metronomeAnchorTime = performance.now();
            this._startMetronome();
        }
    }

    setSlotsPerTrack(n) {
        this.slotsPerTrack = Math.max(1, Math.min(16, Math.trunc(n)));
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

    // Округляем вверх до целого числа тактов (минимум один такт).
    _snapToBars(beats) {
        const bar = Math.max(1, this._metronomeBeatsPerMeasure);
        return Math.max(bar, Math.ceil(beats / bar) * bar);
    }

    // ---- Запись ----
    // armed: если на треке уже идёт запись в этом слоте (overdub), новая кнопка добавляет слой
    armRecording(trackIdx, slot, now, options = {}) {
        const existing = this.tracks[trackIdx].clips[slot];

        if (this.recording && this.recording.track === trackIdx && this.recording.slot === slot) return;
        this._stopRecording();

        // Replace: стираем старый клип. Overdub: если уже записан — продолжаем (добавляем).
        // Длина пересчитывается при завершении записи (по фактическому охвату).
        if (this.recordMode === 'replace') {
            existing.notes = [];
            existing.length = this._snapToBars(0);
        } else if (existing.notes.length === 0) {
            // Overdub on empty clip: initialize but don't clear (preserve track identity)
            existing.length = this._snapToBars(0);
        }

        // Если уже запись на этом треке/слоте — сначала её закрываем (завершаем слой)
        // Требование: начало записи нового клипа выравнивается по СЛЕДУЮЩЕЙ
        // границе такта (bar), но beat 0 записи = 0 (локально), а не глобальное
        // время. Выравнивание достигается сдвигом startTime вперёд до границы:
        //   - транспорт играет → delay = (ceil(curBeat/bar)*bar - curBeat) * spb;
        //     если нажатие совпало с границей бара (<= 5 мс) — delay = 0;
        //   - транспорт стоит и трек armed → count-in на один полный такт;
        //     иначе запись начинается немедленно.
        // _beatAt(now) использует startTime, поэтому beat 0 записи
        // соответствует моменту начала следующего такта. Якорь транспорта
        // (_playAnchorTime) НЕ трогаем — фаза MTC внешних устройств не сдвигается.
        //
        // Исключение: если транспорт УЖЕ играет (не мы его запустили с этого
        // нажатия) и мы пишем в другой слот, запись должна захватывать
        // текущую живую фазу — startTime = now, startBeat = live phase.
        const bar = Math.max(1, this._metronomeBeatsPerMeasure);
        let startTime = now;
        let startBeat = 0;
        if (this.playing) {
            const spb = this._secondsPerBeat();
            const curBeat = ((now - this._playAnchorTime) / 1000) / spb;
            // Only align to bar boundary when this pad press is the one that
            // STARTS the transport (first clip in an empty project). In that
            // case the new recording _is_ the cycle and must snap forward to
            // its start. When transport is already running and we record into
            // another slot, capture the live phase immediately.
            const isTransportStarter = this._globalCycleLocked === false;
            if (isTransportStarter) {
                const nextBar = Math.ceil(curBeat / bar) * bar;
                let delayMs = (nextBar - curBeat) * spb * 1000;
                // Если нажатие совпало с границей бара (<= 5 мс до неё) — старт
                // именно в этот момент, без ожидания следующего такта.
                if (delayMs <= 5) delayMs = 0;
                startTime = now + delayMs;
            } else {
                // Transport is already running: capture the live global phase
                // so recorded notes reflect their real position in the cycle.
                startBeat = curBeat;
            }
        } else if (options.countIn || this.tracks[trackIdx].armed) {
            // Controller recording can request a one-bar count-in while the
            // transport is stopped. The worker starts transport at pad press.
            startTime = now + bar * this._secondsPerBeat() * 1000;
        }
        this.recording = {
            track: trackIdx,
            slot,
            mode: this.recordMode,
            startTime,              // момент начала записи (выровнен по бару)
            startBeat: Math.round(startBeat * 100) / 100,
            notes: existing.notes,  // пишем в тот же массив (overdub накапливает)
            noteStarts: new Map(),  // `note:${channel}:${note}` -> beat начала
        };

        // Notify listeners as soon as a recording session exists.  The worker
        // uses this to silence the pre-record metronome on the first empty-clip
        // trigger that begins recording (see worker-midi.js).
        this._onRecordingStarted(this);
    }

    _stopRecording(endBeat, closeHeldNotesAtEnd = false) {
        if (!this.recording) return;
        const r = this.recording;
        // Закрываем все открытые note-on (velocity 0 / noteOff)
        for (const [key, start] of r.noteStarts) {
            const [, , note] = key.split(':');
            const duration = closeHeldNotesAtEnd && Number.isFinite(endBeat)
                ? Math.max(0.125, endBeat - start.beat)
                : 0.25;
            r.notes.push({ channel: start.channel, note: +note, velocity: start.velocity, start: roundBeats(start.beat), dur: roundBeats(duration) });
        }
        r.noteStarts.clear();
        // Длина клипа = длительность самой записи: охват до последней ноты,
        // округлённый ВВЕРХ до целого числа тактов. Каждый клип имеет собственную
        // длину (разные клипы могут иметь разное целое число тактов).
        if (r.notes.length) {
            const maxEnd = r.notes.reduce((m, n) => Math.max(m, n.start + (n.dur || 0)), 0);
            const end = typeof endBeat === 'number' ? endBeat : r.startBeat;
            const span = Math.max(0, end - r.startBeat);
            this.tracks[r.track].clips[r.slot].length = this._snapToBars(Math.max(maxEnd, span));
        }

        // First completed recording: derive a shared global cycle from the elapsed
        // recording span (not just note density), rounded UP to whole 4/4 bars with
        // a minimum of one bar (4 beats). This drives only the transport display
        // progress; clip playback loops on each clip's own length.
        if (!this._globalCycleLocked && r.notes.length) {
            const end = typeof endBeat === 'number' ? endBeat : r.startBeat;
            const elapsedSpan = Math.max(0, end - r.startBeat);
            const bars = Math.ceil(elapsedSpan / 4);
            const globalCycleBeats = Math.max(4, bars * 4);
            this.loopLenBeats = globalCycleBeats;
            this._globalCycleLocked = true;
        }

        this.recording = null;
    }

    // Входящее MIDI-событие во время записи
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
            // noteOn (не zero-velocity)
            this.recording.noteStarts.set(`note:${channel}:${data1}`, { beat, channel, velocity: data2 });
            return true;
        }
        if ((statusByte & 0xf0) === 0x80 || ((statusByte & 0xf0) === 0x90 && data2 === 0)) {
            // noteOff / zero noteOn
            const key = `note:${channel}:${data1}`;
            const start = this.recording.noteStarts.get(key);
            if (start != null) {
                this.recording.noteStarts.delete(key);
                this.recording.notes.push({
                    channel, note: data1, velocity: start.velocity,
                    // Минимальная длительность применяется ПЕРЕД округлением:
                    // 0.125 (минимум) -> 0.13; точное время -> nearest hundredth.
                    start: roundBeats(start.beat), dur: roundBeats(Math.max(0.125, beat - start.beat)),
                });
            }
            return true;
        }
        return false; // прочие сообщения (CC) сейчас игнорируем
    }

    _beatAt(now) {
        return ((now - this.recording.startTime) / 1000) / this._secondsPerBeat() + this.recording.startBeat;
    }

    _secondsPerBeat() {
        return 60 / this.tempo; // one quarter-note beat
    }

    // Quantize: сдвигаем времена начала к решетке (делим на gridSize, округляем)
    quantizeClip(trackIdx, slot, gridSize = 0.125) {
        const clip = this.tracks[trackIdx].clips[slot];
        for (const n of clip.notes) {
            // snap to grid, then round stored start to nearest hundredth beat.
            n.start = roundBeats(Math.round(n.start / gridSize) * gridSize);
            // start/dur хранятся с точностью до сотых бита.
            n.dur = roundBeats(Math.max(0.125, n.dur || 0.25));
        }
        // пересортируем и пересчитываем length
        clip.notes.sort((a, b) => a.start - b.start);
        let maxEnd = 0;
        for (const n of clip.notes) {
            maxEnd = Math.max(maxEnd, n.start + n.dur);
        }
        // растим длину только если ноты стали длиннее; держим целое число тактов
        clip.length = Math.max(this._snapToBars(clip.length), this._snapToBars(maxEnd));
    }

    // ---- Триггер пада: запись / play-stop toggle по выбранному Mode ----
    // returns { action:'play'|'stop'|'record'|'overdub'|'record-stop'|'record-stop-stopped', track, slot }
    // Сценарии:
    //   1) Нажат именно записывающийся слот → запись завершается, и клип
    //      переходит в состояние выбранного Mode:
    //        none(Play) → 'record-stop' (начинает воспроизведение),
    //        overdub    → 'record-stop-stopped' (останавливается; слои
    //                     сохраняются, следующее нажатие добавит слой),
    //        replace    → 'record-stop-stopped' (останавливается; дубль
    //                     сохранён, следующее нажатие запишет заново).
    //   2) Пустой клип (нет нот) → ВСЕГДА запись ('record'), независимо от
    //      Mode. При этом активный клип на этом же треке останавливается
    //      (worker закрывает плейбэк трека при action 'record'/'overdub').
    //   3) Играющий клип → 'stop' (в Play-режиме) или новая запись поверх
    //      (в Replace/Overdub).
    //   4) Остановленный непустой клип → 'play' в Play-режиме; в
    //      Replace/Overdub — новая запись (replace стирает старый дубль,
    //      overdub добавляет поверх).
    triggerPad(trackIdx, slot, now, options = {}) {
        const clip = this.tracks[trackIdx]?.clips[slot];
        if (!clip) return { action: 'invalid', track: trackIdx, slot };
        const wasPlaying = this.clipState[trackIdx] === slot;
        const mode = this.recordMode;

        // (1) В этот же слот сейчас идёт запись — завершаем и ходим по Mode.
        if (this.recording && this.recording.track === trackIdx && this.recording.slot === slot) {
            this._stopRecording(this._beatAt(now));
            this.quantizeClip(trackIdx, slot);
            if (mode === 'none') {
                // Play: начинаем воспроизведение только что записанного дубля
                this.clipState[trackIdx] = clip.notes.length ? slot : -1;
                return { action: 'record-stop', track: trackIdx, slot };
            }
            // Overdub/Replace: клип останавливается (слои/дубль сохранены).
            // Следующее нажатие в Overdub добавит слой, в Replace — новый дубль.
            this.clipState[trackIdx] = -1;
            return { action: 'record-stop-stopped', track: trackIdx, slot };
        }

        // (2) Пустой клип — всегда запись (дефолт), любой Mode.
        if (clip.notes.length === 0) {
            this.armRecording(trackIdx, slot, now, options); // stops any other take
            return { action: 'record', track: trackIdx, slot };
        }

        // (3) Играющий клип — stop в Play, заново/поверх запись в Replace/Overdub.
        if (wasPlaying) {
            if (mode === 'none') {
                this.clipState[trackIdx] = -1;
                return { action: 'stop', track: trackIdx, slot };
            }
            this.armRecording(trackIdx, slot, now, options);
            return { action: mode === 'overdub' ? 'overdub' : 'record', track: trackIdx, slot };
        }

        // (4) Остановленный непустой клип.
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
        // Если pre-record метроном уже тикает — сбрасываем его, чтобы
        // транспортный метроном стартовал с чистого якоря.
        this._stopMetronome();
        this.playing = true;
        this._currentBeat = 0;
        this._playAnchorTime = performance.now();
        this._lastProgressBeat = 0;
        this._onProgress(0, 0, {
            playing: true,
            barStart: true,
            cycleStart: true,
            meter: this._metronomeBeatsPerMeasure,
        });
        // Тик раз в половину бита для прогресса + перепланирования цикла
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

            // Если темп поменялся — цикл уже идёт, коррекция на след. тике ок
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

    // Выход MIDI-байт на выходы (форвард в worker)
    _emit(byteArray, delayMs) {
        if (delayMs < 0) delayMs = 0;
        setTimeout(() => this._onEvent({ type: 'midi', data: byteArray }), delayMs);
    }

    // Записать/остановить конкретный клип по нажатию пада (в play-режиме)
    setClipPlay(trackIdx, slot, now) {
        const clip = this.tracks[trackIdx].clips[slot];
        if (this.clipState[trackIdx] === slot) {
            this.clipState[trackIdx] = -1;
            return false; // stopped
        }
        this.clipState[trackIdx] = slot;
        return true; // playing
    }

    // Получить текущие биты цикла для синхронизации старта клипа
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
            slotsPerTrack: this.slotsPerTrack,
            loopLenBeats: this.loopLenBeats,
            metronomeEnabled: this._metronomeEnabled,
            sessionRecording: this.sessionRecording,
            midiClockEnabled: this._midiClockEnabled,
            clockSource: this.getClockSource(),
            midiClockOutputActive: this.isMidiClockOutputActive(),
            tracks,
        };
    }

    // ---- Сессии: полное сериализация/восстановление (для диска) ----
    // toData() — все клипы с нотами + настройки;transport/запись не восстанавливаются
    // при загрузке (сессия — это "контент", а не live-состояние).
    toData() {
        return {
            version: 1,
            savedAt: new Date().toISOString(),
            tempo: this.tempo,
            recordMode: this.recordMode,
            slotsPerTrack: this.slotsPerTrack,
            loopLenBeats: this.loopLenBeats,
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
        this.recordMode = ['none', 'replace', 'overdub'].includes(data.recordMode)
            ? data.recordMode : 'none';
        if (Number.isInteger(data.slotsPerTrack)) this.setSlotsPerTrack(data.slotsPerTrack);
        if (Number.isFinite(data.loopLenBeats) && data.loopLenBeats >= 1) {
            this.loopLenBeats = Math.ceil(data.loopLenBeats);
        }
        this._globalCycleLocked = !!data.globalCycleLocked;
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
                // нормализуем длину до целого числа тактов
                clip.length = this._snapToBars(Number.isFinite(cd.length) ? cd.length : 0);
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

        // Загрузка не включается transport: все пэды — "recorded", но не "playing".
        this.clipState.fill(-1);
        this.sessionRecording = false;
        this._lastProgressBeat = null;
        return this;
    }
}

export { DAWEngine, noteOn, noteOff, PPQ, DEFAULT_SLOTS_PER_TRACK };
