/* === MIDI Router — all-to-all passthrough + DAW / Clip mode === */
import midi from '@julusian/midi';
import { parentPort } from 'worker_threads';
import { DAWEngine, noteOn, noteOff } from './daw.js';
import { portIndex, PortRecord } from './port-index.js';
import { ChannelFilter, VelocityFilter, MessageTypeFilter } from './filters.js';
import { CCMapper } from './cc-mapper.js';
import { MetronomeController } from './metronome-controller.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class MIDIRouterWorker {
    constructor() {
        this.inputs = new Map();   // deviceName -> RtMidiIn instance
        this.outputs = new Map();  // deviceName -> RtMidiOut instance

        // DAW engine — metronome/clip events go to UI ONLY (not to MIDI outputs).
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
            // Only notify UI via WebSocket — do NOT route to physical MIDI outputs
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
        // interface with ZERO web-UI setup. Set autoAssign=true to enable
        // auto-mapping for non-keyboard controllers.
        // Device-specific rules:
        //   - Launchkey MIDI Port (keybed) -> NEVER auto-learn, always route to synths
        //   - Launchkey DAW Port (session pads 112-127) -> hard-mapped by _applyDefaultPadMap
        //   - nanoPAD / other drum pads -> auto-learn to next free slot
        //   - Keyboard controllers without DAW Port -> auto-learn all notes
        this.autoAssign = true;
        this._learnCursor = 0;

        // Hot-plug back-off state (exponential back-off on ALSA failures)
        this._hotplugBackoffMs = 5000;   // default interval between checks
        this._consecutiveHotplugFailures = 0;
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

        const msPerBeat = (60 / this.daw.tempo / 4) * 1000;
        const loopMs = Math.max(250, this.daw.loopLenBeats * msPerBeat);
        const self = this;

        // LED feedback for this track: glow + downbeat flash each loop
        const leadNote = this._padNoteForTrack(trackIdx, slot);
        if (leadNote != null) {
            // clear any prior glow on this note (e.g. red arm -> cyan play)
            this._clearLed(leadNote);
            this._ledGlow.set(trackIdx, { note: leadNote, color: 'cyan' });
            this._setLed(leadNote, 'cyan', 0.5);   // steady glow
        }

        const runLoop = () => {
            const t0 = performance.now();

            // downbeat flash (full brightness pulse at beat 0 of the loop)
            if (leadNote != null) this._flashLed(leadNote, 1.0, 90);

            for (const n of clip.notes) {
                const delay = Math.max(0, (n.start * msPerBeat) - (performance.now() - t0));
                setTimeout(() => self._sendToSynthOutputs(noteOn(n.channel - 1, n.note, n.velocity)), delay);
                const offDelay = Math.max(0, ((n.start + n.dur) * msPerBeat) - (performance.now() - t0));
                setTimeout(() => self._sendToSynthOutputs(noteOff(n.channel - 1, n.note)), offDelay);
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

    // Send bytes to all outputs EXCEPT Launchkey (for synth playback)
    _sendToSynthOutputs(bytes, label = '') {
        let sent = 0;
        for (const [name, midiOut] of this.outputs) {
            if (name.toLowerCase().includes('launchkey')) continue;
            try {
                midiOut.sendMessage(Buffer.from(bytes));
                sent++;
            } catch (e) {
                console.warn(`[WORKER] Failed to send ${label} to ${name}: ${e.message}`);
            }
        }
        return sent;
    }

    // Send bytes ONLY to Launchkey output ports (for LED/session feedback)
    _sendToLaunchkey(bytes, label = '') {
        let sent = 0;
        for (const [name, midiOut] of this.outputs) {
            if (!name.toLowerCase().includes('launchkey')) continue;
            try {
                midiOut.sendMessage(Buffer.from(bytes));
                sent++;
            } catch (e) {
                console.warn(`[WORKER] Failed to send ${label} to Launchkey ${name}: ${e.message}`);
            }
        }
        return sent;
    }

    // Launchkey Mini MK3 RGB LED via SysEx: F0 00 20 29 02 0E 03 [pad 0-15] [r] [g] [b] F7
    _setLaunchkeyRgb(padIndex, r, g, b) {
        if (padIndex < 0 || padIndex > 15) return;
        const msg = [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0e, 0x03, padIndex, r & 0x7f, g & 0x7f, b & 0x7f, 0xf7];
        this._sendToLaunchkey(msg, `RGB pad ${padIndex}`);
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
        // Send only to Launchkey — do NOT send to synths
        this._sendToLaunchkey([0x90 | 0, note & 0x7f, vel], `LED ${color}`);
    }

    // flash: bright pulse that auto-off after ms
    _flashLed(note, brightness, ms) {
        const vel = this._ledVelocity('red', brightness);   // downbeat = bright red pulse
        if (vel === 0) return;
        this._sendToLaunchkey([0x90 | 0, note & 0x7f, vel], `LED flash`);
        setTimeout(() => {
            this._sendToLaunchkey([0x80 | 0, note & 0x7f, 0], 'clear-led');
        }, ms);
    }

    _clearLed(note) {
        this._sendToLaunchkey([0x80 | 0, note & 0x7f, 0], 'clear-led');
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
            for (const [deviceName] of this.outputs) {
                if (!newOutputNames.has(deviceName)) {
                    outputsToRemove.push(deviceName);
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
                    if (deviceName.toLowerCase().includes('launchkey')) {
                        this._dawModeSent = false;
                        console.log('[WORKER] Launchkey removed — DAW mode flag reset');
                    }
                }
            }

            // PHASE 7: Commit newly opened ports
            for (const [name, input] of openedInputs) {
                this.inputs.set(name, input);
            }
            for (const [name, output] of openedOutputs) {
                this.outputs.set(name, output);
            }

            for (const name of newInputNames) this.controllerInputs.add(name);

            // Auto-activate DAW mode for Launchkey
            const hasLaunchkey = [...newInputNames, ...newOutputNames].some(n => n.toLowerCase().includes('launchkey'));
            if (hasLaunchkey) {
                this._enterDawMode();
                this._applyDefaultPadMap();
            }

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
            '7': `CC       ch${channel} cc${bytes[1]} val${bytes[2]}`,
            'a': `afterCh  ch${channel} n${bytes[1]} v${bytes[2]}`,
            'c': `progCh   ch${channel} ${bytes[1]}`,
            'e': `chanPr   ch${channel} ${bytes[1]}`,
        }[String(type)];
        const name = label || (type >= 8 ? `sys  ${bytes[0] === 0xf8 ? 'timing clock' : bytes[0] === 0xfa ? 'start' : bytes[0] === 0xfb ? 'continue' : bytes[0] === 0xfc ? 'stop' : bytes[0] === 0xfe ? 'active sensing' : 'unknown sys'}` : `raw#${bytes.join(',')}`);

        // Debug: log every single MIDI message received (critical for diagnosis)
        console.log(`[MIDI RX] ${deviceName}: ${name}`);

        // Skip loopback/timer/Midi Through ports to prevent feedback loops
        const isLoopback = deviceName.toLowerCase().includes('loopback') ||
                           deviceName.toLowerCase().includes('timer') ||
                           deviceName.toLowerCase().includes('midi through');
        const isDAWPort = deviceName.toLowerCase().includes('daw port');
        const isLaunchkey = deviceName.toLowerCase().includes('launchkey');
        const isSysEx = bytes[0] === 0xf0;
        const statusByte = bytes[0];
        const isSysRealTime = statusByte >= 0xF8 && statusByte <= 0xFF;

        if (isLoopback) {
            console.log(`[MIDI] [LOOPBACK] Ignoring: ${name}`);
            return;
        }

        // === System Real-Time (MIDI Clock / Start / Stop) from ANY source ===
        if (isSysRealTime) {
            // Forward MTC to all synth outputs
            let mtcSent = 0;
            for (const [outName, outputPort] of this.outputs) {
                if (outName.toLowerCase().includes('daw port') || outName.toLowerCase().includes('loopback')) continue;
                try {
                    outputPort.sendMessage(Buffer.from(bytes));
                    mtcSent++;
                } catch (e) {}
            }
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

        // DAW Port internal handling (CC → synths, Note → DAW clips)
        if (isDAWPort) {
            const isCC = type === 7;
            const isSysExMsg = bytes[0] === 0xf0;
            const isNoteOn = type === 9 && bytes.length >= 3;
            const isNoteOff = type === 8 && bytes.length >= 3;
            if (!isCC && !isSysExMsg && !isNoteOn && !isNoteOff) {
                console.log(`[MIDI] [LOOPBACK] Ignoring DAW Port: ${name}`);
                return;
            }

            if (isCC) {
                // CC from knobs — route to ALL synth outputs
                const message = { bytes: Buffer.from(bytes), type, channel: channel - 1, velocity: bytes[2] || 0, note: bytes[1] || 0 };
                for (const [outName, outputPort] of this.outputs) {
                    if (outName.toLowerCase().includes('daw port') || outName.toLowerCase().includes('launchkey')) continue;
                    try {
                        const transformed = this.ccMapper.transformCC(message, deviceName, outName, 'default');
                        outputPort.sendMessage(transformed.bytes);
                        console.log(`[MIDI TX] ${deviceName} -> ${outName}: CC${transformed.bytes[1]} (transl)`);
                    } catch (e) {
                        console.warn(`[MIDI TX] Failed CC to ${outName}: ${e.message}`);
                    }
                }
                return;
            }

            if (isNoteOn || isNoteOff) {
                // Filter out control/meta notes (0-19) on DAW Port — these are
                // not session pads. Note 12 (C-1, ch16) is the DAW mode
                // activation handshake from Launchkey, not a clip trigger.
                if (bytes[1] < 20) {
                    console.log(`[DAW] Ignoring control note ${bytes[1]} on DAW Port`);
                    return;
                }
                console.log(`[DAW] DAW Port note ${bytes[1]} vel ${bytes[2]} -> clip handler`);
                this._handleControllerNote(bytes[1], bytes[2] || 0, channel, performance.now());
                return;
            }
        }

        // SysEx from any port
        if (isSysEx) {
            this._handleLaunchkeySysEx(deviceName, bytes);
            return;
        }

        // Transport CC (Launchkey knobs/buttons)
        if (type === 7) {
            const cc = bytes[1];
            const value = bytes[2] || 0;
            this._handleControllerCC(cc, value, channel, performance.now());
        }

        // === Controller note handling (MIDI Port keybed, nanoPAD, etc.) ===
        const isNoteOff = type === 8 && bytes.length >= 3;
        const isNoteOn2 = type === 9 && bytes.length >= 3;

        if (isNoteOff || isNoteOn2) {
            const n = bytes[1];
            const vel = bytes[2] || 0;
            let isMappedPad = this.padMap.has(n);

            // Auto-learn rules based on device name (not note number):
            //   - Launchkey MIDI Port (keybed) -> NEVER auto-learn; always route to synths
            //   - Everything else (nanoPAD, DAW Port, other controllers) -> auto-learn when enabled
            const isLaunchkeyMidiPort = deviceName.toLowerCase().includes('launchkey')
                && !deviceName.toLowerCase().includes('daw port');

            if (!isLaunchkeyMidiPort && this.autoAssign && isNoteOn2 && vel > 0 && !isMappedPad && this.controllerInputs.has(deviceName)) {
                const trackIdx = this._learnCursor % 8;
                const slot = Math.floor(this._learnCursor / 8) % 2;
                this.padMap.set(n, { trackIdx, slot });
                this._learnCursor++;
                this._broadcastPadMap();
                isMappedPad = true;
                console.log(`[WORKER] Auto-mapped note ${n} -> track ${trackIdx}, slot ${slot}`);
            }

            // Mapped pads act as clip triggers (Launchkey DAW Port 112-127,
            // auto-mapped nanoPAD pads, etc.).
            if (isMappedPad && this.controllerInputs.has(deviceName)) {
                console.log(`[DAW] Mapped session pad ${n} -> clip handler`);
                this._handleControllerNote(n, vel, channel, performance.now());
                return;
            }

            // Record during active recording
            if (this.daw.recording && this.controllerInputs.has(deviceName)) {
                const sb = isNoteOff ? (0x80 | ((channel - 1) & 0x0f)) : (0x90 | ((channel - 1) & 0x0f));
                this.daw.recordEvent(sb, n, vel, performance.now());
            }
        }

        // === ALL-TO-ALL ROUTING (the default path) ===
        if (this._mappings.size === 0 && !isDAWPort) {
            let sent = 0;
            for (const [outName, midiOut] of this.outputs) {
                if (outName.toLowerCase().includes('launchkey')) continue;
                try {
                    let outMsg = Buffer.from(bytes);
                    if (type === 7) {
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
        } else if (isDAWPort) {
            console.log(`[MIDI] DAW Port msg processed internally only: ${name}`);
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
        // Send DAW/InControl mode activation to Launchkey Mini MK3
        // Two methods: SysEx (preferred) + Note On fallback
        if (this._dawModeSent) return;
        
        for (const [name, output] of this.outputs) {
            if (!name.toLowerCase().includes('launchkey')) continue;
            try {
                // SysEx method: enable DAW mode (InControl) for Launchkey Mini MK3
                // Product ID 0x0E = Launchkey Mini MK3
                const sysex = [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0e, 0x0c, 0x01, 0xf7];
                output.sendMessage(sysex);
                console.log('[WORKER] DAW mode SysEx sent to', name);
                
                // Fallback: Note On ch16 note 12 vel 127 (legacy Ableton protocol)
                setTimeout(() => {
                    try {
                        output.sendMessage([0x9f, 12, 127]);
                    } catch(e) {}
                }, 100);
                
                // Set all pads black (off) initially
                setTimeout(() => {
                    this._clearAllLaunchkeyPads();
                }, 200);
            } catch (e) {
                console.error('[WORKER] Failed to send DAW mode to', name, e.message);
            }
        }
        this._dawModeSent = true;
    }

    _clearAllLaunchkeyPads() {
        for (const [name, output] of this.outputs) {
            if (!name.toLowerCase().includes('launchkey')) continue;
            try {
                // Turn off all 16 session pads via SysEx RGB (set to black)
                for (let p = 0; p < 16; p++) {
                    const msg = [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0e, 0x03, p, 0, 0, 0, 0xf7];
                    output.sendMessage(msg);
                }
                // Also note-off velocity-based range 112-127 just in case
                for (let n = 112; n <= 127; n++) {
                    output.sendMessage([0x80 | 0, n & 0x7f, 0]);
                }
            } catch (e) {}
        }
    }

    _applyDefaultPadMap() {
        // Apply default pad mapping for Launchkey Mini MK3 session pads.
        // Always add Launchkey-specific ranges; never bail early —
        // earlier auto-mapped notes from other controllers should not block
        // the Launchkey session pad defaults.
        let added = 0;
        // DAW Mode session pads: notes 112-127 (bottom row = slot 0, top row = slot 1)
        for (let col = 0; col < 8; col++) {
            if (!this.padMap.has(112 + col)) { this.padMap.set(112 + col, { trackIdx: col, slot: 0 }); added++; }
            if (!this.padMap.has(120 + col)) { this.padMap.set(120 + col, { trackIdx: col, slot: 1 }); added++; }
        }
        if (added > 0) {
            console.log('[WORKER] Default pad map applied:', added, 'new Launchkey pads (total', this.padMap.size, ')');
            this._broadcastPadMap();
        }
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
        worker.rebuildMappings();
        parentPort.postMessage({ type: 'config_reloaded' });
    } else if (msg.type === 'rebuild_mappings') {
        // Пересборка маппингов при hot-plug событии
        worker.rebuildMappings();
    }
});

worker.init();
