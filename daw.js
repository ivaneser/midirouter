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

const PPQ = 192;                 // pulses per quarter note (тайминг)
const DEFAULT_SLOTS_PER_TRACK = 1;

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
        this.loopLenBeats = 16;             // длина цикла в битах
        this._playLoopTimer = null;
        this._playAnchorTime = 0;           // performance.now() начала текущего цикла
        this._currentBeat = 0;              // биты текущего цикла [0, loopLen)

        // Metronome / click track
        this._metronomeEnabled = false;
        this._metronomeTimer = null;
        this._metronomeNote = 60;           // default click note (C4)
        this._metronomeAccentNote = 62;     // accent on beat 1 (D4)
        this._metronomeBeatsPerMeasure = 4; // 4/4 default

        this._onEvent = () => {};           // (evt) => void  — колбэк для форварда MIDI
        this._onProgress = () => {};        // (beat, progress) => void — для UI
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
            this.tempo = Math.max(20, Math.min(300, 60 / avg));
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

    _startMetronome() {
        if (this._metronomeTimer) return;
        const self = this;
        let beatInMeasure = 0;

        // Метроном тикает синхронно с транспортом — каждые 50ms проверяем
        // и тикаем когда _currentBeat пересекает границу бита
        this._metronomeTimer = setInterval(() => {
            if (!this.playing) {
                this._stopMetronome();
                return;
            }
            const beatMs = (60 / this.tempo / 4) * 1000;
            const elapsed = performance.now() - this._playAnchorTime;
            const currentBeatFloat = (elapsed / 1000) / (beatMs / 1000);
            const currentBeatInt = Math.floor(currentBeatFloat % this.loopLenBeats);
            
            // Если перешли на новый бит — тикаем
            if (currentBeatInt !== beatInMeasure && currentBeatInt >= 0) {
                // Акцент на первую долю такта (по новому биту)
                const isAccent = (currentBeatInt % this._metronomeBeatsPerMeasure === 0);
                const note = isAccent ? this._metronomeAccentNote : this._metronomeNote;
                const vel = isAccent ? 100 : 70;
                self._onEvent({ type: 'midi', data: noteOn(1, note, vel) });
                self._onEvent({ type: 'midi', data: noteOff(1, note) });
                beatInMeasure = currentBeatInt;
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
        this.slotsPerTrack = Math.max(1, Math.min(16, n));
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

    // ---- Запись ----
    // armed: если на треке уже идёт запись в этом слоте (overdub), новая кнопка добавляет слой
    armRecording(trackIdx, slot, now) {
        const channel = trackIdx + 1;
        const existing = this.tracks[trackIdx].clips[slot];

        // Replace: стираем старый клип. Overdub: если уже записан — продолжаем (добавляем).
        if (this.recordMode === 'replace') {
            existing.notes = [];
            existing.length = this.loopLenBeats;
        } else if (existing.notes.length === 0) {
            // Overdub on empty clip: initialize but don't clear (preserve track identity)
            existing.length = this.loopLenBeats;
        }

        // Если уже запись на этом треке/слоте — сначала её закрываем (завершаем слой)
        if (this.recording && this.recording.track === trackIdx && this.recording.slot === slot) {
            return;
        }
        this._stopRecording();

        this.recording = {
            track: trackIdx,
            slot,
            mode: this.recordMode,
            startTime: now,         // performance.now() старта
            startBeat: this._currentBeat, // биты, на которых начали (для продолжения цикла)
            notes: existing.notes,  // пишем в тот же массив (overdub накапливает)
            noteStarts: new Map(),  // `note:${channel}:${note}` -> beat начала
        };
    }

    _stopRecording() {
        if (!this.recording) return;
        const r = this.recording;
        // Закрываем все открытые note-on (velocity 0 / noteOff)
        for (const [key, startBeat] of r.noteStarts) {
            const [, , note] = key.split(':');
            r.notes.push({ channel: r.track + 1, note: +note, velocity: 0, start: startBeat, dur: 0.25 });
        }
        r.noteStarts.clear();
        // нормализуем длину до кратной биту цикла
        if (r.notes.length) {
            const maxEnd = r.notes.reduce((m, n) => Math.max(m, n.start + (n.dur || 0)), 0);
            r.length = Math.ceil(Math.max(this.loopLenBeats, maxEnd));
        }
        this.recording = null;
    }

    // Входящее MIDI-событие во время записи
    recordEvent(statusByte, data1, data2, now) {
        if (!this.recording) return false;
        const channel = statusByte & 0x0f;
        const beat = this._beatAt(now);

        if ((statusByte & 0xf0) === 0x90 && data2 > 0) {
            // noteOn (не zero-velocity)
            this.recording.noteStarts.set(`note:${channel}:${data1}`, beat);
            return true;
        }
        if ((statusByte & 0xf0) === 0x80 || ((statusByte & 0xf0) === 0x90 && data2 === 0)) {
            // noteOff / zero noteOn
            const key = `note:${channel}:${data1}`;
            const startBeat = this.recording.noteStarts.get(key);
            if (startBeat != null) {
                this.recording.noteStarts.delete(key);
                this.recording.notes.push({
                    channel, note: data1, velocity: 80,
                    start: startBeat, dur: Math.max(0.125, beat - startBeat),
                });
            }
            return true;
        }
        return false; // прочие сообщения (CC) сейчас игнорируем
    }

    _beatAt(now) {
        return ((now - this.recording.startTime) / 1000) * this._secondsPerBeat() + this.recording.startBeat;
    }

    _secondsPerBeat() {
        return 60 / this.tempo / 4; // на бит (1/4 ноты)
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
        for (let i = 0; i < clip.notes.length; i++) {
            const n = clip.notes[i];
            const nextStart = clip.notes[i + 1] ? clip.notes[i + 1].start : Infinity;
            n.dur = Math.max(0.125, Math.min(n.dur || 0.25, nextStart - n.start));
            maxEnd = Math.max(maxEnd, n.start + n.dur);
        }
        clip.length = Math.ceil(Math.max(this.loopLenBeats, maxEnd));
    }

    // ---- Триггер пада: переключение play/stop или запись ----
    // returns { action:'play'|'stop'|'record'|'overdub', track, slot }
    triggerPad(trackIdx, slot, now) {
        const clip = this.tracks[trackIdx].clips[slot];
        const wasPlaying = this.clipState[trackIdx] === slot;

        // Если в этот же слот сейчас идёт запись — завершаем её
        if (this.recording && this.recording.track === trackIdx && this.recording.slot === slot) {
            this._stopRecording();
            this.quantizeClip(trackIdx, slot);
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
        const beatMs = (60 / this.tempo / 4) * 1000;
        // Тик раз в половину бита для прогресса + перепланирования цикла
        this._playLoopTimer = setInterval(() => {
            const elapsed = (performance.now() - this._playAnchorTime) / 1000;
            let beat = (elapsed * 1000 / beatMs) % this.loopLenBeats;
            if (beat < 0) beat += this.loopLenBeats;
            this._currentBeat = beat;
            this._onProgress(beat, beat / this.loopLenBeats);

            // Если темп поменялся — цикл уже идёт, коррекция на след. тике ок
        }, 50);
        // Start metronome when transport starts
        if (this._metronomeEnabled) {
            this._startMetronome();
        }
    }

    stopTransport() {
        this.playing = false;
        if (this._playLoopTimer) clearInterval(this._playLoopTimer);
        this._playLoopTimer = null;
        this._currentBeat = 0;
        // Stop metronome when transport stops
        this._stopMetronome();
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
            tracks,
        };
    }
}

export { DAWEngine, noteOn, noteOff, PPQ, DEFAULT_SLOTS_PER_TRACK };
