/* === DAW / Clip UI — Ableton Session View style === */

export class DAWUI {
    constructor(deviceManager) {
        this.deviceManager = deviceManager;
        this.dawState = null;
        this.padNotes = {}; // `trackIdx-slot` -> controller labels
        this._cueTimers = new Map();
        this._sessions = [];
        this._initControls();
        this._initSessions();
    }

    // Sessions: save/load recordings (DAW clips) to/from disk.
    // Имя спрашивается в prompt после нажатия кнопки (поля в UI нет).
    _initSessions() {
        if (!document.getElementById('btn-save-session') && !document.getElementById('session-list')) return;
        const saveBtn = document.getElementById('btn-save-session');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                const name = prompt('Save session as:');
                if (name && name.trim()) this._send({ type: 'daw-save-session', name: name.trim() });
            });
        }
        const loadBtn = document.getElementById('btn-load-session');
        if (loadBtn) {
            loadBtn.addEventListener('click', () => {
                const list = this._sessions && this._sessions.length
                    ? `Available sessions:\n${this._sessions.join('\n')}\n` : '';
                const name = prompt(`${list}Load session:`, '');
                if (name && name.trim()) this._send({ type: 'daw-load-session', name: name.trim() });
            });
        }
        this._send({ type: 'daw-list-sessions' });
    }

    _renderSessions() {
        const list = document.getElementById('session-list');
        if (!list) return;
        list.innerHTML = '';
        for (const name of this._sessions) {
            const row = document.createElement('div');
            row.className = 'session-item';

            const label = document.createElement('span');
            label.className = 'session-name-label';
            label.textContent = name;
            label.title = `Load "${name}"`;
            label.addEventListener('click', () => this._send({ type: 'daw-load-session', name }));

            const del = document.createElement('button');
            del.className = 'session-delete';
            del.textContent = '✕';
            del.title = `Delete "${name}"`;
            del.addEventListener('click', (e) => {
                e.stopPropagation();
                this._send({ type: 'daw-delete-session', name });
            });

            row.appendChild(label);
            row.appendChild(del);
            list.appendChild(row);
        }
        const empty = document.createElement('p');
        empty.className = 'daw-hint';
        empty.textContent = this._sessions.length ? '' : 'No saved sessions yet.';
        list.appendChild(empty);
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

        // ---- Clock master source selection ----
        const clockSourceSelect = document.getElementById('clock-source-select');
        if (clockSourceSelect) {
            clockSourceSelect.addEventListener('change', () => {
                const value = clockSourceSelect.value; // 'internal' | 'external:<portName>'
                if (value === 'internal') {
                    this._send({ type: 'clock-source-select', kind: 'internal' });
                } else {
                    const portName = value.replace('external:', '');
                    this._send({ type: 'clock-source-select', kind: 'external', portName });
                }
            });
        }

        // Note: daw-get is now sent from app.js after WebSocket connects.
        // (Sending it here at module-load time fails because window.app.ws is null.)
    }

    /** Обработка сообщений от сервера */
    handleMessage(msg) {
        if (msg.type === 'daw_state') {
            this.dawState = msg.payload;
            this._syncControls();
            this._renderClockMasterUI();
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
        } else if (msg.type === 'daw_progress') {
            this._updateTransportCue(msg.payload);
        } else if (msg.type === 'daw_visual_event') {
            this._flashPad(msg.event);
        } else if (msg.type === 'daw_session_list') {
            this._sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
            this._renderSessions();
        } else if (msg.type === 'daw_session_error') {
            this._flashSessionStatus(msg.error || 'Session error', true);
        }
    }

    _flashSessionStatus(text, isError = false) {
        const list = document.getElementById('session-list');
        if (!list) return;
        let el = document.getElementById('session-status');
        if (!el) {
            el = document.createElement('p');
            el.id = 'session-status';
            el.className = 'daw-hint';
            list.appendChild(el);
        }
        el.textContent = text;
        el.classList.toggle('error', isError);
        clearTimeout(this._sessionStatusTimer);
        this._sessionStatusTimer = setTimeout(() => { el.textContent = ''; }, 4000);
    }

    _syncControls() {
        const modeSelect = document.getElementById('record-mode');
        const tempoInput = document.getElementById('tempo');
        
        if (modeSelect) {
            modeSelect.value = this.dawState.recordMode;
            modeSelect.classList.remove('mode-play', 'mode-replace', 'mode-overdub');
            const modeClass = {
                none: 'mode-play',
                replace: 'mode-replace',
                overdub: 'mode-overdub',
            }[this.dawState.recordMode];
            if (modeClass) modeSelect.classList.add(modeClass);
            modeSelect.dataset.recordMode = this.dawState.recordMode;
        }
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

    /** Sync the clock master selector UI with current state */
    _renderClockMasterUI() {
        const select = document.getElementById('clock-source-select');
        const statusEl = document.getElementById('clock-master-status');
        if (!select) return;

        const source = this.dawState?.clockMasterSource || { kind: 'internal' };
        const activeOutputs = this.dawState?.clockMasterActiveOutputs || [];

        // Build the options list from current state (don't rebuild DOM on every tick).
        // Preserve the current selection if it's still valid.
        const isInternal = source.kind === 'internal';

        // Compare the actual DeviceManager input set against the DOM options
        // so hot-plug additions/removals are reflected in the dropdown.
        const currentInputs = (this.deviceManager && this.deviceManager.inputs)
            ? this.deviceManager.inputs.map(i => i.name)
            : [];

        const existingOptions = Array.from(select.options).map(o => o.value);
        const externalValues = currentInputs.map(name => `external:${name}`);

        // Rebuild only when the real port set differs from what's in the DOM.
        let needsRebuild = false;
        if (!existingOptions.includes('internal')) {
            needsRebuild = true;
        } else if (externalValues.length !== existingOptions.filter(v => v.startsWith('external:')).length) {
            needsRebuild = true;
        } else {
            for (const name of currentInputs) {
                if (!existingOptions.includes(`external:${name}`)) {
                    needsRebuild = true;
                    break;
                }
            }
            if (!needsRebuild) {
                for (const opt of existingOptions) {
                    if (opt.startsWith('external:')) {
                        const optName = opt.replace('external:', '');
                        if (!currentInputs.includes(optName)) {
                            needsRebuild = true;
                            break;
                        }
                    }
                }
            }
        }

        if (needsRebuild) {
            select.innerHTML = '';
            const internalOpt = document.createElement('option');
            internalOpt.value = 'internal';
            internalOpt.textContent = 'Internal DAW Clock';
            select.appendChild(internalOpt);

            // Add all discovered input ports as external master candidates
            for (const inp of currentInputs) {
                const opt = document.createElement('option');
                opt.value = `external:${inp}`;
                opt.textContent = `External: ${inp}`;
                select.appendChild(opt);
            }
        }

        // Set the selected value to match the current master source.
        const updatedOptions = Array.from(select.options).map(o => o.value);
        if (isInternal) {
            select.value = 'internal';
        } else {
            const portName = source.masterPortName || '';
            const externalVal = `external:${portName}`;
            if (updatedOptions.includes(externalVal)) {
                select.value = externalVal;
            } else {
                // Selected master is not in the current port list — show safe state.
                select.value = 'internal';
                console.warn(`[DAWUI] Clock master port "${portName}" not found in inputs, fell back to internal`);
            }
        }

        // Update status text (used when no selection has been made yet).
        if (statusEl) {
            if (isInternal) {
                statusEl.textContent = `Selected master: Internal DAW Clock (active outputs: ${activeOutputs.join(', ') || 'none'})`;
            } else {
                statusEl.textContent = `Selected master: External — ${source.masterPortName} (active outputs: ${activeOutputs.join(', ') || 'none'})`;
            }
        }
    }

    /** Public entry point for the clock source dropdown to refresh after hotplug. */
    refreshClockSourceSelect() {
        this._renderClockMasterUI();
    }

    _renderGrid() {
        const grid = document.getElementById('session-grid');
        const sceneNamesDiv = document.getElementById('scene-names');
        
        if (!grid) { console.warn('[DAWUI] session-grid not found'); return; }
        if (!this.dawState) { console.warn('[DAWUI] dawState is null, skipping render'); return; }
        if (!Array.isArray(this.dawState.tracks)) { console.warn('[DAWUI] tracks is not array:', typeof this.dawState.tracks); return; }
        
        grid.innerHTML = '';
        if (sceneNamesDiv) sceneNamesDiv.innerHTML = '';

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
        const cueClass = evt.kind === 'record-start' ? 'record-start' : 'clip-start';
        const previousTimer = this._cueTimers.get(el);
        if (previousTimer) clearTimeout(previousTimer);
        el.classList.remove('clip-start', 'record-start', 'flash');
        el.classList.add(evt.kind ? cueClass : 'flash');
        const timer = setTimeout(() => {
            el.classList.remove('clip-start', 'record-start', 'flash');
            this._cueTimers.delete(el);
        }, evt.kind ? 220 : 120);
        this._cueTimers.set(el, timer);
    }

    _updateTransportCue(cue) {
        const indicator = document.getElementById('daw-beat-indicator');
        if (!indicator || !cue) return;
        if (cue.playing === false) {
            indicator.classList.remove('beat-pulse', 'bar-start', 'cycle-start');
            indicator.textContent = 'Stopped';
            return;
        }

        const beat = Math.max(0, Number(cue.beat) || 0);
        const meter = Math.max(1, Number(cue.meter) || 4);
        const bar = Math.floor(beat / meter) + 1;
        const beatInBar = Math.floor(beat % meter) + 1;
        indicator.textContent = `Bar ${bar} · Beat ${beatInBar}`;
        indicator.classList.remove('beat-pulse', 'bar-start', 'cycle-start');
        const cueClass = cue.cycleStart ? 'cycle-start' : cue.barStart ? 'bar-start' : null;
        if (!cueClass) return;
        indicator.classList.add(cueClass, 'beat-pulse');
        const previousTimer = this._cueTimers.get(indicator);
        if (previousTimer) clearTimeout(previousTimer);
        const timer = setTimeout(() => {
            indicator.classList.remove('beat-pulse', 'bar-start', 'cycle-start');
            this._cueTimers.delete(indicator);
        }, 220);
        this._cueTimers.set(indicator, timer);
    }

    _send(msg) {
        if (window.app && window.app.ws && window.app.ws.readyState === WebSocket.OPEN) {
            window.app.ws.send(JSON.stringify(msg));
        }
    }
}
