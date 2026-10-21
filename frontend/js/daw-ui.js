/* === DAW / Clip UI — Ableton Session View style === */

export class DAWUI {
    constructor(deviceManager) {
        this.deviceManager = deviceManager;
        this.dawState = null;
        this.padNotes = {}; // `trackIdx-slot` -> controller labels
        this._cueTimers = new Map();
        this._sessions = [];
        this._recent = [];
        this._activeSession = null; // name of the project currently loaded (shown green in header)
        this._initControls();
        this._initSessions();
    }

    // Sessions: save/load recordings (DAW clips) to/from disk.
    // Save asks for a name; Load opens a dropdown listing the saved sessions.
    _initSessions() {
        const saveBtn = document.getElementById('btn-save-session');
        const loadBtn = document.getElementById('btn-load-session');
        if (!saveBtn && !loadBtn) return;
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                const name = prompt('Save session as:');
                if (name && name.trim()) this._send({ type: 'daw-save-session', name: name.trim() });
            });
        }
        if (loadBtn) {
            loadBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._toggleSessionPicker();
            });
        }
        // Close the picker on outside click or Escape
        document.addEventListener('click', (e) => {
            const wrap = document.querySelector('.session-load-wrap');
            if (wrap && !wrap.contains(e.target)) this._setSessionPicker(false);
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this._setSessionPicker(false);
        });
        this._send({ type: 'daw-list-sessions' });
    }

    _toggleSessionPicker() {
        const open = document.getElementById('session-picker')?.hidden !== false;
        this._setSessionPicker(open);
        if (open) this._send({ type: 'daw-list-sessions' }); // refresh list when opening
    }

    _setSessionPicker(open) {
        const picker = document.getElementById('session-picker');
        const loadBtn = document.getElementById('btn-load-session');
        if (!picker) return;
        picker.hidden = !open;
        loadBtn?.setAttribute('aria-expanded', String(open));
        if (open) this._renderSessionPicker();
    }

    _renderSessionPicker() {
        const picker = document.getElementById('session-picker');
        if (!picker || picker.hidden) return;
        picker.innerHTML = '';
        const title = document.createElement('div');
        title.className = 'session-picker-title';
        title.textContent = 'Saved sessions';
        picker.appendChild(title);
        if (!this._sessions.length) {
            const empty = document.createElement('p');
            empty.className = 'session-picker-empty';
            empty.textContent = 'No saved sessions yet.';
            picker.appendChild(empty);
            return;
        }
        for (const name of this._sessions) {
            picker.appendChild(this._sessionRow(name, () => {
                this._setSessionPicker(false);
                this._loadSession(name);
            }));
        }
    }

    // One session entry: clickable name + delete button
    _sessionRow(name, onLoad) {
        const row = document.createElement('div');
        row.className = 'session-item';

        const label = document.createElement('span');
        label.className = 'session-name-label';
        label.textContent = name;
        label.title = `Load "${name}"`;
        label.addEventListener('click', onLoad);

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
        return row;
    }

    // Header: quick-load buttons for the last 3 saved sessions (left of Save)
    _renderRecentSessions() {
        const box = document.getElementById('session-recent');
        if (!box) return;
        box.innerHTML = '';
        for (const name of this._recent) {
            const btn = document.createElement('button');
            btn.className = 'btn btn-sm session-recent-item';
            if (name === this._activeSession) btn.classList.add('btn-green');
            btn.textContent = name;
            btn.title = `Load "${name}"`;
            btn.addEventListener('click', () => this._loadSession(name));
            box.appendChild(btn);
        }
    }

    // Load a project and mark it as the active one (green button in header)
    _loadSession(name) {
        this._activeSession = name;
        this._renderRecentSessions();
        this._send({ type: 'daw-load-session', name });
    }

    _renderSessions() {
        this._renderSessionPicker();
    }

    _initControls() {
        // Transport buttons
        const playBtn = document.getElementById('btn-play');
        if (playBtn) playBtn.addEventListener('click', () => this._send({ type: 'daw-play' }));
        
        const stopBtn = document.getElementById('btn-stop');
        if (stopBtn) {
            // Update button text based on master-loop state: the loop is
            // active while transport plays OR a recording is in progress.
            const updateText = () => {
                const isActive = !!(this.dawState?.playing || this.dawState?.recording != null);
                stopBtn.textContent = isActive ? 'Stop' : '● Rec';
            };
            updateText();
            stopBtn.addEventListener('click', () => {
                // Toggle based on button text: if it says 'Stop', stop the
                // active master loop (play + record); otherwise start
                // the transport (no count-in); the master loop runs from there.
                if (stopBtn.textContent === 'Stop') {
                    this._send({ type: 'daw-stop' });
                } else {
                    this._send({ type: 'daw-start-with-countin' });
                }
                // Immediately toggle the button text for instant feedback
                stopBtn.textContent = stopBtn.textContent === 'Stop' ? '● Rec' : 'Stop';
            });
        }
        
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

        // Shared master loop length
        const masterLoopBars = document.getElementById('master-loop-bars');
        if (masterLoopBars) {
            masterLoopBars.addEventListener('change', () => {
                const bars = parseInt(masterLoopBars.value, 10);
                if (Number.isInteger(bars)) this._send({ type: 'daw-set-master-loop-bars', bars });
            });
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

        // Audio latency offset slider (ms). Shifts clip note-ons earlier.
        const audioLatencyInput = document.getElementById('audio-latency');
        if (audioLatencyInput) {
            const label = document.getElementById('audio-latency-label');
            const updateLabel = () => {
                if (label) label.textContent = `${audioLatencyInput.value} ms`;
            };
            updateLabel();
            audioLatencyInput.addEventListener('input', () => {
                const ms = parseInt(audioLatencyInput.value, 10);
                if (!Number.isNaN(ms)) this._send({ type: 'daw-audio-offset', ms });
                updateLabel();
            });
        }

        // Click latency slider (ms): tunes when the audio metronome click lands.
        const clickLatencyInput = document.getElementById('click-latency');
        if (clickLatencyInput) {
            const label = document.getElementById('click-latency-label');
            const updateLabel = () => {
                if (label) label.textContent = `${clickLatencyInput.value} ms`;
            };
            updateLabel();
            clickLatencyInput.addEventListener('input', () => {
                const ms = parseInt(clickLatencyInput.value, 10);
                if (!Number.isNaN(ms)) this._send({ type: 'daw-click-offset', ms });
                updateLabel();
            });
        }

        // Quantization grid selector (beats). Snaps recorded note starts.
        const quantizeGridInput = document.getElementById('quantize-grid');
        if (quantizeGridInput) {
            quantizeGridInput.addEventListener('change', () => {
                const beats = Number(quantizeGridInput.value);
                if (!Number.isNaN(beats)) this._send({ type: 'daw-quantize-grid', beats });
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

    /** Handle messages from the server */
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
            // Update the learn mode state
            if (document.getElementById('btn-learn')) {
                document.getElementById('btn-learn').classList.toggle('active', !!msg.learnMode);
            }
            // Re-render the grid with the new pad hints
            this._renderGrid();
        } else if (msg.type === 'daw_event') {
            this._flashPad(msg.payload);
        } else if (msg.type === 'daw_progress') {
            this._updateTransportCue(msg.payload);
            const positions = msg.payload?.playing === false ? [] : msg.payload?.clipProgress || [];
            if (this.dawState) this.dawState.clipProgress = positions;
            this._updateClipProgress(positions);
        } else if (msg.type === 'daw_visual_event') {
            this._flashPad(msg.event);
        } else if (msg.type === 'daw_session_list') {
            this._sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
            this._recent = Array.isArray(msg.recent) ? msg.recent : [];
            this._renderSessions();
            this._renderRecentSessions();
        } else if (msg.type === 'daw_session_error') {
            if (msg.name && msg.name === this._activeSession) {
                this._activeSession = null;
                this._renderRecentSessions();
            }
            this._flashSessionStatus(msg.error || 'Session error', true);
        }
    }

    _flashSessionStatus(text, isError = false) {
        const el = document.getElementById('session-status');
        if (!el) return;
        el.textContent = text;
        el.classList.toggle('error', isError);
        clearTimeout(this._sessionStatusTimer);
        this._sessionStatusTimer = setTimeout(() => { el.textContent = ''; }, 4000);
    }

    _syncControls() {
        const modeSelect = document.getElementById('record-mode');
        const tempoInput = document.getElementById('tempo');
        const masterLoopBars = document.getElementById('master-loop-bars');
        
        if (modeSelect) {
            modeSelect.value = this.dawState.recordMode;
            modeSelect.classList.remove('mode-play', 'mode-overdub');
            const modeClass = {
                none: 'mode-play',
                overdub: 'mode-overdub',
            }[this.dawState.recordMode];
            if (modeClass) modeSelect.classList.add(modeClass);
            modeSelect.dataset.recordMode = this.dawState.recordMode;
        }
        if (tempoInput) tempoInput.value = Math.round(this.dawState.tempo);
        if (masterLoopBars) {
            masterLoopBars.value = this.dawState.masterLoopBars != null
                ? String(this.dawState.masterLoopBars) : '';
        }
        
        // Metronome
        const metroBtn = document.getElementById('metronome-toggle');
        if (metroBtn) {
            const enabled = this.dawState.metronomeEnabled;
            metroBtn.classList.toggle('active', !!enabled);
            metroBtn.textContent = enabled ? '♫ Metro ON' : '♪ Metro';
        }

        // Beats per measure
        const metroBeatsInput = document.getElementById('metro-beats');
        if (metroBeatsInput && this.daw) {
            metroBeatsInput.value = this.daw._metronomeBeatsPerMeasure || 4;
        }

        // Click latency slider: sync from state.
        const clickLatencyInput = document.getElementById('click-latency');
        if (clickLatencyInput && this.dawState?.clickOffsetMs != null) {
            clickLatencyInput.value = String(this.dawState.clickOffsetMs);
            const label = document.getElementById('click-latency-label');
            if (label) label.textContent = `${this.dawState.clickOffsetMs} ms`;
        }

        // Audio latency offset slider: sync from state.
        const audioLatencyInput = document.getElementById('audio-latency');
        if (audioLatencyInput && this.dawState?.audioOffsetMs != null) {
            audioLatencyInput.value = String(this.dawState.audioOffsetMs);
            const label = document.getElementById('audio-latency-label');
            if (label) label.textContent = `${this.dawState.audioOffsetMs} ms`;
        }

        // Quantization grid selector: sync from state.
        const quantizeGridInput = document.getElementById('quantize-grid');
        if (quantizeGridInput && this.dawState?.quantizeGrid != null) {
            quantizeGridInput.value = String(this.dawState.quantizeGrid);
        }

        // MIDI Clock
        const midiClockBtn = document.getElementById('midi-clock-toggle');
        if (midiClockBtn) {
            const enabled = this.dawState.midiClockEnabled;
            midiClockBtn.classList.toggle('active', !!enabled);
            midiClockBtn.textContent = enabled ? '⏱ MTC ON' : '⏱ MTC';
        }
        // Stop button label: "master loop active" = transport playing or
        // a recording in progress (including count-in pending).
        const stopBtn = document.getElementById('btn-stop');
        if (stopBtn) {
            const isActive = !!(this.dawState?.playing || this.dawState?.recording != null);
            stopBtn.textContent = isActive ? 'Stop' : '● Rec';
        }
    }

    /** Sync the clock master selector UI with current state */
    _renderClockMasterUI() {
        const select = document.getElementById('clock-source-select');
        if (!select) return;

        const source = this.dawState?.clockMasterSource || { kind: 'internal' };

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

        // Render track columns — each track gets a column: header + vertical clips + "+" (add clip) below
        for (let t = 0; t < this.dawState.tracks.length; t++) {
            const ch = this.dawState.tracks[t];
            if (!ch) continue;
            
            const block = document.createElement('div');
            block.className = 'track-block';

            // Track label (column header)
            const label = document.createElement('div');
            label.className = 'session-track-label';
            label.textContent = `Track ${t + 1}`;
            block.appendChild(label);

            // Clip slots (vertical column under the track label)
            const clipCount = Array.isArray(ch.clips) ? ch.clips.length : this.dawState.slotsPerTrack;
            for (let s = 0; s < clipCount; s++) {
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
                // Determine additional state classes based on DAW state and record mode
                const isRecording = this.dawState?.recording?.track === t && this.dawState?.recording?.slot === s;
                // Count-in pending: blink red until recording actually starts.
                const isPending = isRecording && !!this.dawState?.countInPending;
                // A new overdub layer being recorded -> orange (the initial take stays red).
                const isOverdubActive = isRecording && this.dawState?.recording?.mode === 'overdub';
                const isActive = ch.playing && s === ch.activeSlot;
                if (isPending) {
                    cls += ' pending';
                } else if (isOverdubActive) {
                    cls += ' overdub';
                } else if (isRecording) {
                    cls += ' recording';
                } else if (isActive) {
                    cls += ' playing';
                } else if (clip && clip.notes > 0) {
                    cls += ' idle';
                }
                slot.className = cls;
                const stateLabel = isPending ? 'Count-in' : isOverdubActive ? 'Overdub' : isRecording ? 'Recording' : isActive ? 'Playing' : clip?.notes > 0 ? 'Ready' : 'Empty';
                const clipNumber = document.createElement('span');
                clipNumber.className = 'clip-number';
                clipNumber.textContent = String(s + 1).padStart(2, '0');
                const clipStatus = document.createElement('span');
                clipStatus.className = 'clip-status';
                clipStatus.textContent = stateLabel;
                slot.appendChild(clipNumber);
                slot.appendChild(clipStatus);
                if (isActive && !isPending) {
                    const progress = document.createElement('span');
                    progress.className = 'clip-progress';
                    progress.setAttribute('aria-hidden', 'true');
                    progress.hidden = true;
                    const fill = document.createElement('span');
                    fill.className = 'clip-progress-fill';
                    progress.appendChild(fill);
                    slot.appendChild(progress);
                }
                slot.setAttribute('aria-label', `Track ${t + 1}, clip ${s + 1}: ${stateLabel}`);

                
                slot.dataset.track = t;
                slot.dataset.slot = s;
                slot.title = note?.length ? `Pads: ${note.join(', ')}` : 'unmapped';

                // Click to trigger clip; long-press (≈600 ms) on a recorded clip clears it.
                let pressTimer = null;
                let longPressFired = false;
                const cancelPress = () => { if (pressTimer) clearTimeout(pressTimer); pressTimer = null; };
                slot.addEventListener('pointerdown', (e) => {
                    if (e.button !== undefined && e.button !== 0) return;
                    longPressFired = false;
                    cancelPress();
                    if (!clip || !(clip.notes > 0)) return;
                    pressTimer = setTimeout(() => {
                        pressTimer = null;
                        longPressFired = true;
                        this._send({ type: 'daw-clear-clip', trackIdx: t, slot: s });
                    }, 600);
                });
                ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => slot.addEventListener(ev, cancelPress));
                slot.addEventListener('contextmenu', (e) => { if (pressTimer || longPressFired) e.preventDefault(); });
                slot.addEventListener('click', () => {
                    if (longPressFired) { longPressFired = false; return; }
                    this._send({ type: 'daw-pad-trigger', trackIdx: t, slot: s });
                });
                
                block.appendChild(slot);
            }

            // "+" below the clip column: append one more empty clip to this track
            const addRow = document.createElement('div');
            addRow.className = 'track-controls-row';
            const addClipBtn = document.createElement('button');
            addClipBtn.className = 'btn-add-clip';
            addClipBtn.textContent = '+';
            const maxSlots = this.dawState.maxSlotsPerTrack;
            addClipBtn.disabled = maxSlots != null && clipCount >= maxSlots;
            addClipBtn.title = `Track ${t + 1} - Add empty clip`;
            addClipBtn.addEventListener('click', () => {
                this._send({ type: 'daw-add-clip', trackIdx: t });
            });
            addRow.appendChild(addClipBtn);

            // "-" next to "+": remove the last clip; on a track's only clip, remove the whole track
            const removeClipBtn = document.createElement('button');
            removeClipBtn.className = 'btn-remove-clip';
            removeClipBtn.textContent = '-';
            const onlyTrack = this.dawState.tracks.length <= 1;
            removeClipBtn.disabled = clipCount <= 1 && onlyTrack;
            removeClipBtn.title = clipCount > 1
                ? `Track ${t + 1} - Remove last clip`
                : (onlyTrack ? 'Keep at least one track' : `Track ${t + 1} - Remove track`);
            removeClipBtn.addEventListener('click', () => {
                this._send({ type: 'daw-remove-clip', trackIdx: t });
            });
            addRow.appendChild(removeClipBtn);
            block.appendChild(addRow);

            grid.appendChild(block);
        }

        // "+" after the last track: append one more empty track
        const maxTracks = this.dawState.maxTracks;
        const addTrackBlock = document.createElement('div');
        addTrackBlock.className = 'track-block track-block-add';
        const addTrackBtn = document.createElement('button');
        addTrackBtn.className = 'btn-add-track';
        addTrackBtn.textContent = '+';
        addTrackBtn.disabled = maxTracks != null && this.dawState.tracks.length >= maxTracks;
        addTrackBtn.title = 'Add track';
        addTrackBtn.addEventListener('click', () => {
            this._send({ type: 'daw-add-track' });
        });
        addTrackBlock.appendChild(addTrackBtn);
        grid.appendChild(addTrackBlock);
        this._updateClipProgress(this.dawState.clipProgress);
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

    _updateClipProgress(positions = []) {
        const lookup = new Map((Array.isArray(positions) ? positions : [])
            .map(position => [`${position.trackIdx}:${position.slot}`, position.progress]));
        for (const track of document.querySelectorAll('.session-slot')) {
            const bar = track.querySelector('.clip-progress');
            if (!bar) continue;
            const progress = lookup.get(`${track.dataset.track}:${track.dataset.slot}`);
            bar.hidden = !Number.isFinite(progress);
            if (bar.hidden) continue;
            const fraction = Math.max(0, Math.min(1, progress));
            const fill = bar.querySelector('.clip-progress-fill');
            // A new loop snaps to the left instead of animating backwards.
            fill.style.transition = fraction < Number(fill.dataset.progress || 0) ? 'none' : '';
            fill.style.transform = `scaleX(${fraction})`;
            fill.dataset.progress = String(fraction);
        }
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
        const masterLoopInfo = this.dawState?.masterLoopBars ? `Master loop: ${this.dawState.masterLoopBars}-bars` : '';
const beatInfo = `${masterLoopInfo}${masterLoopInfo ? ' · ' : '' }Bar ${bar} · Beat ${beatInBar}`;
indicator.textContent = beatInfo;
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
