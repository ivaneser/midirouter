/* === DAW / Clip UI — LaunchKey controller as main interface === */

export class DAWUI {
    constructor(deviceManager) {
        this.deviceManager = deviceManager;
        this.dawState = null;
        this.padNotes = {}; // `trackIdx-slot` -> note number
        this._initControls();
    }

    _initControls() {
        const modeSelect = document.getElementById('record-mode');
        const tempoInput = document.getElementById('tempo');
        const slotsInput = document.getElementById('slots');
        const sessionModeSelect = document.getElementById('session-record-mode');

        if (modeSelect) {
            modeSelect.addEventListener('change', () => this._send({ type: 'daw-set-record-mode', mode: modeSelect.value }));
        }
        if (tempoInput) {
            tempoInput.addEventListener('change', () => {
                const bpm = parseFloat(tempoInput.value);
                if (bpm) this._send({ type: 'daw-set-tempo', bpm });
            });
        }
        const tapBtn = document.getElementById('tap-tempo');
        if (tapBtn) tapBtn.addEventListener('click', () => {
            this._send({ type: 'daw-tap-tempo' });
            this._log('Tap tempo...');
        });
        if (slotsInput) {
            slotsInput.addEventListener('change', () => this._send({ type: 'daw-set-slots', n: parseInt(slotsInput.value, 10) }));
        }
        if (sessionModeSelect) {
            sessionModeSelect.addEventListener('change', () => this._send({ type: 'daw-set-record-mode', mode: sessionModeSelect.value }));
        }
        const autoChk = document.getElementById('auto-assign');
        if (autoChk) {
            autoChk.addEventListener('change', () => this._send({ type: 'daw-pad-learn', on: autoChk.checked }));
        }
        // Metronome controls
        const metroBtn = document.getElementById('metronome-toggle');
        if (metroBtn) {
            metroBtn.addEventListener('click', () => this._send({ type: 'daw-metronome-toggle' }));
        }
        const metroBeatsInput = document.getElementById('metro-beats');
        if (metroBeatsInput) {
            metroBeatsInput.addEventListener('change', () => {
                const beats = parseInt(metroBeatsInput.value, 10);
                if (beats) this._send({ type: 'daw-metronome-beats-per-measure', bpm: beats });
            });
        }
        // presets
        const saveName = document.getElementById('preset-name');
        const saveBtn = document.getElementById('preset-save');
        if (saveBtn) saveBtn.addEventListener('click', () => {
            const name = (saveName.value || 'default').trim();
            this._send({ type: 'daw-save', name });
        });
        const loadSel = document.getElementById('preset-load');
        if (loadSel) loadSel.addEventListener('change', () => this._send({ type: 'daw-load', name: loadSel.value }));

        // initial request
        this._send({ type: 'daw-get' });
    }

    /** Обработка сообщений от сервера */
    handleMessage(msg) {
        if (msg.type === 'daw_state') {
            this.dawState = msg.payload;
            this._syncControls();
            this._renderGrid();
        } else if (msg.type === 'daw-presets') {
            this._renderPresets(msg.names);
        } else if (msg.type === 'daw_pad_map_list') {
            this._updatePadMap(msg.map, msg.learnMode);
        } else if (msg.type === 'daw_event') {
            this._flashPad(msg.payload);
        }
    }

    _syncControls() {
        const modeSelect = document.getElementById('record-mode');
        const tempoInput = document.getElementById('tempo');
        const slotsInput = document.getElementById('slots');
        const sessionModeSelect = document.getElementById('session-record-mode');
        if (modeSelect) modeSelect.value = this.dawState.recordMode;
        if (tempoInput) tempoInput.value = Math.round(this.dawState.tempo);
        if (slotsInput) slotsInput.value = String(this.dawState.slotsPerTrack);
        if (sessionModeSelect) sessionModeSelect.value = this.dawState.recordMode;
        // Metronome controls
        this._syncMetronomeControls();
    }

    _syncMetronomeControls() {
        const metroBtn = document.getElementById('metronome-toggle');
        const metroBeatsSelect = document.getElementById('metro-beats');
        if (metroBtn) {
            const enabled = this.dawState.metronomeEnabled;
            metroBtn.classList.toggle('active', !!enabled);
            metroBtn.textContent = enabled ? '♫ Metro ON' : '♪ Metro';
        }
        if (metroBeatsSelect && this.dawState.metronomeBeatsPerMeasure != null) {
            metroBeatsSelect.value = String(this.dawState.metronomeBeatsPerMeasure);
        }
    }

    _renderPresets(names) {
        const loadSel = document.getElementById('preset-load');
        if (loadSel) {
            loadSel.innerHTML = '<option value="">-- load --</option>' +
                names.map(n => `<option value="${n}">${n}</option>`).join('');
        }
    }

    _updatePadMap(map, learnMode) {
        this.padNotes = {};
        for (const m of map) this.padNotes[`${m.trackIdx}-${m.slot}`] = m.note;
        const autoChk = document.getElementById('auto-assign');
        if (autoChk) autoChk.checked = learnMode;
        this._renderGrid();
    }

    _renderGrid() {
        this._renderSessionGrid();
    }

    _renderSessionGrid() {
        const grid = document.getElementById('session-grid');
        if (!grid || !this.dawState || !Array.isArray(this.dawState.tracks)) return;
        grid.innerHTML = '';
        const slots = this.dawState.slotsPerTrack || 1;

        for (let t = 0; t < 16; t++) {
            const ch = this.dawState.tracks[t];
            if (!ch) continue;
            const row = document.createElement('div');
            row.className = 'session-row';

            const label = document.createElement('div');
            label.className = 'session-track-label';
            label.textContent = `Ch${ch.channel}`;
            row.appendChild(label);

            for (let s = 0; s < slots; s++) {
                const clip = ch.clips[s];
                const slot = document.createElement('button');
                const key = `${t}-${s}`;
                const note = this.padNotes[key];
                slot.className = 'session-slot' +
                    (ch.playing ? ' playing' : '') +
                    (clip && clip.notes > 0 ? ' has-content' : '') +
                    (note != null ? '' : ' unmapped');
                slot.dataset.track = t;
                slot.dataset.slot = s;
                slot.title = note != null ? `assigned: note ${note}` : 'unmapped';
                slot.textContent = clip && clip.notes > 0 ? `${clip.notes}n` : '';

                slot.addEventListener('click', () => {
                    this._send({ type: 'daw-pad-trigger', trackIdx: t, slot: s });
                });
                row.appendChild(slot);
            }
            grid.appendChild(row);
        }
    }

    _flashPad(evt) {
        if (evt == null || evt.trackIdx == null || evt.slot == null) return;
        const el = document.querySelector(`.daw-pad[data-track="${evt.trackIdx}"][data-slot="${evt.slot}"]`);
        if (!el) return;
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 120);
    }

    _send(msg) {
        if (window.app && window.app.ws && window.app.ws.readyState === WebSocket.OPEN) {
            window.app.ws.send(JSON.stringify(msg));
        }
    }

    _log(msg) {
        const logsDiv = document.getElementById('logs');
        if (!logsDiv) return;
        const time = new Date().toLocaleTimeString();
        const entry = document.createElement('div');
        entry.textContent = '[' + time + '] ' + msg;
        logsDiv.appendChild(entry);
        logsDiv.scrollTop = logsDiv.scrollHeight;
    }
}
