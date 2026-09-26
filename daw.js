/* === DAW / Clip Engine ===
 * Dелает из роутера что-то вроде Ableton Live:
 *  - Track  = MIDI channel (1..16)
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

        // tracks[channel(1..16)] -> { channel, clips: [ {notes:[], length:beats} ] }
        this.tracks = [];
        for (let c = 1; c <= 16; c++) {
            this.tracks.push({ 
                channel: c, 
                clips: this._makeClips(),
                armed: false,
                muted: false,
                soloed: false
            });
        }

        // текущее проигрываемое состояние по клипам: trackIdx -> slotIdx | -1 stopped
        this.clipState = new Array(16).fill(-1);

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
        this._metronomeTimer = null;
        this._metronomeNote = 60;           // default click note (C4)
        this._metronomeAccentNote = 62;     // accent on beat 1 (D4)
        this._metronomeBeatsPerMeasure = 4; // 4/4 default

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
        if (this._metronomeEnabled && this.playing) {
            this._startMetronome();
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
        const self = this;
        let beatInMeasure = -1;

        // When an external master is the selected clock source, the metronome
        // must be phase-aligned to that master's 24 PPQN tick grid — not an
        // independent BPM scheduler. The worker's _handleMidiClock drives
        // _playAnchorTime / _currentBeat on every F8 tick; we use those as the
        // authoritative phase reference and check at each tick boundary.
        this._metronomeTimer = setInterval(() => {
            if (!this.playing) {
                this._stopMetronome();
                return;
            }

            let tickInMeasure, isAccent, elapsed, currentBeatFloat, currentBeatInt;

            if (this._externalClock) {
                // _handleMidiClock updates _currentBeat from every selected
                // master's F8 tick. Reuse that phase directly so tempo changes
                // and non-120 BPM clocks cannot skew metronome/bar alignment.
                tickInMeasure = Math.floor(this._currentBeat);

                // Downbeat = first beat of each measure, not just the start
                // of the (possibly multi-bar) global clip cycle.
                isAccent = (tickInMeasure % this._metronomeBeatsPerMeasure === 0);
            } else {
                // Internal clock: BPM-driven beat scheduler (unchanged path).
                const beatMs = this._secondsPerBeat() * 1000;
                elapsed = performance.now() - this._playAnchorTime;
                currentBeatFloat = (elapsed / 1000) / (beatMs / 1000);
                currentBeatInt = Math.floor(currentBeatFloat % this.loopLenBeats);
                tickInMeasure = currentBeatInt;
                isAccent = (tickInMeasure % this._metronomeBeatsPerMeasure === 0);
            }

            // Если перешли на новый бит — тикаем
            if (tickInMeasure !== beatInMeasure && tickInMeasure >= 0) {
                // Акцент на первую долю такта (по новому биту)
                const note = isAccent ? this._metronomeAccentNote : this._metronomeNote;
                const vel = isAccent ? 100 : 70;
                self._onEvent({ type: 'midi', data: noteOn(1, note, vel) });
                self._onEvent({ type: 'midi', data: noteOff(1, note) });
                beatInMeasure = tickInMeasure;
            }
        }, 50);
    }

    _stopMetronome() {
        if (this._metronomeTimer) {
            clearInterval(this._metronomeTimer);
            this._metronomeTimer = null;
        }
    }

    setRecordMode(mode) {
        if (['none', 'replace', 'overdub'].includes(mode)) {
            this.recordMode = mode;
            // Если выключили запись — снимем armed-состояние
            if (mode === 'none' && this.recording) this._stopRecording();
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
    armRecording(trackIdx, slot, now) {
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
        const startBeat = this.playing
            ? ((now - this._playAnchorTime) / 1000) / this._secondsPerBeat()
            : 0;
        this.recording = {
            track: trackIdx,
            slot,
            mode: this.recordMode,
            startTime: now,         // performance.now() старта
            startBeat: Math.round(startBeat * 100) / 100,
            notes: existing.notes,  // пишем в тот же массив (overdub накапливает)
            noteStarts: new Map(),  // `note:${channel}:${note}` -> beat начала
        };
    }

    _stopRecording(endBeat) {
        if (!this.recording) return;
        const r = this.recording;
        // Закрываем все открытые note-on (velocity 0 / noteOff)
        for (const [key, start] of r.noteStarts) {
            const [, , note] = key.split(':');
            r.notes.push({ channel: start.channel, note: +note, velocity: start.velocity, start: start.beat, dur: 0.25 });
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
        const channel = (statusByte & 0x0f) + 1;
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
                    start: start.beat, dur: Math.max(0.125, beat - start.beat),
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
            n.start = Math.round(n.start / gridSize) * gridSize;
        }
        // пересортируем и пересчитываем length
        clip.notes.sort((a, b) => a.start - b.start);
        let maxEnd = 0;
        for (const n of clip.notes) {
            n.dur = Math.max(0.125, n.dur || 0.25);
            maxEnd = Math.max(maxEnd, n.start + n.dur);
        }
        // растим длину только если ноты стали длиннее; держим целое число тактов
        clip.length = Math.max(this._snapToBars(clip.length), this._snapToBars(maxEnd));
    }

    // ---- Триггер пада: переключение play/stop или запись ----
    // returns { action:'play'|'stop'|'record'|'overdub', track, slot }
    triggerPad(trackIdx, slot, now) {
        const clip = this.tracks[trackIdx]?.clips[slot];
        if (!clip) return { action: 'invalid', track: trackIdx, slot };
        const wasPlaying = this.clipState[trackIdx] === slot;

        // Если в этот же слот сейчас идёт запись — завершаем её
        if (this.recording && this.recording.track === trackIdx && this.recording.slot === slot) {
            this._stopRecording(this._beatAt(now));
            this.quantizeClip(trackIdx, slot);
            this.clipState[trackIdx] = clip.notes.length ? slot : -1;
            return { action: 'record-stop', track: trackIdx, slot };
        }

        // Режим записи -> начинаем запись (replace стирает, overdub добавляет)
        if (this.recordMode !== 'none') {
            this.armRecording(trackIdx, slot, now);
            return { action: this.recordMode === 'overdub' && clip.notes.length > 0 ? 'overdub' : 'record', track: trackIdx, slot };
        }

        // Иначе — play/stop переключение
        if (wasPlaying) {
            this.clipState[trackIdx] = -1;
            return { action: 'stop', track: trackIdx, slot };
        }
        if (!clip.notes.length) return { action: 'empty', track: trackIdx, slot };
        this.clipState[trackIdx] = slot;
        return { action: 'play', track: trackIdx, slot };
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
            midiClockEnabled: this._midiClockEnabled,
            clockSource: this.getClockSource(),
            midiClockOutputActive: this.isMidiClockOutputActive(),
            tracks,
        };
    }
}

export { DAWEngine, noteOn, noteOff, PPQ, DEFAULT_SLOTS_PER_TRACK };
