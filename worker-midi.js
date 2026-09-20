/* === MIDI Router — all-to-all passthrough + DAW / Clip mode === */
import midi from '@julusian/midi';
import { parentPort } from 'worker_threads';
import { DAWEngine, noteOn, noteOff } from './daw.js';
import { portIndex, PortRecord } from './port-index.js';
import { ChannelFilter, VelocityFilter, MessageTypeFilter } from './filters.js';
import { CCMapper } from './cc-mapper.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class MIDIRouterWorker {
    constructor() {
        this.inputs = new Map();   // deviceName -> RtMidiIn instance
        this.outputs = new Map();  // deviceName -> RtMidiOut instance

        // DAW engine — metronome/clip events go to UI AND physical MIDI outputs
        this.daw = new DAWEngine();
        this.daw._onEvent = (evt) => {
            // Forward to all output ports so metronome/clip audio is audible
            if (evt && evt.data && Array.isArray(evt.data)) {
                this._sendToAllOutputs(evt.data, 'daw-midi');
            }
            // Also notify UI via WebSocket
            parentPort.postMessage({ type: 'daw_midi', data: evt.data });
        };

        // track playback timers (loop): trackIdx -> intervalId
        this._trackPlayTimers = new Map();
        // LED glow per active track: trackIdx -> { note, color }
        this._ledGlow = new Map();

        // controller input ports whose notes drive DAW trigger/recording
        this.controllerInputs = new Set();

        // Automatic pad assignment: any newly pressed key is auto-assigned to the
        // next free (track, slot). This makes the LaunchKey work as the main
        // interface with ZERO web-UI setup. Set autoAssign=false to force manual.
        this.autoAssign = true;
        this._learnCursor = 0;
        this.padMap = new Map();   // note(number) -> { trackIdx, slot }

        // CC Mapper — трансляция команд контроллера в команды синта
        this.ccMapper = new CCMapper();

        // DAW mode activation for Novation Launchkey Mini MK3
        // Controller enters DAW/Session mode only when it receives a special
        // MIDI message (as if from Ableton Live): Ch16, note=12 (C-1), vel=127
        this._dawModeSent = false;

        // Default pad map for Launchkey Mini MK3 (16 pads: 2 rows × 8 cols)
        // Bottom row: C1(36) C#1(37) D1(38) D#1(39) E1(40) F1(41) F#1(42) G1(43)
        // Top row:    G#1(44) A1(45) A#1(46) B1(47) C2(48) C#2(49) D2(50) D#2(51)
        this._defaultPadMap = [
            { note: 36, trackIdx: 0, slot: 0 }, // C1
            { note: 37, trackIdx: 1, slot: 0 }, // C#1
            { note: 38, trackIdx: 2, slot: 0 }, // D1
            { note: 39, trackIdx: 3, slot: 0 }, // D#1
            { note: 40, trackIdx: 0, slot: 1 }, // E1
            { note: 41, trackIdx: 1, slot: 1 }, // F1
            { note: 42, trackIdx: 2, slot: 1 }, // F#1
            { note: 43, trackIdx: 3, slot: 1 }, // G1
            { note: 44, trackIdx: 4, slot: 0 }, // G#1
            { note: 45, trackIdx: 5, slot: 0 }, // A1
            { note: 46, trackIdx: 6, slot: 0 }, // A#1
            { note: 47, trackIdx: 7, slot: 0 }, // B1
            { note: 48, trackIdx: 4, slot: 1 }, // C2
            { note: 49, trackIdx: 5, slot: 1 }, // C#2
            { note: 50, trackIdx: 6, slot: 1 }, // D2
            { note: 51, trackIdx: 7, slot: 1 }, // D#2
        ];
        
        // Configuration
        this._config = null;
        this._mappings = new Map(); // name -> { inputs: [], outputs: [], filters: [] }
        this._hotplug = true;
        this._ignoreDevices = ['Midi Through', 'loopback', 'timer', 'announce'];
        
        // Hot-plug detection
        this._lastInputNames = new Set();
        this._lastOutputNames = new Set();
        this._hotplugCheckInterval = null;
        this._autoRouteOnHotplug = true;
    }

    init() {
        try {
            console.log('[WORKER] MIDI initializing...');
            this._loadConfig();
            this._enumeratePorts();
            this._startHotplugDetection();
        } catch (e) {
            console.error('[WORKER] MIDI init failed:', e.message);
            process.exit(1);
        }
    }
    
    _startHotplugDetection() {
        // Check for device changes every 2 seconds
        this._hotplugCheckInterval = setInterval(() => {
            this._checkHotplug();
        }, 2000);
        console.log('[WORKER] Hot-plug detection started (interval: 2s)');
    }
    
    _checkHotplug() {
        try {
            // Используем существующие порты для проверки, не создаём новые объекты
            const currentInputNames = new Set();
            const currentOutputNames = new Set();
            
            // Проверяем существующие порты
            for (const [name, input] of this.inputs) {
                currentInputNames.add(name);
            }
            
            for (const [name, output] of this.outputs) {
                currentOutputNames.add(name);
            }
            
            // Check for new inputs
            for (const name of currentInputNames) {
                if (!this._lastInputNames.has(name)) {
                    console.log(`[WORKER] HOT-PLUG: New input detected: ${name}`);
                    this._lastInputNames.add(name);
                    // Notify server about new device
                    parentPort.postMessage({
                        type: 'hotplug-detected',
                        deviceName: name,
                        action: 'added',
                        direction: 'input'
                    });
                    if (this._autoRouteOnHotplug) {
                        this._rebuildMappings();
                    }
                }
            }
            
            // Check for removed inputs
            for (const name of this._lastInputNames) {
                if (!currentInputNames.has(name)) {
                    console.log(`[WORKER] HOT-PLUG: Input removed: ${name}`);
                    this._lastInputNames.delete(name);
                    // Notify server about removed device
                    parentPort.postMessage({
                        type: 'hotplug-detected',
                        deviceName: name,
                        action: 'removed',
                        direction: 'input'
                    });
                    if (this._autoRouteOnHotplug) {
                        this._rebuildMappings();
                    }
                }
            }
            
            // Check for new outputs
            for (const name of currentOutputNames) {
                if (!this._lastOutputNames.has(name)) {
                    console.log(`[WORKER] HOT-PLUG: New output detected: ${name}`);
                    this._lastOutputNames.add(name);
                    // Notify server about new device
                    parentPort.postMessage({
                        type: 'hotplug-detected',
                        deviceName: name,
                        action: 'added',
                        direction: 'output'
                    });
                    if (this._autoRouteOnHotplug) {
                        this._rebuildMappings();
                    }
                }
            }
            
            // Check for removed outputs
            for (const name of this._lastOutputNames) {
                if (!currentOutputNames.has(name)) {
                    console.log(`[WORKER] HOT-PLUG: Output removed: ${name}`);
                    this._lastOutputNames.delete(name);
                    // Notify server about removed device
                    parentPort.postMessage({
                        type: 'hotplug-detected',
                        deviceName: name,
                        action: 'removed',
                        direction: 'output'
                    });
                    if (this._autoRouteOnHotplug) {
                        this._rebuildMappings();
                    }
                }
            }
            
            // Update last known states
            this._lastInputNames = currentInputNames;
            this._lastOutputNames = currentOutputNames;
            
        } catch (e) {
            console.error('[WORKER] Hot-plug check failed:', e.message);
        }
    }
    
    _rebuildMappings() {
        // Пересборка маппингов при изменении устройств
        if (this._config && this._config.mappings) {
            this._mappings.clear();
            for (const [name, mapping] of Object.entries(this._config.mappings)) {
                this._buildMapping(name, mapping);
            }
            console.log('[WORKER] Mappings rebuilt due to hot-plug');
        }
    }
    
    _loadConfig() {
        const configPath = path.join(__dirname, 'config.json');
        try {
            if (fs.existsSync(configPath)) {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                this._config = config;
                this._ignoreDevices = config.ignore || this._ignoreDevices;
                console.log('[WORKER] Config loaded:', configPath);
                
                // Populate PortIndex from config
                if (config.devices) {
                    for (const [nickname, device] of Object.entries(config.devices)) {
                        portIndex.put(nickname, new PortRecord(device.name, device.port, nickname));
                    }
                }
                
                // Build mappings from config
                if (config.mappings) {
                    const mappingNames = Object.keys(config.mappings);
                    console.log(`[WORKER] Loading ${mappingNames.length} mappings: ${mappingNames.join(', ')}`);
                    for (const [name, mapping] of Object.entries(config.mappings)) {
                        this._buildMapping(name, mapping);
                    }
                }
            } else {
                console.log('[WORKER] No config.json found, using defaults');
            }
        } catch (e) {
            console.error('[WORKER] Config load failed:', e.message);
        }
    }
    
    _buildMapping(name, mapping) {
        const inputs = [];
        const outputs = [];
        const filters = [];
        
        // Helper: extract port name from string or object
        const extractName = (item) => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') return item.name;
            return null;
        };
        
        // Helper: find port record by name (exact match or partial match on device prefix)
        const findPortByName = (portName, portMap) => {
            // Try exact match first
            if (portMap.has(portName)) {
                return [{ name: portName }];
            }
            // Try partial match: "Craft Synth 2.0" matches "Craft Synth 2.0:Craft Synth 2.0 MIDI 1 20:0"
            const prefix = portName.split(':')[0].trim();
            for (const [key] of portMap) {
                if (key.startsWith(prefix + ':') || key === prefix) {
                    return [{ name: key }];
                }
            }
            // Try nickname lookup from portIndex
            const records = portIndex.find(portName);
            if (records.length > 0) {
                return records.map(r => ({ name: r.name }));
            }
            // Fallback: try matching by device name (first part before colon)
            const deviceName = portName.split(':')[0].trim();
            for (const [key] of portMap) {
                if (key.includes(deviceName)) {
                    return [{ name: key }];
                }
            }
            return [];
        };
        
        // Inputs
        if (mapping.inputs && mapping.inputs.length > 0) {
            for (const inputItem of mapping.inputs) {
                const inputName = extractName(inputItem);
                if (inputName) {
                    const records = findPortByName(inputName, this.inputs);
                    inputs.push(...records);
                    // Store channel filter if present
                    if (inputItem && inputItem.channels !== null && inputItem.channels !== undefined) {
                        filters.push(new ChannelFilter(inputItem.channels));
                    }
                }
            }
        }
        
        // Outputs
        if (mapping.outputs && mapping.outputs.length > 0) {
            for (const outputItem of mapping.outputs) {
                const outputName = extractName(outputItem);
                if (outputName) {
                    const records = findPortByName(outputName, this.outputs);
                    outputs.push(...records);
                }
            }
        }
        
        // Filters
        if (mapping.filters) {
            if (mapping.filters.channels) {
                filters.push(new ChannelFilter(mapping.filters.channels));
            }
            if (mapping.filters.velocity) {
                filters.push(new VelocityFilter(mapping.filters.velocity));
            }
        }
        
        this._mappings.set(name, { inputs, outputs, filters });
        console.log(`[WORKER] Mapping built: ${name} (inputs: ${inputs.length}, outputs: ${outputs.length}, filters: ${filters.length})`);
    }

    // ---- DAW: play/stop a clip in loop ----
    _startTrackPlayback(trackIdx, slot) {
        this._stopTrackPlayback(trackIdx);
        const clip = this.daw.tracks[trackIdx].clips[slot];
        if (!clip || clip.notes.length === 0) return;

        const msPerBeat = (60 / this.daw.tempo / 4) * 1000;
        const loopMs = Math.max(250, this.daw.loopLenBeats * msPerBeat);
        const self = this;

        // LED feedback for this track: glow + downbeat flash each loop
        const leadNote = this._padNoteForTrack(trackIdx, slot);
        if (leadNote != null) {
            // clear any prior glow on this note (e.g. red arm -> cyan play)
            const cleared = this._sendToAllOutputs([0x80 | 0, leadNote & 0x7f, 0], 'clear-led');
            if (cleared === 0) console.warn(`[WORKER] Failed to clear LED for note ${leadNote}`);
            this._ledGlow.set(trackIdx, { note: leadNote, color: 'cyan' });
            this._setLed(leadNote, 'cyan', 0.5);   // steady glow
        }

        const runLoop = () => {
            const t0 = performance.now();

            // downbeat flash (full brightness pulse at beat 0 of the loop)
            if (leadNote != null) this._flashLed(leadNote, 1.0, 90);

            for (const n of clip.notes) {
                const delay = Math.max(0, (n.start * msPerBeat) - (performance.now() - t0));
                setTimeout(() => self._sendToAllOutputs(noteOn(n.channel - 1, n.note, n.velocity)), delay);
                const offDelay = Math.max(0, ((n.start + n.dur) * msPerBeat) - (performance.now() - t0));
                setTimeout(() => self._sendToAllOutputs(noteOff(n.channel - 1, n.note)), offDelay);
            }
        };

        runLoop();
        this._trackPlayTimers.set(trackIdx, setInterval(runLoop, loopMs));
    }

    _stopTrackPlayback(trackIdx) {
        const t = this._trackPlayTimers.get(trackIdx);
        if (t) { clearInterval(t); this._trackPlayTimers.delete(trackIdx); }
        // clear LED glow for a stopped track
        const glow = this._ledGlow.get(trackIdx);
        if (glow) { this._clearLed(glow.note); this._ledGlow.delete(trackIdx); }
    }

    _sendToAllOutputs(bytes, label = '') {
        let sent = 0;
        for (const [name, midiOut] of this.outputs) {
            try {
                midiOut.sendMessage(bytes);
                sent++;
            } catch (e) {
                console.warn(`[WORKER] Failed to send ${label} to ${name}: ${e.message}`);
            }
        }
        return sent;
    }

    // ---- LED feedback (LaunchKey RGB pads via note velocity) ----
    // Novation LaunchKey maps note-on velocity to a ~8-colour wheel.
    _LED_COLORS = {
        off: 0, red: 127, orange: 112, yellow: 96, green: 81,
        cyan: 65, blue: 50, purple: 34, pink: 19,
    };

    // representative pad note for a (track, slot)
    _padNoteForTrack(trackIdx, slot) {
        let found = null;
        for (const [note, m] of this.padMap.entries()) {
            if (m.trackIdx === trackIdx && m.slot === slot) found = note; // last wins
        }
        return found;
    }

    _ledVelocity(color, brightness = 1) {
        const base = this._LED_COLORS[color] || 0;
        return Math.max(0, Math.min(127, Math.round(base * Math.max(0, Math.min(1, brightness)))));
    }

    // set a steady glow (sends noteOn; noteOff kept until cleared/overwritten)
    _setLed(note, color, brightness) {
        const vel = this._ledVelocity(color, brightness);
        if (vel === 0) return;
        const sent = this._sendToAllOutputs([0x90 | 0, note & 0x7f, vel], `LED ${color}`);
        if (sent === 0) console.warn(`[WORKER] Failed to set LED ${color} for note ${note}`);
    }

    // flash: bright pulse that auto-offers after ms
    _flashLed(note, brightness, ms) {
        const vel = this._ledVelocity('red', brightness);   // downbeat = bright red pulse
        if (vel === 0) return;
        const sent = this._sendToAllOutputs([0x90 | 0, note & 0x7f, vel], `LED flash`);
        if (sent === 0) console.warn(`[WORKER] Failed to flash LED for note ${note}`);
        setTimeout(() => {
            const cleared = this._sendToAllOutputs([0x80 | 0, note & 0x7f, 0], 'clear-led');
            if (cleared === 0) console.warn(`[WORKER] Failed to clear flash LED for note ${note}`);
        }, ms);
    }

    _clearLed(note) {
        const cleared = this._sendToAllOutputs([0x80 | 0, note & 0x7f, 0], 'clear-led');
        if (cleared === 0) console.warn(`[WORKER] Failed to clear LED for note ${note}`);
    }

    // arm-rec glow: red pulse for the track's pad(s)
    _armLed(trackIdx) {
        const leadNote = this._padNoteForTrack(trackIdx, 0);
        if (leadNote == null) return;
        this._ledGlow.set(trackIdx, { note: leadNote, color: 'red' });
        this._setLed(leadNote, 'red', 0.7);
    }

    // Incoming MIDI note from a controller: trigger pad / arm-rec / finalize
    _handleControllerNote(note, velocity, channel, now) {
        const isPad = this.padMap.has(note);
        const isDAWPad = channel === 1 && note >= 112 && note <= 127; // DAW mode pads

        // While recording and the pressed key is NOT a mapped pad -> record it
        if (this.daw.recording && !isPad && !isDAWPad) {
            const statusByte = 0x90 | ((channel - 1) & 0x0f);
            this.daw.recordEvent(statusByte, note, velocity, now);
        }

        // Handle DAW mode pads (Ch1, notes 112-127)
        if (isDAWPad) {
            if (velocity > 0) {
                // Find the pad mapping for this note
                const padMapping = this.padMap.get(note);
                if (padMapping) {
                    const { trackIdx, slot } = padMapping;
                    const res = this.daw.triggerPad(trackIdx, slot, now);
                    if (res.action === 'play') {
                        this._startTrackPlayback(trackIdx, slot);
                    } else if (res.action === 'stop') {
                        this._stopTrackPlayback(trackIdx);
                    } else if (res.action === 'record' || res.action === 'overdub') {
                        this._armLed(trackIdx);
                    }
                }
            } else {
                // DAW pad release: clear LED glow if not recording
                const padMapping = this.padMap.get(note);
                if (padMapping && !this.daw.recording) {
                    const glow = this._ledGlow.get(padMapping.trackIdx);
                    if (glow) { this._clearLed(glow.note); this._ledGlow.delete(padMapping.trackIdx); }
                }
            }
            return; // DAW mode pads handled separately
        }

        if (velocity > 0) {
            if (isPad) {
                const { trackIdx, slot } = this.padMap.get(note);
                const res = this.daw.triggerPad(trackIdx, slot, now);
                if (res.action === 'play') {
                    this._startTrackPlayback(trackIdx, slot);
                } else if (res.action === 'stop') {
                    this._stopTrackPlayback(trackIdx);
                } else if (res.action === 'record' || res.action === 'overdub') {
                    // armed for recording -> red glow on the pad
                    this._armLed(trackIdx);
                }
                // record / overdub -> wait for pad release
            }
        } else {
            // note-off: releasing a pad during recording finalizes and plays the clip
            if (isPad && this.daw.recording) {
                const { trackIdx, slot } = this.padMap.get(note);
                this.daw._stopRecording();
                this.daw.quantizeClip(trackIdx, slot);
                this._startTrackPlayback(trackIdx, slot);
            } else if (isPad) {
                // Non-recording pad release: clear LED glow
                const glow = this._ledGlow.get(this.padMap.get(note).trackIdx);
                if (glow) { this._clearLed(glow.note); this._ledGlow.delete(this.padMap.get(note).trackIdx); }
            }
        }
    }

    // ---- Обработка кнопок транспорта и записи (CC) ----
    // Launchkey Mini MK3 DAW mode:
    // Ch16, CC 115 = Play, CC 116 = Stop, CC 117 = Record, CC 118 = Loop
    // Ch7, CC 29 = pad mode (0x02=DAW, 0x01=Drum, 0x0F=DAW Drum)
    _handleControllerCC(cc, value, channel, now) {
        if (channel === 16) {
            // Transport commands on Ch16
            if (cc === 115) { // Play
                if (value > 0) {
                    this.handleDawControl({ type: 'daw_start_transport' });
                }
            } else if (cc === 116) { // Stop
                if (value > 0) {
                    this.handleDawControl({ type: 'daw_stop_transport' });
                }
            } else if (cc === 117) { // Record
                if (value > 0) {
                    // Toggle record mode: none -> replace -> overdub -> none
                    const modes = ['none', 'replace', 'overdub'];
                    const currentIdx = modes.indexOf(this.daw.recordMode);
                    const nextMode = modes[(currentIdx + 1) % modes.length];
                    this.handleDawControl({ type: 'daw_set_record_mode', mode: nextMode });
                }
            } else if (cc === 118) { // Loop
                if (value > 0) {
                    // Toggle loop mode on/off
                    this.handleDawControl({ type: 'daw_toggle_loop' });
                }
            }
        } else if (channel === 7 && cc === 29) {
            // Pad mode selection on Ch7
            if (value === 0x02) {
                console.log('[WORKER] DAW mode activated (pad mode 0x02)');
            } else if (value === 0x01) {
                console.log('[WORKER] Drum mode activated (pad mode 0x01)');
            } else if (value === 0x0F) {
                console.log('[WORKER] DAW Drum mode activated (pad mode 0x0F)');
            }
        }
    }

    // ---- ENUMERATE PORTS (all-to-all passthrough + DAW capture) ----
    _enumeratePorts() {
        try {
            const tempInput = new midi.Input();
            const inputCount = tempInput.getPortCount();
            tempInput.closePort();

            const tempOutput = new midi.Output();
            const outputCount = tempOutput.getPortCount();
            tempOutput.closePort();

            const realInputs = this._filterPorts(tempInput);
            const realOutputs = this._filterPorts(tempOutput);

            // INPUT PORTS
            const newInputNames = new Set(realInputs.map(r => r.name));
            for (const [deviceName, input] of this.inputs) {
                if (!newInputNames.has(deviceName)) {
                    console.log(`[WORKER] Input removed: ${deviceName}`);
                    if (input._handler) input.off('message', input._handler);
                    input.closePort();
                    this.inputs.delete(deviceName);
                    this.controllerInputs.delete(deviceName);
                }
            }
            for (const newPort of realInputs) {
                const deviceName = newPort.name;
                if (!this.inputs.has(deviceName)) {
                    try {
                        const midiIn = new midi.Input();
                        midiIn.openPort(newPort.index, 'midirouter-in');
                        const self = this;
                        const handler = (deltaTime, message) => self._onIncomingMessage(deviceName, deltaTime, Array.from(message));
                        midiIn.on('message', handler);
                        midiIn._handler = handler;
                        this.inputs.set(deviceName, midiIn);
                        console.log(`[WORKER] Input opened: ${deviceName} (index: ${newPort.index})`);
                    } catch (e) {
                        console.error(`[WORKER] Failed to open input ${deviceName}:`, e.message);
                    }
                } else if (this.inputs.get(deviceName)._index !== newPort.index) {
                    const existing = this.inputs.get(deviceName);
                    if (existing._handler) existing.off('message', existing._handler);
                    existing.closePort();
                    const midiIn = new midi.Input();
                    midiIn.openPort(newPort.index, 'midirouter-in');
                    const self = this;
                    const handler = (deltaTime, message) => self._onIncomingMessage(deviceName, deltaTime, Array.from(message));
                    midiIn.on('message', handler);
                    midiIn._handler = handler;
                    midiIn._index = newPort.index;
                    this.inputs.set(deviceName, midiIn);
                    console.log(`[WORKER] Input reopened: ${deviceName} (index: ${newPort.index})`);
                }
            }

            // OUTPUT PORTS
            const newOutputNames = new Set(realOutputs.map(r => r.name));
            for (const [deviceName, output] of this.outputs) {
                if (!newOutputNames.has(deviceName)) {
                    console.log(`[WORKER] Output removed: ${deviceName}`);
                    output.closePort();
                    this.outputs.delete(deviceName);
                }
            }
            for (const newOutput of realOutputs) {
                const deviceName = newOutput.name;
                if (!this.outputs.has(deviceName)) {
                    try {
                        const out = new midi.Output();
                        out.openPort(newOutput.index, 'midirouter-out');
                        this.outputs.set(deviceName, out);
                        console.log(`[WORKER] Output opened: ${deviceName} (index: ${newOutput.index})`);
                    } catch (e) {
                        console.error(`[WORKER] Failed to open output ${deviceName}:`, e.message);
                    }
                }
            }

            for (const name of newInputNames) this.controllerInputs.add(name);

            // Auto-activate DAW mode and apply default pad map for Launchkey Mini MK3
            const hasLaunchkey = [...newInputNames, ...newOutputNames].some(n => n.toLowerCase().includes('launchkey'));
            if (hasLaunchkey) {
                this._enterDawMode();
                this._applyDefaultPadMap();
            }

            // Отправить panic note-off чтобы сбросить зажатые ноты при запуске
            this.sendPanicNoteOff();

            const inputList = [...this.inputs.entries()].map(([id, port]) => ({ id, name: id }));
            const outputList = [...this.outputs.entries()].map(([id, port]) => ({ id, name: id }));

            parentPort.postMessage({ type: 'ports-enumerated', inputs: inputList, outputs: outputList });
            parentPort.postMessage({ type: 'ready' });
        } catch (e) {
            console.error('[WORKER] Enumerate failed:', e.message);
        }
    }

    _filterPorts(device) {
        const count = device.getPortCount();
        const real = [];
        for (let i = 0; i < count; i++) {
            const name = device.getPortName(i);
            const lower = name.toLowerCase();
            // Check against ignore list
            const isIgnored = this._ignoreDevices.some(ignore => lower.includes(ignore.toLowerCase()));
            if (!isIgnored) {
                real.push({ index: i, name });
            }
        }
        return real;
    }

    _onIncomingMessage(deviceName, deltaTime, bytes) {
        const status = bytes[0];
        const type = (status & 0xf0) >> 4;
        const channel = type >= 8 ? (status & 0x0f) + 1 : 1;
        
        const label = {
            '9': `noteOn   ch${channel} n${bytes[1]} v${bytes[2]}`,
            '8': `noteOff  ch${channel} n${bytes[1]}`,
            '7': `CC       ch${channel} cc${bytes[1]} val${bytes[2]}`,
            'a': `afterCh  ch${channel} n${bytes[1]} v${bytes[2]}`,
            'c': `progCh   ch${channel} ${bytes[1]}`,
            'e': `chanPr   ch${channel} ${bytes[1]}`,
        }[String(type)];
        const name = label || (type >= 8 ? `sys  ${bytes[0] === 0xf8 ? 'timing clock' : bytes[0] === 0xfa ? 'start' : bytes[0] === 0xfb ? 'continue' : bytes[0] === 0xfc ? 'stop' : bytes[0] === 0xfe ? 'active sensing' : 'unknown sys'}` : `raw#${bytes.join(',')}`);

        // Skip loopback/timer/Midi Through ports to prevent feedback loops
        const isLoopback = deviceName.toLowerCase().includes('loopback') ||
                           deviceName.toLowerCase().includes('timer') ||
                           deviceName.toLowerCase().includes('midi through');
        const isDAWPort = deviceName.toLowerCase().includes('daw port');
        const isSysEx = bytes[0] === 0xf0; // SysEx starts with 0xF0
        
        if (isLoopback) {
            console.log(`[MIDI] [LOOPBACK] Ignoring: ${name}`);
            return;
        }
        
        // DAW Port: разрешаем CC, SysEx и все Note On (транспорт/пэды)
        if (isDAWPort) {
            const isCC = type === 7;
            const isSysExMsg = bytes[0] === 0xf0;
            const isNoteOn = type === 9 && bytes.length >= 3; // Все Note On
            if (!isCC && !isSysExMsg && !isNoteOn) {
                console.log(`[MIDI] [LOOPBACK] Ignoring DAW Port: ${name}`);
                return;
            }
            
            // CC команды от knobs — транслируем и маршрутизируем
            if (isCC) {
                const message = {
                    bytes: Buffer.from(bytes),
                    type: type,
                    channel: channel - 1,
                    velocity: bytes[2] || 0,
                    note: bytes[1] || 0
                };
                
                // Транслируем через CCMapper ко всем выходам кроме DAW Port
                for (const [, outputPort] of this.outputs) {
                    const outName = [...this.outputs.keys()][[...this.outputs.values()].indexOf(outputPort)];
                    if (!outName.toLowerCase().includes('daw port')) {
                        try {
                            const transformed = this.ccMapper.transformCC(message, deviceName, outName, 'default');
                            outputPort.sendMessage(transformed.bytes);
                            console.log(`[MIDI] ${deviceName} -> ${outName}: CC${transformed.bytes[1]} (transl)`);
                        } catch (e) {
                            console.warn(`[MIDI] Failed to transform/send CC from ${deviceName} -> ${outName}: ${e.message}`);
                        }
                    }
                }
                return;
            }
            
            // Note On — обрабатываем внутренне, не маршрутизируем
            if (isNoteOn) {
                this._handleControllerNote(bytes[1], bytes[2] || 0, channel, performance.now());
                return; // Не маршрутизируем дальше
            }
        }
        
        // Обработка SysEx от любого порта (Launchkey DAW, Midi Through и т.д.)
        if (isSysEx) {
            this._handleLaunchkeySysEx(deviceName, bytes);
            return;
        }
        
        // Обработка CC (контроллер транспорта/записи)
        if (type === 7) {
            const cc = bytes[1];
            const value = bytes[2] || 0;
            const now = performance.now();
            this._handleControllerCC(cc, value, channel, now);
        }

        // Create message object for filters
        const message = {
            bytes: Buffer.from(bytes),
            type: type,
            channel: channel - 1,
            velocity: bytes[2] || 0,
            note: bytes[1] || 0
        };

        // Process through mappings
        let processed = message;
        for (const [routeId, mapping] of this._mappings) {
            // Check if this input is in the mapping
            const isInMapping = mapping.inputs.some(input => input.name === deviceName);
            if (!isInMapping) continue;
            
            // Apply filters
            for (const filter of mapping.filters) {
                const result = filter.process(processed);
                if (result === false) {
                    console.log(`[MIDI] [FILTER] Dropped: ${name} channel=${processed.channel+1}`);
                    return;
                }
                processed = result;
            }
            
            // Трансляция CC команд через CCMapper
            if (type === 7) { // Control Change
                for (const output of mapping.outputs) {
                    const outputPort = this.outputs.get(output.name);
                    if (outputPort) {
                        const transformed = this.ccMapper.transformCC(
                            processed, deviceName, output.name, routeId
                        );
                        if (transformed) {
                            try {
                                outputPort.sendMessage(transformed.bytes);
                                console.log(`[MIDI] ${deviceName} -> ${output.name}: CC${processed.bytes[1]} (transl)`);
                            } catch (e) {
                                console.error(`[MIDI] Failed to send to ${output.name}:`, e.message);
                            }
                        }
                    }
                }
            } else {
                // Note/other messages — обычная маршрутизация
                for (const output of mapping.outputs) {
                    const outputPort = this.outputs.get(output.name);
                    if (outputPort) {
                        try {
                            outputPort.sendMessage(processed.bytes);
                            console.log(`[MIDI] ${deviceName} -> ${output.name}: ${name}`);
                        } catch (e) {
                            console.error(`[MIDI] Failed to send to ${output.name}:`, e.message);
                        }
                    }
                }
            }
        }
        
        // If no mappings matched, use default all-to-all routing
        // Но DAW Port сообщения не маршрутизируем — они только для внутреннего управления
        if (this._mappings.size === 0 && !isDAWPort) {
            let sent = 0;
            for (const [, midiOut] of this.outputs) {
                try {
                    let outMsg = Buffer.from(bytes);
                    // Трансляция CC команд — преобразуем CC номера через CCMapper
                    if (type === 7) {
                        const transformed = this.ccMapper.transformCC(
                            message, deviceName, 'default', 'default'
                        );
                        if (transformed && transformed.bytes) {
                            outMsg = transformed.bytes;
                        }
                    }
                    midiOut.sendMessage(outMsg);
                    sent++;
                } catch (e) {
                    console.warn(`[MIDI] Failed to send ${name} to ${midiOut._name || 'unknown'}: ${e.message}`);
                }
            }
            if (sent > 0) {
                console.log(`[MIDI] ${deviceName} -> ${sent}/${this.outputs.size} outs: ${name}`);
            }
        } else if (isDAWPort && this._mappings.size === 0) {
            console.log(`[MIDI] DAW Port message processed internally only: ${name}`);
        }
    }

    // ---- DAW control from server ----
    handleDawControl(msg) {
        const daw = this.daw;
        switch (msg.type) {
            case 'daw_request_state':
                // Отправить текущее состояние DAW при запросе от фронтенда
                this._broadcastState();
                break;
            case 'daw_set_tempo':
                daw.setTempo(msg.bpm);
                this._broadcastState();
                break;
            case 'daw_tap_tempo':
                if (!this._tapTimes) this._tapTimes = [];
                const now = performance.now();
                this._tapTimes.push(now);
                if (this._tapTimes.length > 4) this._tapTimes.shift();
                if (this._tapTimes.length >= 2) {
                    const iv = (this._tapTimes[this._tapTimes.length - 1] - this._tapTimes[this._tapTimes.length - 2]) / 1000;
                    daw.setTempo(Math.max(20, Math.min(300, 60 / iv)));
                }
                this._broadcastState();
                break;
            case 'daw_set_record_mode':
                daw.setRecordMode(msg.mode);
                this._broadcastState();
                break;
            case 'daw_set_slots':
                daw.setSlotsPerTrack(msg.n);
                this._broadcastState();
                break;
            case 'daw_pad_learn':
                this.autoAssign = !!msg.on;
                if (this.autoAssign) this._learnCursor = 0;
                this._broadcastPadMap();
                break;
            case 'daw_pad_map':
                if (msg.note != null && msg.trackIdx != null && msg.slot != null) {
                    this.padMap.set(msg.note, { trackIdx: msg.trackIdx, slot: msg.slot });
                    this._broadcastPadMap();
                }
                break;
            case 'daw_pad_trigger':
                // simulate a pad press from the web UI
                this.daw.triggerPad(msg.trackIdx, msg.slot, performance.now());
                break;
            case 'daw_apply_state':
                if (msg.state.tempo != null) daw.setTempo(msg.state.tempo);
                if (msg.state.recordMode != null) daw.setRecordMode(msg.state.recordMode);
                if (msg.state.slotsPerTrack != null) daw.setSlotsPerTrack(msg.state.slotsPerTrack);
                if (msg.state.metronomeEnabled != null) daw.setMetronome(msg.state.metronomeEnabled);
                this._broadcastState();
                break;
            case 'daw_metronome_toggle':
                daw.setMetronome(!daw._metronomeEnabled);
                this._broadcastState();
                break;
            case 'daw_metronome_on':
                daw.setMetronome(true);
                this._broadcastState();
                break;
            case 'daw_metronome_off':
                daw.setMetronome(false);
                this._broadcastState();
                break;
            case 'daw_metronome_note':
                if (msg.note != null) daw.setMetronomeNote(msg.note);
                break;
            case 'daw_metronome_beats_per_measure':
                if (msg.bpm != null) daw.setMetronomeBeatsPerMeasure(msg.bpm);
                this._broadcastState();
                break;
            case 'daw_start_transport':
                if (!this._transportPlaying) {
                    daw.startTransport();
                    this._transportPlaying = true;
                }
                this._broadcastState();
                break;
            case 'daw_stop_transport':
                if (this._transportPlaying) {
                    daw.stopTransport();
                    this._transportPlaying = false;
                }
                this._broadcastState();
                break;
            case 'daw_toggle_loop':
                // Toggle loop mode: toggle loopLenBeats between 16 and 4
                daw.loopLenBeats = daw.loopLenBeats === 16 ? 4 : 16;
                this._broadcastState();
                console.log(`[WORKER] Loop toggled to ${daw.loopLenBeats} beats`);
                break;
            case 'daw_arm_track':
                if (msg.trackIdx != null) {
                    daw.armTrack(msg.trackIdx);
                    this._broadcastState();
                }
                break;
            case 'daw_mute_track':
                if (msg.trackIdx != null) {
                    daw.muteTrack(msg.trackIdx);
                    this._broadcastState();
                }
                break;
            case 'daw_solo_track':
                if (msg.trackIdx != null) {
                    daw.soloTrack(msg.trackIdx);
                    this._broadcastState();
                }
                break;
        }
    }

    _broadcastState() {
        parentPort.postMessage({ type: 'daw_state', state: this.daw.getState() });
    }

    _broadcastPadMap() {
        parentPort.postMessage({
            type: 'daw_pad_map_list',
            map: [...this.padMap.entries()].map(([note, m]) => ({ note, trackIdx: m.trackIdx, slot: m.slot })),
            learnMode: this.autoAssign,
        });
    }

    _enterDawMode() {
        // Send DAW mode activation to Launchkey Mini MK3
        // Message: Note On on channel 16, note=12 (C-1), velocity=127
        // This tells the controller to enter Session mode (same protocol Ableton Live uses)
        if (this._dawModeSent) return;
        const bytes = [0x9f, 12, 127]; // Note On ch16, note 12, vel 127
        for (const [name, output] of this.outputs) {
            if (name.toLowerCase().includes('launchkey')) {
                try {
                    output.sendMessage(bytes);
                    console.log('[WORKER] DAW mode activation sent to', name);
                } catch (e) {
                    console.error('[WORKER] Failed to send DAW mode to', name, e.message);
                }
            }
        }
        this._dawModeSent = true;
    }

    _applyDefaultPadMap() {
        // Apply default pad mapping for Launchkey Mini MK3
        if (this.padMap.size > 0) return; // Don't overwrite existing mapping
        
        // DAW Mode pads: Ch1, notes 112-127 (0x70-0x7F)
        // 2 rows x 8 columns -> 8 tracks, 2 slots
        // Bottom row (112-119): slot 0
        // Top row (120-127): slot 1
        for (let col = 0; col < 8; col++) {
            // Bottom row -> slot 0
            this.padMap.set(112 + col, { trackIdx: col, slot: 0 });
            // Top row -> slot 1
            this.padMap.set(120 + col, { trackIdx: col, slot: 1 });
        }
        console.log('[WORKER] Default pad map applied:', this.padMap.size, 'pads');
        this._broadcastPadMap();
    }
    
    // ---- Обработка SysEx от Launchkey Mini MK3 DAW Port ----
    _handleLaunchkeySysEx(deviceName, bytes) {
        // Novation SysEx формат: F0 00 20 29 02 05 [data] F7
        // Проверяем заголовок Novation
        if (bytes.length < 8 || bytes[0] !== 0xf0) return;
        if (bytes[1] !== 0x00 || bytes[2] !== 0x20 || bytes[3] !== 0x29 || bytes[4] !== 0x02 || bytes[5] !== 0x05) return;
        
        // bytes[6] = device ID, bytes[7] = command type
        const cmdType = bytes[7];
        const cmdData = bytes.slice(8, bytes.length > 8 ? bytes.length - 1 : bytes.length); // без F7
        
        console.log(`[MIDI] [LAUNCHKEY SYX] ${deviceName}: ${bytes.slice(1, bytes.length > 8 ? bytes.length - 1 : bytes.length).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ')}`);
        
        // Команды Launchkey Mini MK3 в Session mode:
        // 0x01 = DAW status (состояние DAW)
        // 0x02 = Pad state (состояние пэдов)
        // 0x03 = Transport (play/stop/record)
        // 0x04 = Clip slot state
        
        switch (cmdType) {
            case 0x01: // DAW status
                this._handleDawStatus(cmdData);
                break;
            case 0x02: // Pad state
                this._handlePadState(cmdData);
                break;
            case 0x03: // Transport
                this._handleTransport(cmdData);
                break;
            case 0x04: // Clip slot
                this._handleClipSlot(cmdData);
                break;
            default:
                console.log(`[MIDI] [LAUNCHKEY SYX] Unknown cmd: 0x${cmdType.toString(16)}`);
        }
    }
    
    /**
     * Обработка DAW status от Launchkey Mini MK3
     * Формат данных: bytes[0] = статус (0x00=off, 0x01=on)
     */
    _handleDawStatus(data) {
        if (!data || data.length === 0) return;
        const status = data[0];
        console.log(`[MIDI] [LAUNCHKEY] DAW status: ${status}`);
        // Запрашиваем текущее состояние у worker'а
        this.handleDawControl({ type: 'daw_request_state' });
    }
    
    /**
     * Обработка состояния пэдов (нажатие/отпускание)
     * Формат: bytes[0] = номер пэда (1-32), bytes[1] = velocity (0=release, 1-127=press)
     */
    _handlePadState(data) {
        if (!data || data.length < 2) return;
        const padNum = data[0];  // 1-based номер пэда
        const velocity = data[1];
        
        // Преобразуем номер пэда в MIDI note (DAW mode: notes 112-127)
        // Pad 1 -> note 112, Pad 2 -> note 113, ...
        const midiNote = 111 + padNum;
        
        console.log(`[MIDI] [LAUNCHKEY] Pad ${padNum} (note ${midiNote}) velocity ${velocity}`);
        
        // Симулируем входящее MIDI-событие NoteOn/NoteOff
        const now = performance.now();
        if (velocity > 0) {
            this._handleControllerNote(midiNote, velocity, 1, now);
        } else {
            // Pad release — обрабатываем как note-off
            this._handleControllerNote(midiNote, 0, 1, now);
        }
    }
    
    /**
     * Обработка команд транспорта (Play/Stop/Record)
     * Формат: bytes[0] = команда (0x01=play, 0x02=stop, 0x03=record)
     */
    _handleTransport(data) {
        if (!data || data.length === 0) return;
        const cmd = data[0];
        
        switch (cmd) {
            case 0x01: // Play
                console.log('[MIDI] [LAUNCHKEY] Transport: PLAY');
                this.handleDawControl({ type: 'daw_start_transport' });
                break;
            case 0x02: // Stop
                console.log('[MIDI] [LAUNCHKEY] Transport: STOP');
                this.handleDawControl({ type: 'daw_stop_transport' });
                break;
            case 0x03: // Record
                console.log('[MIDI] [LAUNCHKEY] Transport: RECORD');
                // Toggle record mode
                const modes = ['none', 'replace', 'overdub'];
                const currentIdx = modes.indexOf(this.daw.recordMode);
                const nextMode = modes[(currentIdx + 1) % modes.length];
                this.handleDawControl({ type: 'daw_set_record_mode', mode: nextMode });
                break;
            default:
                console.log(`[MIDI] [LAUNCHKEY] Transport unknown cmd: 0x${cmd.toString(16)}`);
        }
    }
    
    /**
     * Обработка состояния слота клипа
     * Формат: bytes[0] = track number (0-based), bytes[1] = slot state (0=stopped, 1=playing)
     */
    _handleClipSlot(data) {
        if (!data || data.length < 2) return;
        const trackNum = data[0];
        const slotState = data[1];
        
        console.log(`[MIDI] [LAUNCHKEY] Clip slot: track=${trackNum} state=${slotState}`);
        // Синхронизируем состояние — запрашиваем актуальное состояние у worker'а
        if (slotState === 0) {
            // Слот остановлен — если у нас он играет, останавливаем
            const currentTrack = this.daw.clipState[trackNum];
            if (currentTrack >= 0) {
                this._stopTrackPlayback(trackNum);
                this.daw.setClipPlay(trackNum, -1);
            }
        } else {
            // Слот играет — запрашиваем обновление состояния
            this.handleDawControl({ type: 'daw_request_state' });
        }
    }

    cleanup() {
        // Stop hot-plug detection
        if (this._hotplugCheckInterval) {
            clearInterval(this._hotplugCheckInterval);
            this._hotplugCheckInterval = null;
        }

        for (const [, t] of this._trackPlayTimers) clearInterval(t);
        this._trackPlayTimers.clear();
        for (const [, input] of this.inputs) {
            if (input._handler) input.off('message', input._handler);
            try { input.closePort(); } catch(e) {}
        }
        for (const [, output] of this.outputs) {
            try { output.closePort(); } catch(e) {}
        }
    }
    
    // ---- Hot-plug: пересборка портов при подключении/отключении устройств ----
    _handleHotplug() {
        console.log('[WORKER] Hot-plug event detected, rescanning...');
        this._enumeratePorts();
    }
    
    // ---- Rebuild mappings from config ----
    rebuildMappings() {
        if (!this._config || !this._config.mappings) return;
        
        this._mappings.clear();
        for (const [name, mapping] of Object.entries(this._config.mappings)) {
            this._buildMapping(name, mapping);
        }
        console.log('[WORKER] Mappings rebuilt');
    }
    
    // ---- Panic: send All Notes Off to all outputs on all channels ----
    sendPanicNoteOff() {
        if (this.outputs.size === 0) return;
        console.log('[WORKER] Sending All Notes Off to all outputs...');
        try {
            this.outputs.forEach((out) => {
                for (let channel = 0; channel < 16; channel++) {
                    out.sendMessage(Buffer.from([0xB0 | channel, 123, 0]));
                }
            });
            console.log('[WORKER] All Notes Off sent');
        } catch (e) {
            console.error('[WORKER] All Notes Off failed:', e.message);
        }
    }
}

