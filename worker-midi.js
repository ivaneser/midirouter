/* === MIDI Router — all-to-all passthrough + DAW / Clip mode === */
import midi from '@julusian/midi';
import { parentPort } from 'worker_threads';
import { DAWEngine, noteOn, noteOff } from './daw.js';
import { portIndex, PortRecord } from './port-index.js';
import { ChannelFilter, VelocityFilter, MessageTypeFilter } from './filters.js';
import { CCMapper } from './cc-mapper.js';
import { computeRoutingStep } from './route-midi.js';
import { MetronomeController } from './metronome-controller.js';
import { ControllerEngine } from './controller-engine.js';
import { ExternalMidiClock } from './external-midi-clock.js';
import { ClockMaster, clockOutputsFor } from './clock-master.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Per-message MIDI logging is very verbose (clock ticks alone can be 100s/sec).
// Opt in explicitly: MIDI_DEBUG=1 systemctl restart midirouter
const MIDI_DEBUG = process.env.MIDI_DEBUG === '1';

class MIDIRouterWorker {
    constructor() {
        this.inputs = new Map();   // deviceName -> RtMidiIn instance
        this.outputs = new Map();  // deviceName -> RtMidiOut instance

        // DAW events reach the UI; transport clock also reaches synth outputs.
        // Actual metronome audio is produced by metronome.py → aplay -M → 3.5mm jack.
        this.daw = new DAWEngine();
        this.daw._onProgress = (beat, progress, cues = {}) => {
            if (parentPort) parentPort.postMessage({
                type: 'daw_progress',
                payload: { beat, progress, loopLenBeats: this.daw.loopLenBeats, ...cues },
            });
        };

        // Python audio metronome controller — controls metronome.py via stdin IPC
        this.metronomeCtrl = new MetronomeController({
            bpm: this.daw.tempo,
            beats: 4,
            volume: 0.8
        });
        this._transportPlaying = false;
        this._externalClockActive = false;
        this._externalTransportState = null;
        this._externalClockTimeout = null;
        this._lastExternalClockAt = 0;
        this._lastExternalTempoAt = 0;      // throttle live tempo/phase broadcasts to UI
        this._lastLoggedClockAt = 0;      // throttle [MIDI RX] clock-tick logging (first tick only)

        // External MIDI Clock slave — pure timestamp handling + BPM estimation.
        // The same `ExternalMidiClock` class is imported by unit tests, so the
        // production worker and the test share one source of truth.  (The old
        // `_externalClockTick / _externalClockHistory / _externalTempo` fields
        // were moved into that class during extraction.)
        this._externalMidiClock = new ExternalMidiClock({
            now: () => performance.now(),
            onActivate: () => this._activateExternalClock(performance.now()),
            setTempo: (bpm) => this.daw.setTempo(bpm),
        });


        // Explicit clock source selection — exactly one master at a time.
        this._clockMaster = new ClockMaster();
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
            const bytes = evt.data;
            const status = bytes[0];

            // Internal DAW MidiClock path: when the internal source is selected,
            // its 24 PPQN clock + Start/Continue/Stop must reach all allowed
            // outputs exactly once. When an external master is active we keep the
            // clock *internal* to avoid duplicating ticks (external source owns
            // fanout; do NOT re-emit internal ticks back out).
            if (this._clockMaster.source.kind === 'internal') {
                if (status === 0xf8 || status === 0xfa || status === 0xfb || status === 0xfc) {
                    this._sendMidiClockOutputs(bytes);
                }
            }

            // Generated clock/transport also reaches the UI for timing listeners.
            parentPort.postMessage({ type: 'daw_midi', data: bytes });
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
    _startTrackPlayback(trackIdx, slot, now = performance.now()) {
        this._stopTrackPlayback(trackIdx);
        const clip = this.daw.tracks[trackIdx].clips[slot];
        if (!clip || clip.notes.length === 0) return;

        const msPerBeat = this.daw._secondsPerBeat() * 1000;
        const loopBeats = Math.max(0.25, Number(this.daw.loopLenBeats) || 4);
        const loopMs = loopBeats * msPerBeat;
        const playback = { interval: null, timeouts: new Set(), active: new Map() };
        const schedule = (fn, delay) => {
            const timer = setTimeout(() => { playback.timeouts.delete(timer); fn(); }, Math.max(0, delay));
            playback.timeouts.add(timer);
        };

        this._ledGlow.set(trackIdx, { slot, state: 'playing' });
        this._sendFeedback(trackIdx, slot, 'playing');

        if (this._externalClockActive) {
            playback.externalClock = true;
            playback.loopTicks = Math.max(24, Math.round(loopBeats * 24));
            const currentTick = this._externalMidiClock.tickCount;
            playback.startTick = currentTick - (currentTick % playback.loopTicks);
            playback.noteEvents = clip.notes.map(note => ({
                ...note,
                startTick: ((Math.round(note.start * 24) % playback.loopTicks) + playback.loopTicks) % playback.loopTicks,
                durationTicks: Math.max(1, Math.round((note.dur || 0.25) * 24)),
            }));
            playback.pendingNoteOffs = new Map();
            this._trackPlayTimers.set(trackIdx, playback);
            return;
        }

        // Legato launch: map each clip event onto the existing transport cycle.
        // This mirrors Ableton Live's Legato Mode: launching a clip inherits the
        // current play position instead of restarting its local playhead at zero.
        const transportBeat = this.daw.playing
            ? ((now - this.daw._playAnchorTime) / 1000) / this.daw._secondsPerBeat()
            : 0;
        const phase = ((transportBeat % loopBeats) + loopBeats) % loopBeats;

        for (const note of clip.notes) {
            const eventPhase = ((note.start % loopBeats) + loopBeats) % loopBeats;
            const beatsUntilNext = ((eventPhase - phase) % loopBeats + loopBeats) % loopBeats;
            let nextAt = now + beatsUntilNext * msPerBeat;
            const channel = Math.max(1, note.channel || 1);
            const key = `${channel}:${note.note}`;
            const fire = () => {
                this._sendToSynthOutputs(noteOn(channel - 1, note.note, note.velocity > 0 ? note.velocity : 80));
                playback.active.set(key, (playback.active.get(key) || 0) + 1);
                schedule(() => {
                    this._sendToSynthOutputs(noteOff(channel - 1, note.note));
                    const count = playback.active.get(key) || 0;
                    if (count <= 1) playback.active.delete(key);
                    else playback.active.set(key, count - 1);
                }, (note.dur || 0.25) * msPerBeat);

                // Schedule against the ideal absolute cycle boundary, avoiding
                // cumulative drift from repeatedly adding timer callback latency.
                nextAt += loopMs;
                schedule(fire, nextAt - performance.now());
            };
            schedule(fire, nextAt - performance.now());
        }

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

    _syncActiveClipsToExternalClock() {
        for (const [trackIdx, slot] of this.daw.clipState.entries()) {
            if (slot >= 0) this._startTrackPlayback(trackIdx, slot);
        }
    }

    _tickExternalClipPlayback(tick) {
        for (const playback of this._trackPlayTimers.values()) {
            if (!playback.externalClock || tick < playback.startTick) continue;

            // Release every pending note-off whose scheduled tick is at or
            // before the current tick (handles skipped / late F8 ticks),
            // releasing each exactly once, while preserving future offs.
            const dueOffs = [];
            for (const [offTick, list] of playback.pendingNoteOffs) {
                if (offTick <= tick) {
                    dueOffs.push(...list);
                    playback.pendingNoteOffs.delete(offTick);
                }
            }
            for (const { key, channel, note } of dueOffs) {
                this._sendToSynthOutputs(noteOff(channel - 1, note));
                const count = playback.active.get(key) || 0;
                if (count <= 1) playback.active.delete(key);
                else playback.active.set(key, count - 1);
            }

            const elapsedTicks = tick - playback.startTick;
            const localTick = elapsedTicks % playback.loopTicks;
            const loopStartTick = tick - localTick;
            for (const event of playback.noteEvents) {
                if (event.startTick !== localTick) continue;
                const channel = Math.max(1, event.channel || 1);
                const key = `${channel}:${event.note}`;
                this._sendToSynthOutputs(noteOn(channel - 1, event.note, event.velocity > 0 ? event.velocity : 80));
                playback.active.set(key, (playback.active.get(key) || 0) + 1);
                const offTick = loopStartTick + event.startTick + event.durationTicks;
                const scheduled = playback.pendingNoteOffs.get(offTick) || [];
                scheduled.push({ key, channel, note: event.note });
                playback.pendingNoteOffs.set(offTick, scheduled);
            }
        }
    }

    _activateExternalClock(now) {
        const newlyActive = !this._externalClockActive;
        this._externalClockActive = true;
        this._lastExternalClockAt = now;
        this.daw.setExternalClock(true);
        if (newlyActive) this._syncActiveClipsToExternalClock();
        this._scheduleExternalClockTimeout();
    }

    _scheduleExternalClockTimeout() {
        if (this._externalClockTimeout) clearTimeout(this._externalClockTimeout);
        this._externalClockTimeout = setTimeout(() => {
            this._externalClockTimeout = null;
            const silentFor = performance.now() - this._lastExternalClockAt;
            if (silentFor < 750 || !this._externalClockActive) return;

            console.warn('[MIDI CLOCK] External clock lost; returning to the internal clock');
            this._externalClockActive = false;
            this._externalTransportState = null;
            // Mirror the reset that `_handleExternalTransport` does for a hard
            // stop: hand the instance its own reset so state stays coherent.
            this._externalMidiClock.reset();
            this.daw.setExternalClock(false);
            if (this.daw.playing) this._syncActiveClipsToInternalClock();
        }, 750);
    }

    _syncActiveClipsToInternalClock() {
        for (const [trackIdx, slot] of this.daw.clipState.entries()) {
            if (slot >= 0) this._startTrackPlayback(trackIdx, slot);
        }
    }

    _handleExternalTransport(statusByte, now, sourcePortName = null) {
        // Internal master — external transport events must be ignored entirely.
        if (this._clockMaster.source.kind === 'internal') {
            return;
        }

        // External master — only the selected master port affects sync.
        if (this._clockMaster.masterPortName !== sourcePortName) {
            return; // ignore non-master transport events
        }

        if (statusByte === 0xfa) {
            // A fresh MIDI Start re-syncs the slave clock's phase.
            this._externalMidiClock.reset();
        }
        const wasExternalClockActive = this._externalClockActive;
        this._activateExternalClock(now);
        if (statusByte === 0xfa) {
            this._externalTransportState = true;
            if (this.daw.playing) this.daw.stopTransport();
            this.daw.startTransport();
            this._transportPlaying = true;
            this.daw._playAnchorTime = now;
            this.daw._currentBeat = 0;
            if (wasExternalClockActive) this._syncActiveClipsToExternalClock();
            // Fan out the Start message to all allowed outputs (excl. master).
            this._sendMidiClockOutputs([0xfa]);
            this._broadcastState();
        } else if (statusByte === 0xfb) {
            this._externalTransportState = true;
            if (!this.daw.playing) {
                this.daw.startTransport();
                this._transportPlaying = true;
            }
            if (wasExternalClockActive) this._syncActiveClipsToExternalClock();
            // Fan out the Continue message to all allowed outputs.
            this._sendMidiClockOutputs([0xfb]);
            this._broadcastState();
        } else if (statusByte === 0xfc) {
            this._externalTransportState = false;
            if (this._transportPlaying) this.handleDawControl({ type: 'daw_stop_transport' });
            // Fan out the Stop message to all allowed outputs.
            this._sendMidiClockOutputs([0xfc]);
            this._broadcastState();
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

    _sendMidiClockOutputs(bytes, excludePortName = null) {
        // Use the ClockMaster's computed output set — excludes master port and
        // user-configured explicit exclusions; applies controller policy too.
        const dests = clockOutputsFor(this._clockMaster, (port) => {
            // Separate note-routing policy from clock policy: a port excluded
            // from ordinary MIDI output is still allowed as a clock destination
            // when the profile explicitly marks it via midiClockOutput.
            return this.controllerEngine.isAllowedClockDestination(port.name);
        });

        for (const port of dests) {
            // Safety: never send back to the physical master input.
            if (excludePortName && port.name === excludePortName) continue;
            try { port.send(bytes); }
            catch (error) { console.warn(`[WORKER] Failed to send MIDI clock to ${port.name}: ${error.message}`); }
        }
    }

    _sendFeedback(trackIdx, slot, state) {
        for (const [name, output] of this.outputs) {
            for (const bytes of this.controllerEngine.feedbackMessagesFor(name, trackIdx, slot, state)) {
                try { output.sendMessage(Buffer.from(bytes)); }
                catch (error) { console.warn(`[CONTROLLER] Feedback to ${name} failed: ${error.message}`); }
            }
        }
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
        let visualEvent = null;
        if (['play', 'record-stop', 'record', 'overdub'].includes(result.action)) {
            visualEvent = {
                kind: result.action === 'record' || result.action === 'overdub' ? 'record-start' : 'clip-start',
                trackIdx,
                slot,
                mode: this.daw.recordMode,
            };
        }
        this._clearStaleRecordingFeedback();
        if (result.action === 'play' || result.action === 'record-stop') {
            this._startTrackPlayback(trackIdx, slot, now);
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
        if (visualEvent) this._emitVisualEvent(visualEvent);
        return result;
    }

    _emitVisualEvent(event) {
        if (parentPort) parentPort.postMessage({ type: 'daw_visual_event', event });
    }

    _handleMappedPad(mapping, velocity, now) {
        // Clips toggle on a press. Releasing a pad must not end recording.
        if (mapping && velocity > 0) this._triggerPad(mapping.trackIdx, mapping.slot, now);
    }

    // ---- External MIDI Clock slave (delegates to ExternalMidiClock) ----
    _handleMidiClock(now, excludePortName = null) {
        // The selected external input port is now the *only* master for clock.
        // Every 0xF8 tick from that source drives the slave clock and is
        // retransmitted to all allowed outputs (excluding the master itself).
        const masterSource = this._clockMaster.source;

        if (masterSource.kind === 'external') {
            // Only the chosen master's ticks are processed — ticks from other
            // input ports are ignored for sync/fanout (handled at the caller).
            if (masterSource.masterPortName !== excludePortName) return;

            // No throttling: ExternalMidiClock needs every tick for correct BPM/phase.
            this._lastExternalClockAt = now;
            this._scheduleExternalClockTimeout();

            if (this._externalTransportState == null) {
                this._externalTransportState = true;
            }
            if (this._externalTransportState !== false && !this._transportPlaying) {
                this.handleDawControl({ type: 'daw_start_transport' });
            }

            // Hand the tick to the shared slave clock — it activates, tracks phase,
            // estimates BPM and calls back into `daw.setTempo`.
            const tempoBefore = this.daw.tempo;
            this._externalMidiClock.tick(now);

            if (this._externalMidiClock.externalClockActive) {
                this._externalClockActive = true;
                const loopTicks = Math.max(24, this.daw.loopLenBeats * 24);
                const beat = (this._externalMidiClock.tickCount % loopTicks) / 24;
                this.daw._playAnchorTime = now - beat * this.daw._secondsPerBeat() * 1000;
                this.daw._currentBeat = beat;
                this._tickExternalClipPlayback(this._externalMidiClock.tickCount);

                // Publish live tempo/phase to UI when the external master
                // materially changed it — but NOT every tick (throttled to
                // downbeat boundaries so ~4 broadcasts/sec at 120 BPM).
                if (this.daw.tempo !== tempoBefore) {
                    this._lastExternalTempoAt = this._lastExternalTempoAt || 0;
                    const nowMs = performance.now();
                    if (nowMs - this._lastExternalTempoAt > 125) {
                        this._broadcastState();
                        this._lastExternalTempoAt = nowMs;
                    }
                }
            }

            // Emit the incoming clock to UI timing listeners.
            parentPort.postMessage({ type: 'daw_midi', data: [0xf8] });

            // Retransmit the master tick to all allowed outputs (excluding master).
            this._sendMidiClockOutputs([0xf8]);
        } else {
            // Internal source — nothing to do here; the DAW engine's MidiClock
            // drives the allowed outputs directly via its own emit path.
        }
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

            // PHASE 6: Close removed outputs (sync deregistration with ClockMaster)
            for (const deviceName of outputsToRemove) {
                const output = this.outputs.get(deviceName);
                if (output) {
                    console.log(`[WORKER] Output removed: ${deviceName}`);
                    try { output.closePort(); } catch (_) {}
                    // Tell ClockMaster so activeOutputs/candidates stay coherent.
                    this._clockMaster.deregisterOutput(deviceName);
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
                // Register the real RtMidiOut instance with ClockMaster so its
                // outputs/candidates/activeOutputs stay in sync and send() routes
                // through .sendMessage(Buffer) on the physical port.
                const outName = name;
                this._clockMaster.registerOutput(outName, (bytes) => {
                    output.sendMessage(Buffer.from(bytes));
                });
            }

            for (const { name, oldPort, newIndex } of outputsToReopen) {
                try {
                    oldPort.closePort();
                    const output = new midi.Output();
                    output.openPort(newIndex, 'midirouter-out');
                    output._index = newIndex;
                    this.outputs.set(name, output);
                    this._initializeControllerOutput(name, output);
                    // Re-register the swapped-in physical port with ClockMaster.
                    this._clockMaster.registerOutput(name, (bytes) => {
                        output.sendMessage(Buffer.from(bytes));
                    });
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

        // Debug: log every single MIDI message received (critical for diagnosis).
        // Clock ticks are extremely frequent (100s/sec), so only log the first
        // tick of a new burst (after 1.5s silence) to keep logs readable.
        if (MIDI_DEBUG) {
            const isRepeatedClock = name.includes('timing clock') &&
                this._lastLoggedClockAt &&
                (performance.now() - this._lastLoggedClockAt) < 1500;
            if (!isRepeatedClock) {
                console.log(`[MIDI RX] ${deviceName}: ${name}`);
                if (name.includes('timing clock')) this._lastLoggedClockAt = performance.now();
            }
        }

        // Skip loopback/timer/Midi Through ports to prevent feedback loops
        const isLoopback = deviceName.toLowerCase().includes('loopback') ||
                           deviceName.toLowerCase().includes('timer') ||
                           deviceName.toLowerCase().includes('midi through');
        const isSysEx = bytes[0] === 0xf0;
        const statusByte = bytes[0];
        const isSysRealTime = statusByte >= 0xF8 && statusByte <= 0xFF;

        if (isLoopback) {
            if (MIDI_DEBUG) console.log(`[MIDI] [LOOPBACK] Ignoring: ${name}`);
            return;
        }

        // === System Real-Time (MIDI Clock / Start / Stop) ===
        // Only the selected clock master's 0xF8/Start/Continue/Stop drive sync.
        if (isSysRealTime) {
            const now = performance.now();
            if (statusByte === 0xf8) {
                // Gate external clock ticks to the single selected master port only.
                if (this._clockMaster.source.kind === 'external' &&
                    this._clockMaster.masterPortName !== deviceName) {
                    return; // ignore non-master source ticks for sync/fanout
                }
                this._handleMidiClock(now, deviceName);
            } else if ([0xfa, 0xfb, 0xfc].includes(statusByte)) {
                this._handleExternalTransport(statusByte, now, deviceName);
            } else {
                this._sendToSynthOutputs(bytes, 'external real-time MIDI');
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
            const allToAllResult = computeRoutingStep(bytes, deviceName, {
                outputs: this.outputs,
                mappings: new Map(),
                ccMapper: this.ccMapper,
            });
            let sent = 0;
            for (const delivered of allToAllResult.delivered) {
                const outName = delivered.output;
                if (this.controllerEngine.isExcludedOutput(outName)) continue;
                try {
                    // Deliver the bytes computed by the shared routing decision path.
                    this.outputs.get(outName).sendMessage(Buffer.from(delivered.bytes));
                    sent++;
                    if (MIDI_DEBUG) console.log(`[MIDI TX] ${deviceName} -> ${outName}: ${name}`);
                } catch (e) {
                    console.warn(`[MIDI TX] FAIL ${deviceName} -> ${outName}: ${e.message}`);
                }
            }
            if (sent === 0) {
                console.warn(`[MIDI TX] NO OUTPUTS for ${deviceName}: ${name} — check synth connections!`);
            }
        } else {
            // === ROUTED PATH — honour configured routes: filters + CC transform per route ===
            const routedResult = computeRoutingStep(bytes, deviceName, {
                outputs: this.outputs,
                mappings: this._mappings,
                ccMapper: this.ccMapper,
            });
            let sent = 0;
            for (const delivered of routedResult.delivered) {
                const outName = delivered.output;
                if (!this.controllerEngine.isExcludedOutput(outName)) {
                    try {
                        this.outputs.get(outName).sendMessage(Buffer.from(delivered.bytes));
                        sent++;
                        if (MIDI_DEBUG) console.log(`[MIDI TX] ${deviceName} -> ${outName}: ${name}`);
                    } catch (e) {
                        console.warn(`[MIDI TX] FAIL ${deviceName} -> ${outName}: ${e.message}`);
                    }
                }
            }
            if (sent === 0) {
                console.warn(`[MIDI TX] NO ROUTE for ${deviceName}: ${name} — check route config!`);
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
                if (this._externalClockActive) this._externalTransportState = true;
                this._broadcastState();
                break;
            case 'daw_stop_transport':
                if (this._externalClockActive) this._externalTransportState = false;
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
        const state = this.daw.getState();
        // Include the current clock master selection so UI reflects reality.
        state.clockMasterSource = this._clockMaster.source;
        state.clockMasterActiveOutputs = this._clockMaster.activeOutputs.map(p => p.name);
        parentPort.postMessage({ type: 'daw_state', state });
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
        if (this._externalClockTimeout) {
            clearTimeout(this._externalClockTimeout);
            this._externalClockTimeout = null;
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

export { MIDIRouterWorker };

if (parentPort) {
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
    } else if (msg.type.startsWith('clock_')) {
        // Clock master selection commands from server.
        if (msg.type === 'clock_source_select') {
            const kind = msg.kind;           // 'internal' | 'external'
            const portName = msg.portName;   // when external: name of input port
            if (kind === 'internal') {
                worker._clockMaster.selectInternal();
                worker._externalMidiClock.reset();
                worker._externalClockActive = false;
                worker._externalTransportState = null;
                worker.daw.setMidiClock(true);
            } else if (kind === 'external') {
                if (portName) {
                    worker._clockMaster.selectExternal(portName);
                } else {
                    worker._clockMaster.resetExternalState();
                }
                worker.daw.setMidiClock(false);
            }
            worker._broadcastState();
        } else if (msg.type === 'clock_source_explicit_exclusions') {
            const excl = Array.isArray(msg.exclusions) ? msg.exclusions : [];
            worker._clockMaster.setExplicitExclusions(excl);
            worker._broadcastState();
        }
    }
    });
    worker.init();
}
