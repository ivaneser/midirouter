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
        const autoChk = document.getElementById('auto-assign');
        if (autoChk) {
            autoChk.addEventListener('change', () => this._send({ type: 'daw-pad-learn', on: autoChk.checked }));
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
        if (modeSelect) modeSelect.value = this.dawState.recordMode;
        if (tempoInput) tempoInput.value = Math.round(this.dawState.tempo);
        if (slotsInput) slotsInput.value = String(this.dawState.slotsPerTrack);
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
        const grid = document.getElementById('pad-grid');
        if (!grid || !this.dawState || !Array.isArray(this.dawState.tracks)) return;
        grid.innerHTML = '';
        const slots = this.dawState.slotsPerTrack || 1;

        for (let t = 0; t < 16; t++) {
            const ch = this.dawState.tracks[t];
            if (!ch) continue;
            const row = document.createElement('div');
            row.className = 'daw-track-row';

            const label = document.createElement('div');
            label.className = 'daw-track-label';
            label.textContent = `Ch${ch.channel}`;
            row.appendChild(label);

            for (let s = 0; s < slots; s++) {
                const clip = ch.clips[s];
                const pad = document.createElement('button');
                const key = `${t}-${s}`;
                const note = this.padNotes[key];
                pad.className = 'daw-pad' +
                    (ch.playing ? ' playing' : '') +
                    (clip && clip.notes > 0 ? ' has-content' : '') +
                    (note != null ? '' : ' unmapped');
                pad.dataset.track = t;
                pad.dataset.slot = s;
                pad.title = note != null ? `assigned: note ${note}` : 'unmapped';
                pad.textContent = clip && clip.notes > 0 ? clip.notes : '';

                pad.addEventListener('click', () => {
                    this._send({ type: 'daw-pad-trigger', trackIdx: t, slot: s });
                });
                row.appendChild(pad);
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
