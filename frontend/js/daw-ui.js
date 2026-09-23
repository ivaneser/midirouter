/* === DAW / Clip UI — Ableton Session View style === */

export class DAWUI {
    constructor(deviceManager) {
        this.deviceManager = deviceManager;
        this.dawState = null;
        this.padNotes = {}; // `trackIdx-slot` -> controller labels
        this._initControls();
    }

    _initControls() {
        // Transport buttons
        const playBtn = document.getElementById('btn-play');
        if (playBtn) playBtn.addEventListener('click', () => this._send({ type: 'daw-play' }));
        
        const stopBtn = document.getElementById('btn-stop');
        if (stopBtn) stopBtn.addEventListener('click', () => this._send({ type: 'daw-stop' }));
        
        const recArmBtn = document.getElementById('btn-record-arm');
        if (recArmBtn) {
            recArmBtn.addEventListener('click', () => this._send({ type: 'daw-rec-arm-toggle' }));
        }

        // Record mode
        const modeSelect = document.getElementById('record-mode');
        if (modeSelect) {
            modeSelect.addEventListener('change', () => 
                this._send({ type: 'daw-set-record-mode', mode: modeSelect.value })
            );
        }

        // Tempo
        const tempoInput = document.getElementById('tempo');
        if (tempoInput) {
            tempoInput.addEventListener('change', () => {
                const bpm = parseFloat(tempoInput.value);
                if (bpm) this._send({ type: 'daw-set-tempo', bpm });
            });
        }

        // Tap tempo
        const tapBtn = document.getElementById('tap-tempo');
        if (tapBtn) {
            tapBtn.addEventListener('click', () => this._send({ type: 'daw-tap-tempo' }));
        }

        // Metronome
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

        // MIDI Clock (MTC)
        const midiClockBtn = document.getElementById('midi-clock-toggle');
        if (midiClockBtn) {
            midiClockBtn.addEventListener('click', () => this._send({ type: 'daw-midi-clock-toggle' }));
        }

        // Note: daw-get is now sent from app.js after WebSocket connects.
        // (Sending it here at module-load time fails because window.app.ws is null.)
    }

    /** Обработка сообщений от сервера */
    handleMessage(msg) {
        if (msg.type === 'daw_state') {
            this.dawState = msg.payload;
            this._syncControls();
            this._renderGrid();
            this._renderTrackControls();
        } else if (msg.type === 'daw_pad_map_list') {
            // Show all configured controllers that can trigger each clip.
            this.padNotes = {};
            for (const entry of (msg.map || [])) {
                const key = `${entry.trackIdx}-${entry.slot}`;
                if (!this.padNotes[key]) this.padNotes[key] = [];
                const source = entry.profileId || 'learned';
                const message = entry.message === 'cc' ? 'CC' : entry.message === 'program' ? 'program' : entry.message === 'sysex' ? 'SysEx pad' : 'note';
                this.padNotes[key].push(`${source} ${message} ${entry.note}`);
            }
            // Обновляем состояние learn mode
            if (document.getElementById('btn-learn')) {
                document.getElementById('btn-learn').classList.toggle('active', !!msg.learnMode);
            }
            // Перерисовываем сетку с новыми подсказками пэдов
            this._renderGrid();
        } else if (msg.type === 'daw_event') {
            this._flashPad(msg.payload);
        }
    }

    _syncControls() {
        const modeSelect = document.getElementById('record-mode');
        const tempoInput = document.getElementById('tempo');
        
        if (modeSelect) modeSelect.value = this.dawState.recordMode;
        if (tempoInput) tempoInput.value = Math.round(this.dawState.tempo);
        
        // Metronome
        const metroBtn = document.getElementById('metronome-toggle');
        if (metroBtn) {
            const enabled = this.dawState.metronomeEnabled;
            metroBtn.classList.toggle('active', !!enabled);
            metroBtn.textContent = enabled ? '♫ Metro ON' : '♪ Metro';
        }

        // MIDI Clock
        const midiClockBtn = document.getElementById('midi-clock-toggle');
        if (midiClockBtn) {
            const enabled = this.dawState.midiClockEnabled;
            midiClockBtn.classList.toggle('active', !!enabled);
            midiClockBtn.textContent = enabled ? '⏱ MTC ON' : '⏱ MTC';
        }
    }