const worker = new MIDIRouterWorker();

parentPort.on('message', (msg) => {
    if (msg.type === 'shutdown') {
        // Отправить panic note-off перед выключением чтобы сбросить зажатые ноты
        worker.sendPanicNoteOff();
        worker.cleanup();
        // Force exit after 1 second to prevent blocking
        setTimeout(() => process.exit(0), 1000);
        process.exit(0);
    } else if (msg.type.startsWith('daw_')) {
        worker.handleDawControl(msg);
    } else if (msg.type === 'midi_send_to_target') {
        // Отправить сырое MIDI-сообщение на целевой выход
        const targetName = msg.target;
        const bytes = Array.isArray(msg.bytes) ? msg.bytes : Array.from(msg.bytes);
        const output = worker.outputs.get(targetName);
        if (output) {
            try {
                output.sendMessage(Buffer.from(bytes));
                console.log(`[MIDI] [SERVER] -> ${targetName}: ${bytes.map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ')}`);
            } catch (e) {
                console.error(`[MIDI] [SERVER] Failed to send to ${targetName}:`, e.message);
            }
        } else {
            console.warn(`[MIDI] [SERVER] Target not found: ${targetName}`);
        }
    } else if (msg.type === 'panic_note_off') {
        // Отправить panic note-off на все выходы
        worker.sendPanicNoteOff();
    } else if (msg.type === 'reload_config') {
        // Перезагрузить конфигурацию
        worker._loadConfig();
        worker.rebuildMappings();
        parentPort.postMessage({ type: 'config_reloaded' });
    } else if (msg.type === 'rebuild_mappings') {
        // Пересборка маппингов при hot-plug событии
        worker.rebuildMappings();
    }
});

worker.init();
