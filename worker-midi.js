/* === MIDI Router — all-to-all passthrough + DAW / Clip mode === */
import midi from '@julusian/midi';
import { parentPort } from 'worker_threads';
import { DAWEngine, noteOn, noteOff } from './daw.js';
import { portIndex, PortRecord } from './port-index.js';
import { ChannelFilter, VelocityFilter, MessageTypeFilter } from './filters.js';
import { CCMapper } from './cc-mapper.js';
import { MetronomeController } from './metronome-controller.js';
import { ControllerEngine } from './controller-engine.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class MIDIRouterWorker {
    constructor() {
        this.inputs = new Map();   // deviceName -> RtMidiIn instance
        this.outputs = new Map();  // deviceName -> RtMidiOut instance

        // DAW events reach the UI; transport clock also reaches synth outputs.
        // Actual metronome audio is produced by metronome.py → aplay -M → 3.5mm jack.
        this.daw = new DAWEngine();

        // Python audio metronome controller — controls metronome.py via stdin IPC
        this.metronomeCtrl = new MetronomeController({
            bpm: this.daw.tempo,
            beats: 4,
            volume: 0.8
        });
        this._metronomeStarted = false;

        // Override DAW engine methods to also control the Python audio metronome
        const origSetTempo = this.daw.setTempo.bind(this.daw);
        this.daw.setTempo = (bpm) => {
            origSetTempo(bpm);
            if (this.metronomeCtrl) {
                this.metronomeCtrl.setBpm(bpm);
            }
        };

        const origStartMetronome = this.daw._startMetronome.bind(this.daw);
        this.daw._startMetronome = () => {
            origStartMetronome();
            if (this.metronomeCtrl && this.daw.playing) {
                this.metronomeCtrl.play();
            }
        };

        const origStopMetronome = this.daw._stopMetronome.bind(this.daw);
        this.daw._stopMetronome = () => {
            origStopMetronome();
            if (this.metronomeCtrl) {
                this.metronomeCtrl.stop();
            }
        };

        const origSetMetronome = this.daw.setMetronome.bind(this.daw);
        this.daw.setMetronome = (enabled) => {
            origSetMetronome(enabled);
            // Python metronome follows transport state + metronome toggle
            if (this.metronomeCtrl && !this.daw.playing) {
                // If not playing, stop immediately on disable
                if (!enabled) {
                    this.metronomeCtrl.stop();
                }
            }
        };

        const origStartTransport = this.daw.startTransport.bind(this.daw);
        this.daw.startTransport = () => {
            origStartTransport();
            if (this.metronomeCtrl && this.daw._metronomeEnabled) {
                this.metronomeCtrl.play();
            }
        };

        const origStopTransport = this.daw.stopTransport.bind(this.daw);
        this.daw.stopTransport = () => {
            origStopTransport();
            if (this.metronomeCtrl) {
                this.metronomeCtrl.stop();
            }
        };

        const origSetMetronomeBeats = this.daw.setMetronomeBeatsPerMeasure.bind(this.daw);
        this.daw.setMetronomeBeatsPerMeasure = (n) => {
            origSetMetronomeBeats(n);
            if (this.metronomeCtrl) {
                this.metronomeCtrl.setBeats(n);
            }
        };

        // Start Python metronome process on init (it stays ready to play)
        this.metronomeCtrl.start().then(() => {
            console.log('[WORKER] Python audio metronome started');
        }).catch((e) => {
            console.warn(`[WORKER] Failed to start Python metronome: ${e.message}`);
        });

        this.daw._onEvent = (evt) => {
            // Clock/transport must reach external instruments; audio metronome notes stay in the UI.
            if (evt.data?.length === 1 && [0xf8, 0xfa, 0xfb, 0xfc].includes(evt.data[0])) {
                this._sendToSynthOutputs(evt.data, 'MIDI clock');
            }
            parentPort.postMessage({ type: 'daw_midi', data: evt.data });
        };

        // track playback timers (loop): trackIdx -> { interval, timeouts, active }
        this._trackPlayTimers = new Map();
        // LED state per active track: trackIdx -> { slot, state }
        this._ledGlow = new Map();

        // controller input ports whose notes drive DAW trigger/recording
        this.controllerInputs = new Set();

        // Unconfigured controllers can still learn pad assignments by note.
        this.autoAssign = true;
        this._learnCursor = 0;

        // Hot-plug back-off state (exponential back-off on ALSA failures)
        this._hotplugBackoffMs = 5000;   // default interval between checks
        this._consecutiveHotplugFailures = 0;
        this.padMap = new Map();   // note(number) -> { trackIdx, slot }

        // CC Mapper — трансляция команд контроллера в команды синта
        this.ccMapper = new CCMapper();

        this.controllerEngine = ControllerEngine.fromDirectory(path.join(__dirname, 'controller_profiles'));
        
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
        // Use recursive setTimeout with back-off instead of fixed interval.
        // Back-off range: 5s (healthy) -> 30s (after repeated ALSA failures).
        this._hotplugCheckLoop();
        console.log('[WORKER] Hot-plug detection started (back-off: 5-30s)');
    }

    _hotplugCheckLoop() {
        this._checkHotplug().then((success) => {
            if (success) {
                // Healthy: back off to 5s quickly
                this._consecutiveHotplugFailures = 0;
                this._hotplugBackoffMs = 5000;
            } else {
                // ALSA failure: exponential back-off up to 30s
                this._consecutiveHotplugFailures++;
                const maxBackoff = 30000;
                this._hotplugBackoffMs = Math.min(maxBackoff, 5000 * Math.pow(2, this._consecutiveHotplugFailures - 1));
                console.log(`[WORKER] Hot-plug back-off: ${this._hotplugBackoffMs / 1000}s (failures: ${this._consecutiveHotplugFailures})`);
            }
        }).catch((e) => {
            console.error('[WORKER] Hot-plug check loop error:', e.message);
            this._consecutiveHotplugFailures++;
            this._hotplugBackoffMs = Math.min(30000, 5000 * Math.pow(2, this._consecutiveHotplugFailures - 1));
        });

        setTimeout(() => this._hotplugCheckLoop(), this._hotplugBackoffMs);
    }
    
    async _checkHotplug() {
        try {
            // Re-use persistent enumeration objects (do NOT create new ALSA clients every tick)
            if (!this._enumIn) this._enumIn = new midi.Input();
            if (!this._enumOut) this._enumOut = new midi.Output();
            const currentInputNames = new Set();
            const currentOutputNames = new Set();
            
            try {
                const ports = this._filterPorts(this._enumIn, 'in');
                for (const p of ports) currentInputNames.add(p.name);
            } catch(e) {}
            
            try {
                const ports = this._filterPorts(this._enumOut, 'out');
                for (const p of ports) currentOutputNames.add(p.name);
            } catch(e) {}
            
            const addedInputs = [];
            const removedInputs = [];
            const addedOutputs = [];
            const removedOutputs = [];
            
            for (const name of currentInputNames) {
                if (!this._lastInputNames.has(name)) addedInputs.push(name);
            }
            for (const name of this._lastInputNames) {
                if (!currentInputNames.has(name)) removedInputs.push(name);
            }
            for (const name of currentOutputNames) {
                if (!this._lastOutputNames.has(name)) addedOutputs.push(name);
            }
            for (const name of this._lastOutputNames) {
                if (!currentOutputNames.has(name)) removedOutputs.push(name);
            }
            
            // If anything changed, re-enumerate ports
            if (addedInputs.length || removedInputs.length || addedOutputs.length || removedOutputs.length) {
                console.log(`[WORKER] HOT-PLUG: changes detected. +in:${addedInputs.length} -in:${removedInputs.length} +out:${addedOutputs.length} -out:${removedOutputs.length}`);
                for (const name of addedInputs) {
                    console.log(`[WORKER] HOT-PLUG: New input: ${name}`);
                    parentPort.postMessage({ type: 'hotplug-detected', deviceName: name, action: 'added', direction: 'input' });
                }
                for (const name of removedInputs) {
                    console.log(`[WORKER] HOT-PLUG: Input removed: ${name}`);
                    parentPort.postMessage({ type: 'hotplug-detected', deviceName: name, action: 'removed', direction: 'input' });
                }
                for (const name of addedOutputs) {
                    console.log(`[WORKER] HOT-PLUG: New output: ${name}`);
                    parentPort.postMessage({ type: 'hotplug-detected', deviceName: name, action: 'added', direction: 'output' });
                }
                for (const name of removedOutputs) {
                    console.log(`[WORKER] HOT-PLUG: Output removed: ${name}`);
                    parentPort.postMessage({ type: 'hotplug-detected', deviceName: name, action: 'removed', direction: 'output' });
                }
                
                // Update tracker BEFORE re-enumeration so we don't loop forever if ALSA fails
                this._lastInputNames = currentInputNames;
                this._lastOutputNames = currentOutputNames;
                
                // FULL re-enumeration to open/close actual RtMidi ports
                try {
                    this._enumeratePorts();
                    if (this._autoRouteOnHotplug) {
                        this._rebuildMappings();
                    }
                    return true; // success
                } catch (e) {
                    console.error('[WORKER] HOT-PLUG re-enumeration failed:', e.message);
                    return false;
                }
            } else {
                this._lastInputNames = currentInputNames;
                this._lastOutputNames = currentOutputNames;
                return true; // no changes = healthy
            }
        } catch (e) {
            console.error('[WORKER] Hot-plug check failed:', e.message);
            return false;
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

        const msPerBeat = this.daw._secondsPerBeat() * 1000;
        const loopMs = Math.max(250, (clip.length || this.daw.loopLenBeats) * msPerBeat);
        const playback = { interval: null, timeouts: new Set(), active: new Map() };
        const schedule = (fn, delay) => {
            const timer = setTimeout(() => { playback.timeouts.delete(timer); fn(); }, delay);
            playback.timeouts.add(timer);
        };

        this._ledGlow.set(trackIdx, { slot, state: 'playing' });
        this._sendFeedback(trackIdx, slot, 'playing');

        const runLoop = () => {
            const t0 = performance.now();

            this._flashLed(trackIdx, slot, 90);

            for (const n of clip.notes) {
                const delay = Math.max(0, (n.start * msPerBeat) - (performance.now() - t0));
                const channel = Math.max(1, n.channel || 1);
                const key = `${channel}:${n.note}`;
                schedule(() => {
                    this._sendToSynthOutputs(noteOn(channel - 1, n.note, n.velocity > 0 ? n.velocity : 80));
                    playback.active.set(key, (playback.active.get(key) || 0) + 1);
                }, delay);
                const offDelay = Math.max(0, ((n.start + (n.dur || 0.25)) * msPerBeat) - (performance.now() - t0));
                schedule(() => {
                    this._sendToSynthOutputs(noteOff(channel - 1, n.note));
                    const count = playback.active.get(key) || 0;
                    if (count <= 1) playback.active.delete(key);
                    else playback.active.set(key, count - 1);
                }, offDelay);
            }
        };

        runLoop();
        playback.interval = setInterval(runLoop, loopMs);
        this._trackPlayTimers.set(trackIdx, playback);
    }

    _stopTrackPlayback(trackIdx) {
        const playback = this._trackPlayTimers.get(trackIdx);
        if (playback) {
            clearInterval(playback.interval);
            for (const timer of playback.timeouts) clearTimeout(timer);
            for (const key of playback.active.keys()) {
                const [channel, note] = key.split(':').map(Number);
                this._sendToSynthOutputs(noteOff(channel - 1, note));
            }
            this._trackPlayTimers.delete(trackIdx);
        }
        const glow = this._ledGlow.get(trackIdx);
        if (glow) {
            this._sendFeedback(trackIdx, glow.slot, 'off');
            this._ledGlow.delete(trackIdx);
        }
    }

    _restartActiveClips() {
        for (const [trackIdx, slot] of this.daw.clipState.entries()) {
            if (slot >= 0 && this._trackPlayTimers.has(trackIdx)) this._startTrackPlayback(trackIdx, slot);
        }
    }

    // Keep control-surface feedback outputs out of instrument routing.
    _sendToSynthOutputs(bytes, label = '') {
        let sent = 0;
        for (const [name, midiOut] of this.outputs) {
            if (this.controllerEngine.isExcludedOutput(name)) continue;
            try {
                midiOut.sendMessage(Buffer.from(bytes));
                sent++;
            } catch (e) {
                console.warn(`[WORKER] Failed to send ${label} to ${name}: ${e.message}`);
            }
        }
        return sent;
    }

    _sendFeedback(trackIdx, slot, state) {
        for (const [name, output] of this.outputs) {
            for (const bytes of this.controllerEngine.feedbackMessagesFor(name, trackIdx, slot, state)) {
                try { output.sendMessage(Buffer.from(bytes)); }
                catch (error) { console.warn(`[CONTROLLER] Feedback to ${name} failed: ${error.message}`); }
            }
        }
    }

    _flashLed(trackIdx, slot, ms) {
        this._sendFeedback(trackIdx, slot, 'flash');
        setTimeout(() => {
            const glow = this._ledGlow.get(trackIdx);
            if (glow?.slot === slot) this._sendFeedback(trackIdx, slot, glow.state);
            else this._sendFeedback(trackIdx, slot, 'off');
        }, ms);
    }

    _armLed(trackIdx, slot) {
        this._ledGlow.set(trackIdx, { slot, state: 'recording' });
        this._sendFeedback(trackIdx, slot, 'recording');
    }

    _clearStaleRecordingFeedback() {
        for (const [trackIdx, glow] of this._ledGlow) {
            if (glow.state !== 'recording') continue;
            if (this.daw.recording?.track === trackIdx && this.daw.recording?.slot === glow.slot) continue;
            this._sendFeedback(trackIdx, glow.slot, 'off');
            this._ledGlow.delete(trackIdx);
        }
    }

    _triggerPad(trackIdx, slot, now) {
        const result = this.daw.triggerPad(trackIdx, slot, now);
        this._clearStaleRecordingFeedback();
        if (result.action === 'play' || result.action === 'record-stop') {
            this._startTrackPlayback(trackIdx, slot);
        } else if (result.action === 'stop') {
            this._stopTrackPlayback(trackIdx);
        } else if (result.action === 'record' || result.action === 'overdub') {
            this._stopTrackPlayback(trackIdx);
            this.daw.clipState[trackIdx] = -1;
            this._armLed(trackIdx, slot);
        } else if (result.action === 'invalid') {
            console.warn(`[DAW] Invalid pad target track ${trackIdx}, slot ${slot}`);
        }
        this._broadcastState();
        return result;
    }

    _handleMappedPad(mapping, velocity, now) {
        // Clips toggle on a press. Releasing a pad must not end recording.
        if (mapping && velocity > 0) this._triggerPad(mapping.trackIdx, mapping.slot, now);
    }

    // ---- MIDI Clock sync (used by metronome and DAW tempo sync) ----
    _handleMidiClock(now) {
        // Sync metronome / transport to external MIDI clock.
        // 24 clocks per quarter note.
        if (!this._clockHistory) this._clockHistory = [];
        this._clockHistory.push(now);
        if (this._clockHistory.length > 48) this._clockHistory.shift();
        
        // Auto-sync BPM from clock interval (every 24 ticks = 1 quarter note)
        if (this._clockHistory.length >= 25) {
            const tick24Ms = this._clockHistory[this._clockHistory.length - 1] - this._clockHistory[this._clockHistory.length - 25];
            if (tick24Ms > 0) {
                const estimatedBpm = (60 * 1000) / tick24Ms;
                // Smooth update: only if within reasonable range
                if (estimatedBpm >= 20 && estimatedBpm <= 300) {
                    const current = this.daw.tempo;
                    const smoothed = Math.round(current * 0.9 + estimatedBpm * 0.1);
                    if (Math.abs(smoothed - current) > 1) {
                        this.daw.setTempo(smoothed);
                        if (this.metronomeCtrl) this.metronomeCtrl.setBpm(smoothed);
                    }
                }
            }
        }
        
        // Emit DAW clock event so UI can sync
        parentPort.postMessage({ type: 'daw_midi', data: [0xf8] });
    }

    // Controller transport actions are defined by each profile.
    _handleProfileTransport(action) {
        if (action === 'play') this.handleDawControl({ type: 'daw_start_transport' });
        else if (action === 'stop') this.handleDawControl({ type: 'daw_stop_transport' });
        else if (action === 'loop') this.handleDawControl({ type: 'daw_toggle_loop' });
        else if (action === 'record') {
            const modes = ['none', 'replace', 'overdub'];
            const nextMode = modes[(modes.indexOf(this.daw.recordMode) + 1) % modes.length];
            this.handleDawControl({ type: 'daw_set_record_mode', mode: nextMode });
        }
    }

    // ---- ENUMERATE PORTS (two-phase: open new first, then close old) ----
    _enumeratePorts() {
        try {
            // Use one persistent RtMidi object for enumeration to avoid ALSA client leak
            if (!this._enumIn) { this._enumIn = new midi.Input(); }
            if (!this._enumOut) { this._enumOut = new midi.Output(); }

            const realInputs = this._filterPorts(this._enumIn, 'in');
            const realOutputs = this._filterPorts(this._enumOut, 'out');
            const newInputNames = new Set(realInputs.map(r => r.name));
            const newOutputNames = new Set(realOutputs.map(r => r.name));

            // PHASE 1: Determine what to add / remove / reopen
            const inputsToOpen = [];     // { name, index }
            const inputsToRemove = [];     // name
            const inputsToReopen = [];     // { name, oldPort, newIndex }

            for (const [deviceName, input] of this.inputs) {
                if (!newInputNames.has(deviceName)) {
                    inputsToRemove.push(deviceName);
                } else {
                    const newPort = realInputs.find(r => r.name === deviceName);
                    if (newPort && input._index !== undefined && input._index !== newPort.index) {
                        inputsToReopen.push({ name: deviceName, oldPort: input, newIndex: newPort.index });
                    }
                }
            }
            for (const newPort of realInputs) {
                if (!this.inputs.has(newPort.name)) {
                    inputsToOpen.push({ name: newPort.name, index: newPort.index });
                }
            }

            const outputsToOpen = [];     // { name, index }
            const outputsToRemove = [];   // name
            const outputsToReopen = [];   // { name, oldPort, newIndex }
            for (const [deviceName, output] of this.outputs) {
                if (!newOutputNames.has(deviceName)) {
                    outputsToRemove.push(deviceName);
                } else {
                    const newPort = realOutputs.find(r => r.name === deviceName);
                    if (newPort && output._index !== undefined && output._index !== newPort.index) {
                        outputsToReopen.push({ name: deviceName, oldPort: output, newIndex: newPort.index });
                    }
                }
            }
            for (const newPort of realOutputs) {
                if (!this.outputs.has(newPort.name)) {
                    outputsToOpen.push({ name: newPort.name, index: newPort.index });
                }
            }

            // PHASE 2: Open new inputs (if ANY fails, abort — don't touch existing)
            const openedInputs = new Map();
            for (const { name, index } of inputsToOpen) {
                try {
                    const midiIn = new midi.Input();
                    midiIn.openPort(index, 'midirouter-in');
                    // RtMidi ignores SysEx and timing messages unless enabled.
                    midiIn.ignoreTypes(false, false, true);
                    const self = this;
                    const handler = (deltaTime, message) => self._onIncomingMessage(name, deltaTime, Array.from(message));
                    midiIn.on('message', handler);
                    midiIn._handler = handler;
                    midiIn._index = index;
                    openedInputs.set(name, midiIn);
                    console.log(`[WORKER] Input opened: ${name} (index: ${index})`);
                } catch (e) {
                    console.error(`[WORKER] Failed to open input ${name}:`, e.message);
                    // Close any already-opened inputs to avoid partial state
                    for (const [, inp] of openedInputs) {
                        try { inp.off('message', inp._handler); inp.closePort(); } catch (_) {}
                    }
                    console.warn('[WORKER] _enumeratePorts aborted: input open failed');
                    return; // Keep existing inputs untouched
                }
            }

            // PHASE 3: Open new outputs
            const openedOutputs = new Map();
            for (const { name, index } of outputsToOpen) {
                try {
                    const out = new midi.Output();
                    out.openPort(index, 'midirouter-out');
                    out._index = index;
                    openedOutputs.set(name, out);
                    console.log(`[WORKER] Output opened: ${name} (index: ${index})`);
                } catch (e) {
                    console.error(`[WORKER] Failed to open output ${name}:`, e.message);
                    for (const [, inp] of openedInputs) {
                        try { inp.off('message', inp._handler); inp.closePort(); } catch (_) {}
                    }
                    for (const [, out] of openedOutputs) {
                        try { out.closePort(); } catch (_) {}
                    }
                    console.warn('[WORKER] _enumeratePorts aborted: output open failed');
                    return;
                }
            }

            // PHASE 4: Close removed inputs
            for (const deviceName of inputsToRemove) {
                const input = this.inputs.get(deviceName);
                if (input) {
                    console.log(`[WORKER] Input removed: ${deviceName}`);
                    if (input._handler) input.off('message', input._handler);
                    try { input.closePort(); } catch (_) {}
                    this.inputs.delete(deviceName);
                    this.controllerInputs.delete(deviceName);
                }
            }

            // PHASE 5: Reopen moved inputs (close old, swap in new)
            for (const { name, oldPort, newIndex } of inputsToReopen) {
                try {
                    if (oldPort._handler) oldPort.off('message', oldPort._handler);
                    try { oldPort.closePort(); } catch (_) {}
                    const midiIn = new midi.Input();
                    midiIn.openPort(newIndex, 'midirouter-in');
                    midiIn.ignoreTypes(false, false, true);
                    const self = this;
                    const handler = (deltaTime, message) => self._onIncomingMessage(name, deltaTime, Array.from(message));
                    midiIn.on('message', handler);
                    midiIn._handler = handler;
                    midiIn._index = newIndex;
                    this.inputs.set(name, midiIn);
                    console.log(`[WORKER] Input reopened: ${name} (index: ${newIndex})`);
                } catch (e) {
                    console.error(`[WORKER] Failed to reopen input ${name}:`, e.message);
                }
            }

            // PHASE 6: Close removed outputs
            for (const deviceName of outputsToRemove) {
                const output = this.outputs.get(deviceName);
                if (output) {
                    console.log(`[WORKER] Output removed: ${deviceName}`);
                    try { output.closePort(); } catch (_) {}
                    this.outputs.delete(deviceName);
                }
            }

            // PHASE 7: Commit newly opened ports
            for (const [name, input] of openedInputs) {
                this.inputs.set(name, input);
            }
            for (const [name, output] of openedOutputs) {
                this.outputs.set(name, output);
                this._initializeControllerOutput(name, output);
            }

            for (const { name, oldPort, newIndex } of outputsToReopen) {
                try {
                    oldPort.closePort();
                    const output = new midi.Output();
                    output.openPort(newIndex, 'midirouter-out');
                    output._index = newIndex;
                    this.outputs.set(name, output);
                    this._initializeControllerOutput(name, output);
                    console.log(`[WORKER] Output reopened: ${name} (index: ${newIndex})`);
                } catch (error) {
                    this.outputs.delete(name);
                    console.error(`[WORKER] Failed to reopen output ${name}: ${error.message}`);
                }
            }

            for (const name of newInputNames) this.controllerInputs.add(name);
            this._broadcastPadMap();

            // Send panic only on initial startup or when an input was removed.
            // Do NOT send panic on output add (causes clicks in synths).
            const hadInputsBefore = this.inputs.size > 0;
            if (!hadInputsBefore) {
                // Initial startup — send panic to silence any stuck notes
                this.sendPanicNoteOff();
            } else if (inputsToRemove.length > 0) {
                // An input was removed — send panic on remaining outputs
                this.sendPanicNoteOff();
            }

            const inputList = [...this.inputs.entries()].map(([id]) => ({ id, name: id }));
            const outputList = [...this.outputs.entries()].map(([id]) => ({ id, name: id }));

            parentPort.postMessage({ type: 'ports-enumerated', inputs: inputList, outputs: outputList });
            parentPort.postMessage({ type: 'ready' });

            this._lastInputNames = new Set(realInputs.map(r => r.name));
            this._lastOutputNames = new Set(realOutputs.map(r => r.name));
        } catch (e) {
            console.error('[WORKER] Enumerate failed:', e.message);
        }
    }

    _filterPorts(device, direction = 'in') {
        const count = device.getPortCount();
        const real = [];
        // Always ignore our own ALSA client names and generic RtMidi virtual clients
        const selfPorts = ['midirouter', 'rtmidi output client', 'rtmidi input client', 'rtmidi client'];
        for (let i = 0; i < count; i++) {
            const name = device.getPortName(i);
            const lower = name.toLowerCase();
            const isIgnored = this._ignoreDevices.some(ignore => lower.includes(ignore.toLowerCase()));
            const isSelf = selfPorts.some(s => lower.includes(s));
            if (!isIgnored && !isSelf) {
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
            '11': `CC       ch${channel} cc${bytes[1]} val${bytes[2]}`,
            '10': `polyAfter ch${channel} n${bytes[1]} v${bytes[2]}`,
            '12': `progCh   ch${channel} ${bytes[1]}`,
            '13': `chanPr   ch${channel} ${bytes[1]}`,
        }[String(type)];
        const name = label || (type >= 8 ? `sys  ${bytes[0] === 0xf8 ? 'timing clock' : bytes[0] === 0xfa ? 'start' : bytes[0] === 0xfb ? 'continue' : bytes[0] === 0xfc ? 'stop' : bytes[0] === 0xfe ? 'active sensing' : 'unknown sys'}` : `raw#${bytes.join(',')}`);

        // Debug: log every single MIDI message received (critical for diagnosis)
        console.log(`[MIDI RX] ${deviceName}: ${name}`);

        // Skip loopback/timer/Midi Through ports to prevent feedback loops
        const isLoopback = deviceName.toLowerCase().includes('loopback') ||
                           deviceName.toLowerCase().includes('timer') ||
                           deviceName.toLowerCase().includes('midi through');
        const isSysEx = bytes[0] === 0xf0;
        const statusByte = bytes[0];
        const isSysRealTime = statusByte >= 0xF8 && statusByte <= 0xFF;

        if (isLoopback) {
            console.log(`[MIDI] [LOOPBACK] Ignoring: ${name}`);
            return;
        }

        // === System Real-Time (MIDI Clock / Start / Stop) from ANY source ===
        if (isSysRealTime) {
            const mtcSent = this._sendToSynthOutputs(bytes, 'external clock');
            if (mtcSent > 0) {
                console.log(`[MIDI TX] MTC ${name} -> ${mtcSent} outputs`);
            }

            // Control audio metronome
            if (this.metronomeCtrl) {
                if (statusByte === 0xFA || statusByte === 0xFB) {
                    console.log(`[METRO] Controller sent START -> starting metronome`);
                    this.metronomeCtrl.play();
                } else if (statusByte === 0xFC) {
                    console.log(`[METRO] Controller sent STOP -> stopping metronome`);
                    this.metronomeCtrl.stop();
                    this._metronomeStarted = false;
                } else if (statusByte === 0xF8) {
                    this._handleMidiClock(performance.now());
                    if (!this._metronomeStarted) {
                        console.log(`[METRO] First clock tick -> auto-starting metronome`);
                        this.metronomeCtrl.play();
                        this._metronomeStarted = true;
                    }
                }
            } else {
                console.log(`[METRO] metronomeCtrl is NULL — cannot control metronome!`);
            }
            return;
        }

        const control = this.controllerEngine.inputEvent(deviceName, bytes);
        if (control?.kind === 'pad') {
            this._handleMappedPad(control.pad, control.pressed ? 127 : 0, performance.now());
        } else if (control?.kind === 'transport' && control.pressed) {
            this._handleProfileTransport(control.action);
        }
        if (control?.consume || isSysEx) return;

        // === Controller note handling (MIDI Port keybed, nanoPAD, etc.) ===
        const isNoteOff = type === 8 && bytes.length >= 3;
        const isNoteOn2 = type === 9 && bytes.length >= 3;

        if (isNoteOff || isNoteOn2) {
            const n = bytes[1];
            const vel = bytes[2] || 0;
            const isMappedPad = this.padMap.has(n);

            // Learn pad controllers while leaving keyboard notes on the synth route.
            const isPadController = /pad/i.test(deviceName) && !this.controllerEngine.profileForInput(deviceName);

            if (isPadController && this.autoAssign && isNoteOn2 && vel > 0 && !isMappedPad && this.controllerInputs.has(deviceName)) {
                const trackIdx = this._learnCursor % 8;
                const slot = Math.floor(this._learnCursor / 8) % 2;
                this.padMap.set(n, { trackIdx, slot });
                this._learnCursor++;
                this._broadcastPadMap();
                console.log(`[WORKER] Auto-mapped note ${n} -> track ${trackIdx}, slot ${slot}`);
            }

            if (isPadController && this.padMap.has(n) && this.controllerInputs.has(deviceName)) {
                this._handleMappedPad(this.padMap.get(n), isNoteOff ? 0 : vel, performance.now());
                return;
            }

            // Record during active recording
            if (this.daw.recording && this.controllerInputs.has(deviceName)) {
                const sb = isNoteOff ? (0x80 | ((channel - 1) & 0x0f)) : (0x90 | ((channel - 1) & 0x0f));
                this.daw.recordEvent(sb, n, vel, performance.now());
            }
        }

        // === ALL-TO-ALL ROUTING (the default path) ===
        if (this._mappings.size === 0) {
            let sent = 0;
            for (const [outName, midiOut] of this.outputs) {
                if (this.controllerEngine.isExcludedOutput(outName)) continue;
                try {
                    let outMsg = Buffer.from(bytes);
                    if (type === 11) {
                        const transformed = this.ccMapper.transformCC(
                            { bytes: Buffer.from(bytes), type, channel: channel - 1, velocity: bytes[2] || 0, note: bytes[1] || 0 },
                            deviceName, 'default', 'default'
                        );
                        if (transformed && transformed.bytes) {
                            outMsg = transformed.bytes;
                        }
                    }
                    midiOut.sendMessage(outMsg);
                    sent++;
                    console.log(`[MIDI TX] ${deviceName} -> ${outName}: ${name}`);
                } catch (e) {
                    console.warn(`[MIDI TX] FAIL ${deviceName} -> ${outName}: ${e.message}`);
                }
            }
            if (sent === 0) {
                console.warn(`[MIDI TX] NO OUTPUTS for ${deviceName}: ${name} — check synth connections!`);
            }
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
                this._restartActiveClips();
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
                    this._restartActiveClips();
                }
                this._broadcastState();
                break;
            case 'daw_set_record_mode':
                daw.setRecordMode(msg.mode);
                this._clearStaleRecordingFeedback();
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
                this._triggerPad(msg.trackIdx, msg.slot, performance.now());
                break;
            case 'daw_apply_state':
                if (msg.state.tempo != null) daw.setTempo(msg.state.tempo);
                if (msg.state.recordMode != null) daw.setRecordMode(msg.state.recordMode);
                this._clearStaleRecordingFeedback();
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
            // ---- MIDI Clock (MTC) ----
            case 'daw_midi_clock_toggle':
                daw.setMidiClock(!daw.getMidiClockState());
                this._broadcastState();
                break;
            case 'daw_midi_clock_on':
                daw.setMidiClock(true);
                this._broadcastState();
                break;
            case 'daw_midi_clock_off':
                daw.setMidiClock(false);
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
                for (const trackIdx of this._trackPlayTimers.keys()) this._stopTrackPlayback(trackIdx);
                daw.clipState.fill(-1);
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
        const activeProfiles = new Set([...this.inputs.keys()]
            .map(name => this.controllerEngine.profileForInput(name)?.id).filter(Boolean));
        parentPort.postMessage({
            type: 'daw_pad_map_list',
            map: [
                ...this.controllerEngine.padMappings().filter(mapping => activeProfiles.has(mapping.profileId)),
                ...[...this.padMap.entries()].map(([note, m]) => ({ note, trackIdx: m.trackIdx, slot: m.slot })),
            ],
            learnMode: this.autoAssign,
        });
    }

    _initializeControllerOutput(name, output) {
        for (const bytes of this.controllerEngine.initMessagesFor(name)) {
            try { output.sendMessage(Buffer.from(bytes)); }
            catch (error) { console.warn(`[CONTROLLER] Initialization of ${name} failed: ${error.message}`); }
        }
        const targets = new Map(this.controllerEngine.padMappings().map(({ trackIdx, slot }) =>
            [`${trackIdx}:${slot}`, { trackIdx, slot }]));
        for (const { trackIdx, slot } of targets.values()) {
            for (const bytes of this.controllerEngine.feedbackMessagesFor(name, trackIdx, slot, 'off')) {
                try { output.sendMessage(Buffer.from(bytes)); }
                catch (error) { console.warn(`[CONTROLLER] LED reset on ${name} failed: ${error.message}`); }
            }
        }
        for (const [trackIdx, glow] of this._ledGlow) {
            for (const bytes of this.controllerEngine.feedbackMessagesFor(name, trackIdx, glow.slot, glow.state)) {
                try { output.sendMessage(Buffer.from(bytes)); }
                catch (error) { console.warn(`[CONTROLLER] LED restore on ${name} failed: ${error.message}`); }
            }
        }
    }
    cleanup() {
        // Stop hot-plug detection
        if (this._hotplugCheckInterval) {
            clearInterval(this._hotplugCheckInterval);
            this._hotplugCheckInterval = null;
        }

        for (const trackIdx of this._trackPlayTimers.keys()) this._stopTrackPlayback(trackIdx);
        for (const [, input] of this.inputs) {
            if (input._handler) input.off('message', input._handler);
            try { input.closePort(); } catch(e) {}
        }
        for (const [, output] of this.outputs) {
            try { output.closePort(); } catch(e) {}
        }
        // Close persistent enumeration objects
        if (this._enumIn) { try { this._enumIn.closePort(); } catch(e) {} this._enumIn = null; }
        if (this._enumOut) { try { this._enumOut.closePort(); } catch(e) {} this._enumOut = null; }
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
        const oldEngine = worker.controllerEngine;
        for (const [name, output] of worker.outputs) {
            for (const { trackIdx, slot } of oldEngine.padMappings()) {
                for (const bytes of oldEngine.feedbackMessagesFor(name, trackIdx, slot, 'off')) {
                    try { output.sendMessage(Buffer.from(bytes)); }
                    catch (error) { console.warn(`[CONTROLLER] LED reset on ${name} failed: ${error.message}`); }
                }
            }
        }
        worker.controllerEngine = ControllerEngine.fromDirectory(path.join(__dirname, 'controller_profiles'));
        worker.rebuildMappings();
        for (const [name, output] of worker.outputs) worker._initializeControllerOutput(name, output);
        worker._broadcastPadMap();
        parentPort.postMessage({ type: 'config_reloaded' });
    } else if (msg.type === 'rebuild_mappings') {
        // Пересборка маппингов при hot-plug событии
        worker.rebuildMappings();
    }
});

worker.init();