    _renderGrid() {
        const grid = document.getElementById('session-grid');
        const sceneNamesDiv = document.getElementById('scene-names');
        
        if (!grid) { console.warn('[DAWUI] session-grid not found'); return; }
        if (!this.dawState) { console.warn('[DAWUI] dawState is null, skipping render'); return; }
        if (!Array.isArray(this.dawState.tracks)) { console.warn('[DAWUI] tracks is not array:', typeof this.dawState.tracks); return; }
        
        grid.innerHTML = '';
        sceneNamesDiv.innerHTML = '';
        
        // Render scene names (top row) — one per clip slot row
        for (let s = 0; s < this.dawState.slotsPerTrack; s++) {
            const nameEl = document.createElement('div');
            nameEl.className = 'scene-name';
            nameEl.textContent = `Slot ${s + 1}`;
            sceneNamesDiv.appendChild(nameEl);
        }

        // Render track columns — each track gets a column: header + vertical clips + buttons below
        for (let t = 0; t < 16; t++) {
            const ch = this.dawState.tracks[t];
            if (!ch) continue;
            
            const block = document.createElement('div');
            block.className = 'track-block';

            // Track label (column header)
            const label = document.createElement('div');
            label.className = 'session-track-label';
            label.textContent = `Ch${ch.channel}`;
            block.appendChild(label);

            // Clip slots (vertical column under the track label)
            for (let s = 0; s < this.dawState.slotsPerTrack; s++) {
                const clip = ch.clips[s];
                const slot = document.createElement('button');
                const key = `${t}-${s}`;
                const note = this.padNotes[key];
                
                let cls = 'session-slot';
                if (!clip || clip.notes === 0) {
                    cls += ' empty';
                } else {
                    cls += ' has-content';
                }
                if (ch.playing && s === ch.activeSlot) {
                    cls += ' playing';
                }
                slot.className = cls;
                
                slot.dataset.track = t;
                slot.dataset.slot = s;
                slot.title = note?.length ? `Pads: ${note.join(', ')}` : 'unmapped';
                slot.textContent = clip && clip.notes > 0 ? `${clip.notes}n` : '';

                // Click to trigger clip
                slot.addEventListener('click', () => {
                    this._send({ type: 'daw-pad-trigger', trackIdx: t, slot: s });
                });
                
                block.appendChild(slot);
            }

            // Control buttons (arm/mute/solo) below the clip column
            const controlsRow = document.createElement('div');
            controlsRow.className = 'track-controls-row';
            
            // Arm button
            const armBtn = document.createElement('button');
            armBtn.className = `btn-track-arm ${ch.armed ? 'active' : ''}`;
            armBtn.textContent = '●';
            armBtn.title = `Track ${t + 1} - Arm for recording`;
            armBtn.addEventListener('click', () => {
                this._send({ type: 'daw-track-arm', trackIdx: t });
            });
            
            // Mute button
            const muteBtn = document.createElement('button');
            muteBtn.className = `btn-track-mute ${ch.muted ? 'muted' : ''}`;
            muteBtn.textContent = 'M';
            muteBtn.title = `Track ${t + 1} - Mute`;
            muteBtn.addEventListener('click', () => {
                this._send({ type: 'daw-track-mute', trackIdx: t });
            });
            
            // Solo button
            const soloBtn = document.createElement('button');
            soloBtn.className = `btn-track-solo ${ch.soloed ? 'soloed' : ''}`;
            soloBtn.textContent = 'S';
            soloBtn.title = `Track ${t + 1} - Solo`;
            soloBtn.addEventListener('click', () => {
                this._send({ type: 'daw-track-solo', trackIdx: t });
            });
            
            controlsRow.appendChild(armBtn);
            controlsRow.appendChild(muteBtn);
            controlsRow.appendChild(soloBtn);
            block.appendChild(controlsRow);
            
            grid.appendChild(block);
        }
    }

    _renderTrackControls() {
        // Track controls are now rendered inside each track block in _renderGrid().
        // This method is kept for compatibility but no longer renders a separate strip.
    }

    _flashPad(evt) {
        if (evt == null || evt.trackIdx == null || evt.slot == null) return;
        const el = document.querySelector(`.session-slot[data-track="${evt.trackIdx}"][data-slot="${evt.slot}"]`);
        if (!el) return;
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 120);
    }

    _send(msg) {
        if (window.app && window.app.ws && window.app.ws.readyState === WebSocket.OPEN) {
            window.app.ws.send(JSON.stringify(msg));
        }
    }
}
