/* === MIDI Router — all-to-all passthrough + DAW / Clip mode === */
import midi from '@julusian/midi';
import { parentPort } from 'worker_threads';
import { DAWEngine, noteOn, noteOff } from './daw.js';
import { portIndex, PortRecord } from './port-index.js';
import { ChannelFilter, VelocityFilter, MessageTypeFilter } from './filters.js';
import { CCMapper } from './cc-mapper.js';
import { computeRoutingStep } from './route-midi.js';
import { ControllerEngine, matches } from './controller-engine.js';
import { ExternalMidiClock } from './external-midi-clock.js';
import { ClockMaster, clockOutputsFor, stablePortKey } from './clock-master.js';
import { MetronomeController } from './metronome-controller.js';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Per-message MIDI logging is very verbose (clock ticks alone can be 100s/sec).
// Opt in explicitly: MIDI_DEBUG=1 systemctl restart midirouter
const MIDI_DEBUG = process.env.MIDI_DEBUG === '1';
// Test-only switch: MIDIR_NO_HARDWARE=1 skips real MIDI port enumeration, hot-plug
// and the audio metronome, so the worker can run in tests without devices.
const NO_HARDWARE = process.env.MIDIR_NO_HARDWARE === '1';

class MIDIRouterWorker {
    constructor() {
        this.inputs = new Map();   // deviceName -> RtMidiIn instance
        this.outputs = new Map();  // deviceName -> RtMidiOut instance

        // DAW events reach the UI; transport clock also reaches synth outputs.
        this.daw = new DAWEngine();
        this.daw._onProgress = (beat, progress, cues = {}) => {
            if (parentPort) parentPort?.postMessage({
                type: 'daw_progress',
                payload: { beat, progress, loopLenBeats: this.daw.loopLenBeats, ...cues },
            });
        };
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

        // Metronome clicks use the Raspberry Pi's local ALSA audio output,
        // completely separate from MIDI note and MIDI clock routing.
        this.metronomeCtrl = new MetronomeController();
        this._audioMetronomeAvailable = process.platform === 'linux' && !NO_HARDWARE
            && this.metronomeCtrl.isAvailable();
        if (this._audioMetronomeAvailable) {
            this.metronomeCtrl.start().catch((error) => {
                console.warn(`[METRONOME] Audio process unavailable: ${error.message}`);
                this._audioMetronomeAvailable = false;
            });
        }
        this.daw._onMetronomeStart = (bpm, beats) => {
            if (!this._audioMetronomeAvailable) return;
            this.metronomeCtrl.setBpm(bpm);
            this.metronomeCtrl.setBeats(beats);
            this.metronomeCtrl.play().catch((error) => {
                console.warn(`[METRONOME] Audio output unavailable: ${error.message}`);
            });
        };
        this.daw._onMetronomeStop = () => {
            if (this._audioMetronomeAvailable) {
                this.metronomeCtrl.stop();
                this.metronomeCtrl.resetBeatIndex();
            }
        };
        this.daw._onMetronomeTempo = (bpm) => {
            if (this._audioMetronomeAvailable) this.metronomeCtrl.setBpm(bpm);
        };
        this.daw._onMetronomeMeter = (beats) => {
            if (this._audioMetronomeAvailable) this.metronomeCtrl.setBeats(beats);
        };
        // Per-beat audio click: every authoritative DAW beat triggers a real
        // audio click through the Python metronome.  No independent timer —
        // clicks only happen when the DAW says so (internal or external clock).
        this.daw._onAudioBeat = (isAccent) => {
            if (!this._audioMetronomeAvailable) return;
            this.metronomeCtrl.triggerBeat(isAccent);
            this.metronomeCtrl.advanceBeat();
        };
        // External clock: the click for the predicted next beat, scheduled early so it
        // sounds on the beat (the metronome process compensates its audio latency).
        this.daw._onAudioBeatAhead = (isAccent, periodMs) => {
            if (!this._audioMetronomeAvailable) return;
            this.metronomeCtrl.triggerBeatIn(isAccent, periodMs);
        };

        const origSetTempo = this.daw.setTempo.bind(this.daw);
        this.daw.setTempo = (bpm) => {
            origSetTempo(bpm);
        };

        // Keep the click audible through the full two-bar count-in. Individual
        // click note-offs are managed by DAWEngine.
        this.daw._onRecordingStarted = () => {};

        // Two-bar count-in: after transport starts on first empty-clip trigger,
        // start actual recording once the count-in completes. The recording state
        // already exists from armRecording — we just advance startTime to "now" so
        // recordEvent() will accept incoming notes immediately.  If the user stops
        // during the count-in, daw.stopTransport() cancels the timer and clears
        // _countInRunning, so this callback is never invoked for that take.
        const self = this;
        this.daw._onCountInComplete = () => { self._handleCountInComplete(); };

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
            if (parentPort) {
                parentPort?.postMessage({ type: 'daw_midi', data: bytes });
            }
        };

        // track playback timers (loop): trackIdx -> { interval, timeouts, active }
        this._trackPlayTimers = new Map();
        this._recordingStopTimer = null;
        // LED state per active track: trackIdx -> { slot, state }
        this._ledGlow = new Map();
        this._padLedSent = new Map();   // "trackIdx:slot" -> last sent LED state
        this._lastActivated = null;      // { trackIdx, slot } — last activated clip (blinks)
        this._padClockTimer = null;      // MTC tickers only on the controller's DAW port
        this._padClockPhase = 0;

        // controller input ports whose notes drive DAW trigger/recording
        this.controllerInputs = new Set();

        // Unconfigured controllers can still learn pad assignments by note.
        this.autoAssign = true;
        this._learnCursor = 0;

        // Audio latency offset (ms) applied to clip note-on scheduling in the
        // non-external-clock path so notes fire earlier, compensating for audio
        // output latency. Clamped to 0..300 on set.
        // Calibration offsets (ms), tuned by ear: negative = earlier, positive = later.
        this.audioOffsetMs = -30;  // clip notes
        // Click latency compensation (ms) for the audio metronome, tuned by ear.
        this.clickOffsetMs = 0;    // metronome clicks

        // Quantization grid (beats, quarter note = 1) applied by quantizeClip;
        // one of the five allowed values, default 0.125 (1/32 note).
        this.quantizeGrid = 0.125;

        // Hot-plug back-off state (exponential back-off on ALSA failures)
        this._hotplugBackoffMs = 5000;   // default interval between checks
        this._consecutiveHotplugFailures = 0;
        this.padMap = new Map();   // note(number) -> { trackIdx, slot }

        // CC Mapper — translates controller commands into synth commands
        this.ccMapper = new CCMapper();

        this.controllerEngine = ControllerEngine.fromDirectory(path.join(__dirname, 'controller_profiles'));

        // Configuration
        this._config = null;
        this._mappings = new Map(); // name -> { inputs: [], outputs: [], filters: [] }
        this._hotplug = true;
        this._ignoreDevices = ['Midi Through', 'loopback', 'timer', 'announce'];
        
        // Hot-plug detection. Name sets track identity; index Maps remember the
        // ALSA port index per name so an index-only change (device replugged at a
        // different slot) is detected even when the name set is unchanged.
        this._lastInputNames = new Set();
        this._lastOutputNames = new Set();
        this._lastInputPorts = new Map();   // name -> ALSA port index
        this._lastOutputPorts = new Map();   // name -> ALSA port index
        this._hotplugCheckInterval = null;
        this._autoRouteOnHotplug = true;
    }

    // ---- Calibration settings (saved between sessions; settings.json) ----
    _settingsPath() {
        return path.join(__dirname, 'settings.json');
    }

    _loadSettings() {
        try {
            if (!fs.existsSync(this._settingsPath())) return;
            const s = JSON.parse(fs.readFileSync(this._settingsPath(), 'utf8'));
            const clamp = (v, d) => (Number.isFinite(+v) ? Math.max(-200, Math.min(200, Math.round(+v))) : d);
            this.audioOffsetMs = clamp(s.audioOffsetMs, this.audioOffsetMs);
            this.clickOffsetMs = clamp(s.clickOffsetMs, this.clickOffsetMs);
            console.log(`[WORKER] Calibration loaded: audio ${this.audioOffsetMs} ms, click ${this.clickOffsetMs} ms`);
        } catch (e) {
            console.error('[WORKER] Settings load failed:', e.message);
        }
    }

    _saveSettings() {
        try {
            fs.writeFileSync(this._settingsPath(), JSON.stringify({
                audioOffsetMs: this.audioOffsetMs,
                clickOffsetMs: this.clickOffsetMs,
            }, null, 2) + '\n');
        } catch (e) {
            console.error('[WORKER] Settings save failed:', e.message);
        }
    }

    init() {
        try {
            console.log('[WORKER] MIDI initializing...');
            this._loadConfig();
            this._loadSettings();
            this.metronomeCtrl.setClickOffset(this.clickOffsetMs);
            if (NO_HARDWARE) {
                console.log('[WORKER] MIDIR_NO_HARDWARE=1: skipping port enumeration and hot-plug');
            } else {
                this._enumeratePorts();
            }
            this._selectDefaultClockSource();
            if (!NO_HARDWARE) this._startHotplugDetection();
        } catch (e) {
            console.error('[WORKER] MIDI init failed:', e.message);
            process.exit(1);
        }
    }
    
    /**
     * The default MIDI clock source is the first controller from the profiles
     * (Launchkey Mini MK3). Called after _enumeratePorts, when the real
     * port names are known.
     */
    _selectDefaultClockSource() {
        const profile = this.controllerEngine.profiles[0];
        if (!profile) return;
        // Find the real input port that matches the profile matcher.
        let portName = null;
        for (const name of this.inputs.keys()) {
            if (matches(name, profile.input)) { portName = name; break; }
        }
        if (!portName) return;
        this._clockMaster.selectExternal(portName);
        this.daw.setMidiClock(false); // the external master does not tick by itself
        console.log(`[WORKER] Default clock source: external (${portName})`);
    }

    /**
     * Keep the external clock master bound to its device across re-plugs.
     * The master is matched by stable name (no ALSA address).
     */
    _rebindClockMaster() {
        const source = this._clockMaster.source;
        if (source.kind !== 'external' || !source.masterPortName) return;
        if (this.inputs.has(source.masterPortName)) return;
        const key = stablePortKey(source.masterPortName);
        const match = [...this.inputs.keys()].find((name) => stablePortKey(name) === key);
        if (!match) {
            console.log(`[WORKER] Clock master ${source.masterPortName} not connected; waiting for it`);
            return;
        }
        this._clockMaster.selectExternal(match);
        console.log(`[WORKER] Clock master re-bound: ${match}`);
        this._broadcastState();
    }

    _startHotplugDetection() {
        // Use recursive setTimeout with back-off instead of fixed interval.
        // Back-off range: 5s (healthy) -> 30s (after repeated ALSA failures).
        this._hotplugCheckLoop();
        console.log('[WORKER] Hot-plug detection started (back-off: 5-30s)');
    }

    _hotplugCheckLoop() {
        this._checkHotplug().then(async (success) => {
            try { await this._verifyOutputConnections(); } catch (_) {}
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
    
    // ALSA quirk: kernel rawmidi ports lose their sequencer subscription
    // ("Connected From:" in `aconnect -l`) without the device itself
    // disappearing. In that state sendMessage() writes into a dangling port
    // and the device receives nothing ("routing is broken" while the log
    // shows the TX). Every hotplug tick we re-check all open outputs and
    // reopen any that lost the subscription.
    _verifyOutputConnections() {
        if (!this.outputs || this.outputs.size === 0) return Promise.resolve();
        if (this._aconnectProbeInFlight) return this._aconnectProbeInFlight;

        const probe = new Promise((resolve, reject) => {
            execFile('aconnect', ['-l'], { encoding: 'utf8', timeout: 5000 }, (error, stdout) => {
                if (error) {
                    // no aconnect / failure — skip this tick
                    resolve();
                    return;
                }
                let listing = String(stdout ?? '');

                try {
                    let currentPorts = [];
                    try { if (this._enumOut) currentPorts = this._filterPorts(this._enumOut, 'out'); } catch (_) {}

                    for (const [name, output] of this.outputs) {
                        // "Device:Port NN:NN" -> "Port" (display name aconnect shows)
                        const portDisplay = name.split(':').slice(1).join(':').replace(/ \d+:\d+$/, '');
                        const portIdx = listing.indexOf(`'${portDisplay}'`);
                        if (portIdx === -1) continue; // gone at kernel level — hotplug handles it
                        const blockEnd = listing.indexOf('\nclient ', portIdx);
                        const block = listing.slice(portIdx, blockEnd === -1 ? undefined : blockEnd);
                        if (block.includes('Connected From:')) continue; // subscription healthy

                        const current = currentPorts.find((p) => p.name === name);
                        const index = current ? current.index : output._index;
                        if (index == null) continue;
                        console.warn(`[WORKER] Output lost ALSA subscription: ${name} — reopening`);
                        try {
                            output.closePort();
                            output.openPort(index, 'midirouter-out');
                            output._index = index;
                            console.log(`[WORKER] Output reopened: ${name} (index: ${index})`);
                        } catch (error) {
                            console.error(`[WORKER] Failed to reopen output ${name}:`, error.message);
                        }
                    }

                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        }).finally(() => { this._aconnectProbeInFlight = null; });

        this._aconnectProbeInFlight = probe;
        return probe;
    }

    async _checkHotplug() {
        try {
            // Re-use persistent enumeration objects (do NOT create new ALSA clients every tick)
            if (!this._enumIn) this._enumIn = new midi.Input();
            if (!this._enumOut) this._enumOut = new midi.Output();

            const currentInputPorts = new Map();   // name -> index
            const currentOutputPorts = new Map();  // name -> index

            try {
                for (const p of this._filterPorts(this._enumIn, 'in')) {
                    if (!currentInputPorts.has(p.name)) currentInputPorts.set(p.name, p.index);
                }
            } catch(e) {}

            try {
                for (const p of this._filterPorts(this._enumOut, 'out')) {
                    if (!currentOutputPorts.has(p.name)) currentOutputPorts.set(p.name, p.index);
                }
            } catch(e) {}

            const addedInputs = [];
            const removedInputs = [];
            const movedInputs = [];   // name whose ALSA index changed (name unchanged)
            const addedOutputs = [];
            const removedOutputs = [];
            const movedOutputs = [];  // name whose ALSA index changed (name unchanged)

            for (const [name, index] of currentInputPorts) {
                if (!this._lastInputPorts.has(name)) addedInputs.push(name);
                else if (this._lastInputPorts.get(name) !== index) movedInputs.push(name);
            }
            for (const name of this._lastInputPorts.keys()) {
                if (!currentInputPorts.has(name)) removedInputs.push(name);
            }
            for (const [name, index] of currentOutputPorts) {
                if (!this._lastOutputPorts.has(name)) addedOutputs.push(name);
                else if (this._lastOutputPorts.get(name) !== index) movedOutputs.push(name);
            }
            for (const name of this._lastOutputPorts.keys()) {
                if (!currentOutputPorts.has(name)) removedOutputs.push(name);
            }

            const changed = addedInputs.length || removedInputs.length
                || addedOutputs.length || removedOutputs.length
                || movedInputs.length || movedOutputs.length;

            // If anything changed, re-enumerate ports. Snapshots are only
            // committed AFTER a successful re-enumeration so a failed attempt
            // leaves the previous state in place and the next poll retries.
            if (changed) {
                console.log(`[WORKER] HOT-PLUG: changes detected. +in:${addedInputs.length} -in:${removedInputs.length} ~in:${movedInputs.length} +out:${addedOutputs.length} -out:${removedOutputs.length} ~out:${movedOutputs.length}`);
                for (const name of addedInputs) {
                    console.log(`[WORKER] HOT-PLUG: New input: ${name}`);
                    parentPort?.postMessage({ type: 'hotplug-detected', deviceName: name, action: 'added', direction: 'input' });
                }
                for (const name of removedInputs) {
                    console.log(`[WORKER] HOT-PLUG: Input removed: ${name}`);
                    parentPort?.postMessage({ type: 'hotplug-detected', deviceName: name, action: 'removed', direction: 'input' });
                }
                for (const name of movedInputs) {
                    console.log(`[WORKER] HOT-PLUG: Input index changed: ${name} (${this._lastInputPorts.get(name)} -> ${currentInputPorts.get(name)})`);
                }
                for (const name of addedOutputs) {
                    console.log(`[WORKER] HOT-PLUG: New output: ${name}`);
                    parentPort?.postMessage({ type: 'hotplug-detected', deviceName: name, action: 'added', direction: 'output' });
                }
                for (const name of removedOutputs) {
                    console.log(`[WORKER] HOT-PLUG: Output removed: ${name}`);
                    parentPort?.postMessage({ type: 'hotplug-detected', deviceName: name, action: 'removed', direction: 'output' });
                }
                for (const name of movedOutputs) {
                    console.log(`[WORKER] HOT-PLUG: Output index changed: ${name} (${this._lastOutputPorts.get(name)} -> ${currentOutputPorts.get(name)})`);
                }

                // FULL re-enumeration to open/close actual RtMidi ports.
                if (this._enumeratePorts()) {
                    this._lastInputNames = new Set(currentInputPorts.keys());
                    this._lastOutputNames = new Set(currentOutputPorts.keys());
                    this._lastInputPorts = currentInputPorts;
                    this._lastOutputPorts = currentOutputPorts;
                    if (this._autoRouteOnHotplug) {
                        this._rebuildMappings();
                    }
                    return true; // success
                }
                console.error('[WORKER] HOT-PLUG re-enumeration failed; snapshots unchanged, will retry');
                return false;
            } else {
                this._lastInputNames = new Set(currentInputPorts.keys());
                this._lastOutputNames = new Set(currentOutputPorts.keys());
                this._lastInputPorts = currentInputPorts;
                this._lastOutputPorts = currentOutputPorts;
                return true; // no changes = healthy
            }
        } catch (e) {
            console.error('[WORKER] Hot-plug check failed:', e.message);
            return false;
        }
    }
    
    _rebuildMappings() {
        // Rebuild mappings when devices change
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
    _startTrackPlayback(trackIdx, slot, now = performance.now(), { immediate = false } = {}) {
        this._stopTrackPlayback(trackIdx);
        const clip = this.daw.tracks[trackIdx].clips[slot];
        if (!clip || clip.notes.length === 0) return;

        const msPerBeat = this.daw._secondsPerBeat() * 1000;
        // Each clip loops on ITS OWN length (a whole number of bars), but stays
        // phase-synchronized with the shared transport cycle (tempo + tick grid).
        const loopBeats = Math.max(1, Number(clip.length) || this.daw.loopLenBeats);
        const loopMs = loopBeats * msPerBeat;
        const playback = { interval: null, timeouts: new Set(), active: new Map() };
        const schedule = (fn, delay) => {
            const timer = setTimeout(() => { playback.timeouts.delete(timer); fn(); }, Math.max(0, delay));
            playback.timeouts.add(timer);
        };

        this._ledGlow.set(trackIdx, { slot, state: 'playing' });
        this._refreshPadLeds(trackIdx, slot);

        if (this._externalClockActive) {
            playback.externalClock = true;
            playback.loopTicks = Math.max(24, Math.round(loopBeats * 24));
            const currentTick = this._externalMidiClock.tickCount;
            // Immediate start (take just recorded) or next cycle start (manual launch).
            const cycleTicks = Math.max(24, Math.round(this.daw.loopLenBeats * 24));
            const sinceOrigin = currentTick - this.daw._externalCycleOriginTick;
            const untilCycle = immediate ? 0 : ((-sinceOrigin % cycleTicks) + cycleTicks) % cycleTicks;
            playback.startTick = currentTick + untilCycle;
            playback.noteEvents = clip.notes.map(note => ({
                ...note,
                startTick: ((Math.round(note.start * 24) % playback.loopTicks) + playback.loopTicks) % playback.loopTicks,
                durationTicks: Math.max(1, Math.round((note.dur || 0.25) * 24)),
            }));
            playback.pendingNoteOffs = new Map();
            this._trackPlayTimers.set(trackIdx, playback);
            return;
        }

        // Legato launch: a filled clip launched mid-bar waits for the nearest
        // upcoming transport cycle start, then plays every event from its own beat 0.
        // Immediate start (take just recorded) or next cycle start (manual launch).
        const barDelay = immediate ? 0 : this.daw.msUntilPhase(0, now);

        for (const note of clip.notes) {
            // Each event is stored relative to the clip's own beat 0, repeats every clip.length.
            const eventOffset = ((note.start % loopBeats) + loopBeats) % loopBeats;
            // Fire note-ons earlier by the audio latency offset (non-external path).
            // Note-off stays relative to its note-on, so duration is unchanged.
            let nextAt = now + barDelay + eventOffset * msPerBeat + (this.audioOffsetMs || 0);
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

    // A clip launched mid-bar waits for the next cycle start. The wait is kept
    // in its own map so that stop/reset can cancel it (otherwise the clip would
    // start after the transport was already stopped).
    _schedulePendingStart(trackIdx, slot, startAt, delayMs) {
        this._cancelPendingStart(trackIdx);
        if (!this._pendingClipStarts) this._pendingClipStarts = new Map();
        const timer = setTimeout(() => {
            this._pendingClipStarts.delete(trackIdx);
            // Start at the boundary we waited for, not at the (possibly late) timer
            // time, so a few ms of timer lateness is not read as a missed cycle.
            this._startTrackPlayback(trackIdx, slot, startAt);
        }, Math.max(0, delayMs));
        this._pendingClipStarts.set(trackIdx, timer);
    }

    _cancelPendingStart(trackIdx) {
        const timer = this._pendingClipStarts?.get(trackIdx);
        if (timer) {
            clearTimeout(timer);
            this._pendingClipStarts.delete(trackIdx);
        }
    }

    // Stops every clip that is playing or waiting to start.
    _stopAllClipPlayback() {
        const tracks = new Set([...this._trackPlayTimers.keys(), ...(this._pendingClipStarts?.keys() ?? [])]);
        for (const trackIdx of tracks) this._stopTrackPlayback(trackIdx);
    }

    _stopTrackPlayback(trackIdx) {
        this._cancelPendingStart(trackIdx);
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
            // A pad may stay lit as "idle" (pulsing) if the clip
            // has a recording — the state is computed from the DAW, not hardcoded.
            this._refreshPadLeds(trackIdx, glow.slot);
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
            // Audio latency offset (same compensation as the internal-clock path):
            // fire note-ons earlier by the latency converted to ticks
            // (24 PPQN: 1 beat = 24 ticks). Note-offs are scheduled relative to
            // when their note-on fired, so duration is unchanged.
            const msPerBeat = this.daw._secondsPerBeat() * 1000;
            const offsetTicks = Math.round((this.audioOffsetMs || 0) / msPerBeat * 24);
            for (const event of playback.noteEvents) {
                const onTick = ((event.startTick + offsetTicks) % playback.loopTicks + playback.loopTicks) % playback.loopTicks;
                if (onTick !== localTick) continue;
                const channel = Math.max(1, event.channel || 1);
                const key = `${channel}:${event.note}`;
                this._sendToSynthOutputs(noteOn(channel - 1, event.note, event.velocity > 0 ? event.velocity : 80));
                playback.active.set(key, (playback.active.get(key) || 0) + 1);
                const offTick = tick + event.durationTicks;
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
            this.daw._externalCycleOriginTick = this._externalMidiClock.tickCount;
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

    // --- Pad clock: MTC strictly on the controller's DAW port (clock-synced LED) ---
    // While at least one clip is active or a recording is running, the DAW port
    // of the controller (the profile's midiClockOutput section) receives MIDI clock
    // independently of the global MTC switch and the transport state — the pad LED
    // blinking is synced to it (LKM3: ch2 = blink, 1 bar).
    // Not started if the global clocks already tick to these ports
    // (transport + MTC enabled, internal master), to avoid duplicates.
    _padClockNeeded() {
        const active = this.daw.clipState?.some(s => s >= 0) || this.daw.recording != null;
        if (!active) return false;
        // The external master ticks by itself; a missing _clockMaster (test stubs) — no ticking.
        if (this._clockMaster?.source?.kind !== 'internal') return false;
        if (this.daw.playing && this.daw._midiClockEnabled) return false; // global MTC already ticks
        return true;
    }

    _sendPadClockOutputs(bytes) {
        for (const [name, output] of this.outputs) {
            if (!this.controllerEngine.isMidiClockOutput(name)) continue;
            try { output.sendMessage(Buffer.from(bytes)); }
            catch (error) { console.warn(`[DAW] Pad clock → ${name} failed: ${error.message}`); }
        }
    }

    _startPadClock() {
        if (this._padClockTimer) return;
        this._padClockPhase = performance.now();
        this._sendPadClockOutputs([0xfa]); // MIDI Start
        this._padClockTimer = setInterval(() => {
            const tick = (this.daw._secondsPerBeat() * 1000) / 24;
            const now = performance.now();
            const ticks = Math.floor((now - this._padClockPhase) / tick);
            if (ticks <= 0) return;
            this._padClockPhase += ticks * tick;
            if (ticks > 24) { this._padClockPhase = now; return; } // no burst race
            this._sendPadClockOutputs([0xf8]);
        }, Math.max(4, Math.round((this.daw._secondsPerBeat() * 1000) / 24)));
        console.log('[DAW] Pad clock started: MIDI clock → DAW controller port(s)');
    }

    _stopPadClock() {
        if (!this._padClockTimer) return;
        clearInterval(this._padClockTimer);
        this._padClockTimer = null;
        this._sendPadClockOutputs([0xfc]); // MIDI Stop
        console.log('[DAW] Pad clock stopped');
    }

    _syncPadClock() {
        if (this._padClockNeeded()) this._startPadClock();
        else this._stopPadClock();
    }

    _sendFeedback(trackIdx, slot, state) {
        for (const [name, output] of this.outputs) {
            for (const bytes of (this.controllerEngine.feedbackMessagesFor?.(name, trackIdx, slot, state)) || []) {
                try { output.sendMessage(Buffer.from(bytes)); }
                catch (error) { console.warn(`[CONTROLLER] Feedback to ${name} failed: ${error.message}`); }
            }
        }
    }

    // Desired LED state of a pad based on the actual DAW state:
    //   recording — this pad is being recorded right now;
    //   playing   — the LAST activated clip that is playing now (the only one that blinks);
    //   active    — another playing clip (lit continuously);
    //   idle      — inactive but filled (has a take, clip stopped)
    //               — pulsates;
    //   off       — empty clip with no recording.
    
    _padLedStateFor(trackIdx, slot) {
        // Count-in takes priority over recording LED while pending.
        if (this.daw.recording && this.daw.recording.track === trackIdx && this.daw.recording.slot === slot) {
            if (this.daw._countInRunning) return 'count-in';
            return 'recording';
        }
        const playing = this.daw.clipState[trackIdx] === slot;
        const clip = this.daw.tracks[trackIdx]?.clips?.[slot];
        if (playing) {
            const last = this._lastActivated;
            return (last && last.trackIdx === trackIdx && last.slot === slot) ? 'playing' : 'active';
        }
        if (clip && clip.notes.length > 0) return 'idle';
        return 'off';
    }

    // Production count-in completion handler — called via daw._onCountInComplete.
    // Extracted from the constructor closure so test fixtures can invoke it
    // directly (makeWorker wires the callback to this same method).
    _handleCountInComplete() {
        if (this.daw.recording == null) return;  // stale: recording was stopped during count-in
        console.log('[DAW] Count-in complete — starting actual recording');
        const now = performance.now();
        this.daw.recording.startTime = now;
        // The first take defines the global cycle: beat 0 of the cycle is the start of
        // the recording (the two-bar count-in is before it). Until a cycle is locked,
        // move the transport anchor here so the take's stop boundary and the cycle use
        // the same clock.
        if (!this.daw._globalCycleLocked && this.daw.playing) {
            this.daw._playAnchorTime = now;
            if (this.daw._externalClock && this._externalMidiClock) {
                this.daw._externalCycleOriginTick = this._externalMidiClock.tickCount;
                this.daw.recording.liveBaseBeat = 0; // recording start = cycle origin
            }
        }
        // Resend the physical LED feedback for this track/slot so the pad
        // transitions from orange (count-in) to red (recording).
        this._refreshPadLeds(this.daw.recording.track, this.daw.recording.slot);
        // Broadcast so the web UI leaves the red-blink "pending" state and
        // shows solid red (or orange for overdub) immediately.
        this._broadcastState();
    }

    // Updates the LED for one pad (trackIdx/slot) or for all pads of the profile.
    // Messages are sent only when the desired state changes, so the controller
    // is not flooded with identical messages. The pad feedback MIDI bytes on all outputs (for state comparison).
    
    _padLedMessagesFor(t, s, state) {
        return [...this.outputs.keys()].flatMap(name =>
            this.controllerEngine.feedbackMessagesFor?.(name, t, s, state) || []);
    }

    _refreshPadLeds(trackIdx, slot) {
        if (!this._padLedSent) this._padLedSent = new Map();
        const targets = (trackIdx != null && slot != null)
            ? [{ trackIdx, slot }]
            : (this.controllerEngine.padMappings?.() || []);
        for (const { trackIdx: t, slot: s } of targets) {
            if (s == null || !this.daw.tracks[t]?.clips?.[s]) continue;
            const key = `${t}:${s}`;
            const state = this._padLedStateFor(t, s);
            const prev = this._padLedSent.get(key);
            if (prev === state) continue;
            this._padLedSent.set(key, state);
            // playing/recorded may have IDENTICAL bytes (same color). Re-sending the same
            // noteOn makes the Launchkey LED flash again (blink) — so skip sending on identical bytes.
            
            if (prev && JSON.stringify(this._padLedMessagesFor(t, s, prev))
                === JSON.stringify(this._padLedMessagesFor(t, s, state))) continue;
            this._sendFeedback(t, s, state);
        }
    }

    _armLed(trackIdx, slot) {
        const prevSlot = this._ledGlow.get(trackIdx)?.slot;
        this._ledGlow.set(trackIdx, { trackIdx, slot, state: 'recording' });
        // A neighbouring pad of the same track (was playing/recorded) is recalculated at once
        // to its actual state — idle pulse for a non-empty clip.
        if (prevSlot != null && prevSlot !== slot) this._refreshPadLeds(trackIdx, prevSlot);
        this._refreshPadLeds(trackIdx, slot);
    }

    _clearStaleRecordingFeedback() {
        for (const [t, glow] of this._ledGlow) {
            if (glow.state !== 'recording') continue;
            if (this.daw.recording?.track === t && this.daw.recording?.slot === glow.slot) continue;
            this._refreshPadLeds(t, glow.slot);
            this._ledGlow.delete(t);
        }
    }

    _scheduleRecordingStop({ stopTransport = false, now = performance.now() } = {}) {
        const recording = this.daw.recording;
        if (!recording) return false;
        if (this._recordingStopTimer) clearTimeout(this._recordingStopTimer);

        const bar = Math.max(1, this.daw._metronomeBeatsPerMeasure || 4);
        const spb = this.daw._secondsPerBeat();
        let boundaryTime = now + bar * spb * 1000;
        if (this.daw.playing) {
            const currentBeat = Math.max(0, ((now - this.daw._playAnchorTime) / 1000) / spb);
            const nextBar = Math.ceil(currentBeat / bar) * bar;
            let delayMs = (nextBar - currentBeat) * spb * 1000;
            if (delayMs <= 5) delayMs = 0;
            boundaryTime = now + delayMs;
        }

        this._recordingStopTimer = setTimeout(() => {
            this._recordingStopTimer = null;
            if (this.daw.recording !== recording) return;

            const { track, slot, mode } = recording;
            const clip = this.daw.tracks[track]?.clips[slot];
            this.daw._stopRecording(this.daw._beatAt(boundaryTime), true);
            this.daw.quantizeClip(track, slot, this.quantizeGrid ?? 0.125);

            if (stopTransport) {
                this.daw.stopTransport();
                this._transportPlaying = false;
                this._stopAllClipPlayback();
                this.daw.clipState.fill(-1);
                // Panic: mute everything on all outputs.
                this.sendPanicNoteOff();
            } else if (mode === 'none' && clip?.notes.length) {
                this.daw.clipState[track] = slot;
                this._lastActivated = { trackIdx: track, slot };
                this._startTrackPlayback(track, slot, boundaryTime, { immediate: true });
            } else {
                this.daw.clipState[track] = -1;
                this._stopTrackPlayback(track);
            }

            this._syncPadClock();
            this._clearStaleRecordingFeedback();
            this._refreshPadLeds();
            this._broadcastState();
        }, Math.max(0, boundaryTime - performance.now()));
        return true;
    }

    _triggerPad(trackIdx, slot, now, { countIn = false } = {}) {
        // During an active count-in, ignore pad presses (except stop via transport).
        if (this.daw._countInRunning) {
            return { action: 'count-in', track: trackIdx, slot };
        }

        // A repeated press requests a stop at the next bar, keeping any held
        // notes recordable until the musical boundary is reached.
        if (this.daw.recording?.track === trackIdx && this.daw.recording?.slot === slot
            && this.daw.playing) {
            this._scheduleRecordingStop({ now });
            return { action: 'record-stop-pending', track: trackIdx, slot };
        }
        // Requirement 1: capture the "empty project" state BEFORE triggerPad —
        // the first clip in an empty project starts the global cycle from this
        // very moment (the transport starts below).
        const wasEmptyProject = this.daw.isEmptyProject();
        const result = this.daw.triggerPad(trackIdx, slot, now, { countIn });
        let visualEvent = null;
        if (['play', 'record-stop', 'record', 'overdub'].includes(result.action)) {
            visualEvent = {
                kind: result.action === 'record' || result.action === 'overdub' ? 'record-start' : 'clip-start',
                trackIdx,
                slot,
                mode: this.daw.recordMode,
            };
        }
        // The pad whose glow/recording is removed must immediately recalculate
        // to its actual state (idle pulse for a non-empty clip, etc.),
        // rather than wait for the general _refreshPadLeds() — otherwise the previous pad stays
        // lit without switching to pulsing.
        const prevTrackIdx = this._ledGlow.get(trackIdx)?.trackIdx;
        this._clearStaleRecordingFeedback();
        if (prevTrackIdx === trackIdx) this._refreshPadLeds(trackIdx, slot);
        if (result.action === 'play' || result.action === 'record-stop') {
            // record-stop: start playback only if the take has notes.
            // If there is time left until the start of the new bar, wait for it so as not to
            // play the tail of the previous cycle (notes from the middle of a bar).
            const hasNotes = this.daw.tracks?.[trackIdx]?.clips?.[slot]?.notes?.length > 0;
            if (result.action === 'record-stop' && !hasNotes) {
                this._stopTrackPlayback(trackIdx);
            } else {
                // A take that was just recorded plays at once from its own beat 0.
                // A manual launch of a stored clip waits for the next cycle start.
                const immediate = result.action === 'record-stop';
                const delayMs = immediate || !this.daw.playing ? 0 : this.daw.msUntilPhase(0, now);
                this._lastActivated = { trackIdx, slot };
                if (delayMs > 5) {
                    this._schedulePendingStart(trackIdx, slot, now + delayMs, delayMs);
                } else {
                    this._startTrackPlayback(trackIdx, slot, now, { immediate });
                }
            }
        } else if (result.action === 'stop' || result.action === 'record-stop-stopped') {
            // stop (Play mode) or replace-stop: the clip stays stopped
            this._stopTrackPlayback(trackIdx);
            this.daw.clipState[trackIdx] = -1;
        } else if (result.action === 'record' || result.action === 'overdub') {
            // Clear playback state before stopping so _stopTrackPlayback refreshes
            // the old clip as idle (pulse), not as still playing.
            this.daw.clipState[trackIdx] = -1;
            this._stopTrackPlayback(trackIdx);
            // Requirement 1: the first clip in an empty project starts the global
            // cycle (transport + MIDI clock) exactly at the press —
            // the recording is already anchored to beat 0 of this cycle.
            if (!this.daw.playing && wasEmptyProject && this.daw.adoptPreRecordCount()) {
                // The pre-record metronome (after Reset) already counted in; it is the
                // count-in, so no second count-in is started.
                this._transportPlaying = true;
            } else if (!this.daw.playing && (countIn || wasEmptyProject)) {
                this.daw.setMetronome(true);
                // Flag count-in BEFORE startTransport so the bar-delayed timer
                // fires inside startTransport (which stops/restarts metronome).
                if (wasEmptyProject) {
                    this.daw._countInRunning = true;
                    console.log('[DAW] Count-in started: 2 bars before recording');
                }
                this.daw.startTransport();
                this._transportPlaying = true;

            } else {
                this.daw.startTransport();
                this._transportPlaying = true;
            }
            // The recording was armed before the transport anchor was set, a few ms
            // later. Shift its start by the same amount so beat 0 of the take lines up
            // with the transport beat grid (otherwise the stop boundary is off by that gap).
            const anchorDrift = this.daw._playAnchorTime - now;
            if (this.daw.recording && anchorDrift > 0) this.daw.recording.startTime += anchorDrift;
            this._armLed(trackIdx, slot);
        } else if (result.action === 'invalid') {
            console.warn(`[DAW] Invalid pad target track ${trackIdx}, slot ${slot}`);
        }
        this._syncPadClock();
        this._broadcastState();
        if (visualEvent) this._emitVisualEvent(visualEvent);
        return result;
    }

    _emitVisualEvent(event) {
        if (parentPort) parentPort?.postMessage({ type: 'daw_visual_event', event });
    }

    _handleMappedPad(mapping, velocity, now) {
        // Clips toggle on a press. Releasing a pad must not end recording.
        if (mapping && velocity > 0) this._triggerPad(mapping.trackIdx, mapping.slot, now, { countIn: true });
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
                // Beats since the cycle origin, counted without wrapping: a take that
                // crosses a loop boundary must keep its timing (see daw.js).
                const beats = (this._externalMidiClock.tickCount - this.daw._externalCycleOriginTick) / 24;
                this.daw._playAnchorTime = now - beats * this.daw._secondsPerBeat() * 1000;
                const loopLen = Math.max(1, this.daw.loopLenBeats);
                this.daw._currentBeat = ((beats % loopLen) + loopLen) % loopLen;
                // Drive the metronome directly from each F8 tick so it stays
                // perfectly locked to the external clock source.
                if (this.daw._metronomeEnabled) {
                    this.daw._metronomeTick();
                }
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
            parentPort?.postMessage({ type: 'daw_midi', data: [0xf8] });

            // Retransmit the master tick to all allowed outputs (excluding master).
            this._sendMidiClockOutputs([0xf8]);
        } else {
            // Internal source — nothing to do here; the DAW engine's MidiClock
            // drives the allowed outputs directly via its own emit path.
        }
    }

    // Controller transport actions are defined by each profile.
    _handleProfileTransport(action, pressed = true) {
        if (action === 'play') {
            // Play on Launchkey — toggle: if playback is running, a press
            // stops it (transport + all clips).
            if (this._transportPlaying || this.daw.playing) {
                this.handleDawControl({ type: 'daw_stop_transport' });
            } else {
                this.handleDawControl({ type: 'daw_start_transport' });
            }
        }
        else if (action === 'stop') this.handleDawControl({ type: 'daw_stop_transport' });
        else if (action === 'loop') this.handleDawControl({ type: 'daw_toggle_loop' });
        else if (action === 'record') {
            // Session Record toggles recording without clearing existing clips.
            if (pressed) this.handleDawControl({ type: 'daw_toggle_session_record' });
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
                    return false; // Keep existing inputs untouched
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
                    return false;
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
            let inputReopenFailed = false;
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
                    inputReopenFailed = true;
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
            // A re-plugged device gets a new ALSA address, so its full name changes.
            // Re-bind the clock master to the device's new name instead of losing it.
            this._rebindClockMaster();
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

            let outputReopenFailed = false;
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
                    outputReopenFailed = true;
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

            // A moved-port reopen failure must abort BEFORE any snapshot is
            // committed: if the inventory (or a physical port) changed, the
            // hot-plug poll needs to retry with the stale snapshot intact.
            // Committing here would make the next poll see no diff and never
            // re-enumerate.
            if (inputReopenFailed || outputReopenFailed) {
                console.warn('[WORKER] _enumeratePorts finished with reopen failures; reporting failure so hot-plug does not commit the snapshot');
                return false;
            }

            parentPort?.postMessage({ type: 'ports-enumerated', inputs: inputList, outputs: outputList });
            parentPort?.postMessage({ type: 'ready' });

            this._lastInputNames = new Set(realInputs.map(r => r.name));
            this._lastOutputNames = new Set(realOutputs.map(r => r.name));
            // Synchronize the index snapshots too (startup and hot-plug both
            // call _enumeratePorts): without these, a first hot-plug poll after
            // init sees every existing port as newly added.
            this._lastInputPorts = new Map(realInputs.map(r => [r.name, r.index]));
            this._lastOutputPorts = new Map(realOutputs.map(r => [r.name, r.index]));

            return true; // full success
        } catch (e) {
            console.error('[WORKER] Enumerate failed:', e.message);
            return false;
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

        // Note messages consumed by the controller profile must still reach
        // recordEvent so that DAW recording captures them.  Only return early
        // for consumed non-note events (CC, program change, etc.).
        const isNoteOff = type === 8 && bytes.length >= 3;
        const isNoteOn2 = type === 9 && bytes.length >= 3;
        if ((control?.consume && !isNoteOn2 && !isNoteOff && control?.kind !== 'transport') || isSysEx) return;

        if (control?.kind === 'pad') {
            const eventTime = performance.now();
            this._handleMappedPad(control.pad, control.pressed ? 127 : 0, eventTime);
            // Pad input doubles as a performance note: keep pad triggering, but
            // feed the same timestamped MIDI event through the DAW's recording
            // gate.  That gate rejects events before recording.startTime.
            if (isNoteOn2 || isNoteOff) {
                this.daw.recordEvent(bytes[0], bytes[1], bytes[2] ?? 0, eventTime);
            }
            return;
        } else if (control?.kind === 'transport') {
            this._handleProfileTransport(control.action, control.ppressed);
        }

        // === Controller note handling (MIDI Port keybed, nanoPAD, etc.) ===

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
                // Send the current DAW state when the frontend requests it
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
            case 'daw_reset_arm_record': {
                // Reset: all clips to zero + ready for a new recording.
                // First stop playback (note-offs) and the transport,
                // then erase the clips; the default Mode is Play ('none').
                this._stopAllClipPlayback();
                if (this._transportPlaying || daw.playing) {
                    daw.stopTransport();
                    this._transportPlaying = false;
                }
                // resetAllClips itself starts the metronome for exactly two bars
                // (requirement 4): before the first recording or until the end of the bar.
                daw.resetAllClips();
                daw.setRecordMode('none');
                this._clearStaleRecordingFeedback();
                this._refreshPadLeds();
                console.log('[DAW] Reset: all clips cleared, track channels unassigned, Play mode armed');
                this._syncPadClock();
                this._broadcastState();
                break;
            }
            case 'daw_toggle_session_record': {
                if (daw.sessionRecording || daw.recording) {
                    daw.sessionRecording = false;
                    if (daw.recording && daw.playing) {
                        this._scheduleRecordingStop({ stopTransport: false });
                    } else if (daw.recording) {
                        const recording = daw.recording;
                        daw._stopRecording(daw._beatAt(performance.now()), true);
                        daw.quantizeClip(recording.track, recording.slot, this.quantizeGrid ?? 0.125);
                        this._clearStaleRecordingFeedback();
                        this._refreshPadLeds();
                    }
                } else {
                    daw.sessionRecording = true;
                    daw.setMetronome(true);
                    if (!daw.playing) {
                        daw.startTransport();
                        this._transportPlaying = true;
                    }
                }
                this._syncPadClock();
                this._broadcastState();
                break;
            }
            case 'daw_set_slots':
                daw.setSlotsPerTrack(msg.n);
                this._broadcastState();
                break;
            case 'daw_set_master_loop_bars':
                if (Number.isInteger(msg.bars)) {
                    const ok = daw.setMasterLoopBars(msg.bars);
                    console.log(`[WORKER] Master loop bars: ${ok ? msg.bars : `rejected (${msg.bars})`}`);
                }
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
                this._triggerPad(msg.trackIdx, msg.slot, performance.now(), { countIn: true });
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
            // Audio offset (ms): negative = clip notes earlier, positive = later.
            case 'daw_audio_offset': {
                const ms = Math.round(Number.isFinite(+msg.ms) ? +msg.ms : 0);
                this.audioOffsetMs = Math.max(-200, Math.min(200, ms));
                this._saveSettings();
                this._broadcastState();
                break;
            }
            // Click offset (ms): negative = clicks earlier, positive = later.
            case 'daw_click_offset': {
                const ms = Math.round(Number.isFinite(+msg.ms) ? +msg.ms : 0);
                this.clickOffsetMs = Math.max(-200, Math.min(200, ms));
                this.metronomeCtrl?.setClickOffset(this.clickOffsetMs);
                this._saveSettings();
                this._broadcastState();
                break;
            }
            // Quantization grid (beats): accept only the five allowed values.
            case 'daw_quantize_grid': {
                const beats = +msg.beats;
                if ([0.125, 0.25, 0.5, 1, 2].includes(beats)) {
                    this.quantizeGrid = beats;
                    // DAW keeps its own copy: quantizeClip is called with it as gridSize.
                    this.daw.quantizeGrid = beats;
                }
                this._broadcastState();
                break;
            }
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
                this._syncPadClock();
                this._broadcastState();
                break;
            case 'daw_start_with_countin':
                // "Rec" from stopped state: flag a two-bar count-in BEFORE
                // starting transport so the metronome counts in and the
                // master loop runs after it. With no active recording the
                // count-in completion is a no-op; pressing a pad during the
                // loop starts actual recording.
                if (!this._transportPlaying) {
                    daw._countInRunning = true;
                    daw.startTransport();
                    this._transportPlaying = true;
                }
                if (this._externalClockActive) this._externalTransportState = true;
                this._syncPadClock();
                this._broadcastState();
                break;
            case 'daw_stop_transport':
                if (daw.recording && daw.playing) {
                    // During a count-in, skip the bar-boundary deferred stop so
                    // that pressing Play immediately halts transport (and the
                    // audio metronome / count-in timer).  Active-recording stops
                    // still defer to the nearest bar boundary.
                    if (daw._countInRunning) {
                        daw.stopTransport();
                        this._transportPlaying = false;
                        // Panic: mute everything on all outputs.
                        this.sendPanicNoteOff();
                        break;
                    }
                    if (this._externalClockActive) this._externalTransportState = false;
                    this._scheduleRecordingStop({ stopTransport: true });
                    break;
                }
                if (this._externalClockActive) this._externalTransportState = false;
                if (this._transportPlaying) {
                    daw.stopTransport();
                    this._transportPlaying = false;
                }
                // Panic: mute everything on all outputs so no held/sustained
                // notes survive the stop.
                this.sendPanicNoteOff();
                if (daw.recording) daw._stopRecording(daw._beatAt(performance.now()));
                this._stopAllClipPlayback();
                daw.clipState.fill(-1);
                this._refreshPadLeds();
                this._syncPadClock();
                this._broadcastState();
                break;
            case 'daw_save_session':
                this._saveSession(msg.name);
                break;
            case 'daw_load_session':
                this._loadSession(msg.name);
                break;
            case 'daw_delete_session':
                this._deleteSession(msg.name);
                break;
            case 'daw_list_sessions':
                this._listSessions();
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
        state.audioOffsetMs = this.audioOffsetMs;
        state.clickOffsetMs = this.clickOffsetMs;
        state.quantizeGrid = this.quantizeGrid;
        parentPort?.postMessage({ type: 'daw_state', state });
    }

    _broadcastPadMap() {
        const activeProfiles = new Set([...this.inputs.keys()]
            .map(name => this.controllerEngine.profileForInput(name)?.id).filter(Boolean));
        parentPort?.postMessage({
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
        // Restore the actual state (playing/recorded/recording),
        // computed from the DAW — including pads with a recording that are not playing.
        for (const { trackIdx, slot } of targets.values()) {
            const state = this._padLedStateFor(trackIdx, slot);
            for (const bytes of this.controllerEngine.feedbackMessagesFor(name, trackIdx, slot, state)) {
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
        if (this._recordingStopTimer) {
            clearTimeout(this._recordingStopTimer);
            this._recordingStopTimer = null;
        }
        this.daw?._stopMetronome();
        this.metronomeCtrl?.kill();

        this._stopAllClipPlayback();
        this._stopPadClock();
        for (const [, input] of this.inputs || []) {
            if (input._handler) input.off('message', input._handler);
            try { input.closePort(); } catch(e) {}
        }
        for (const [, output] of this.outputs || []) {
            try { output.closePort(); } catch(e) {}
        }
        // Close persistent enumeration objects
        if (this._enumIn) { try { this._enumIn.closePort(); } catch(e) {} this._enumIn = null; }
        if (this._enumOut) { try { this._enumOut.closePort(); } catch(e) {} this._enumOut = null; }
    }
    
    // ---- Hot-plug: rebuild ports when devices are connected/disconnected ----
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
    
    // ---- Sessions: save/load recordings to disk (sessions/*.json) ----
    _sessionNameOf(rawName) {
        const base = String(rawName || '').replace(/\.json$/, '').replace(/[/\\]+/g, '').trim();
        const clean = base.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/^\.+/, '').slice(0, 64);
        return clean ? clean : '';
    }

    _sessionsDir() {
        const dir = path.join(__dirname, 'sessions');
        try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
        return dir;
    }

    _listSessions() {
        let names = [];
        try {
            names = fs.readdirSync(this._sessionsDir())
                .filter((f) => f.endsWith('.json'))
                .map((f) => f.slice(0, -5))
                .sort();
        } catch (_) {}
        if (parentPort) parentPort?.postMessage({ type: 'daw_session_list', sessions: names });
    }

    _saveSession(rawName) {
        try {
            const name = this._sessionNameOf(rawName);
            if (!name) throw new Error('invalid session name');
            const file = path.join(this._sessionsDir(), `${name}.json`);
            const data = this.daw.toData();
            const notes = data.tracks.reduce(
                (sum, t) => sum + t.clips.reduce((s, c) => s + c.notes.length, 0), 0);
            fs.writeFileSync(file, JSON.stringify(data, null, 2));
            console.log(`[DAW] Session saved: ${name} (${notes} notes)`);
            this._listSessions();
        } catch (error) {
            console.error(`[DAW] Session save failed: ${error.message}`);
            if (parentPort) parentPort?.postMessage({ type: 'daw_session_error', name: String(rawName || ''), error: error.message });
        }
    }

    _loadSession(rawName) {
        try {
            const name = this._sessionNameOf(rawName);
            if (!name) throw new Error('invalid session name');
            const file = path.join(this._sessionsDir(), `${name}.json`);
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));

            // Stop clip playback before restoring session content.
            this._stopAllClipPlayback();
            if (this._recordingStopTimer) {
                clearTimeout(this._recordingStopTimer);
                this._recordingStopTimer = null;
            }
            this.daw.loadData(data);
            this._transportPlaying = false;
            this._clearStaleRecordingFeedback();
            this._refreshPadLeds();
            this._syncPadClock();
            this._broadcastState();
            console.log(`[DAW] Session loaded: ${name}`);
        } catch (error) {
            console.error(`[DAW] Session load failed: ${error.message}`);
            if (parentPort) parentPort?.postMessage({ type: 'daw_session_error', name: String(rawName || ''), error: error.message });
        }
    }

    _deleteSession(rawName) {
        const name = this._sessionNameOf(rawName);
        if (name) {
            try {
                fs.unlinkSync(path.join(this._sessionsDir(), `${name}.json`));
                console.log(`[DAW] Session deleted: ${name}`);
            } catch (error) {
                console.error(`[DAW] Session delete failed: ${error.message}`);
            }
        }
        this._listSessions();
    }

    // ---- Panic: send All Notes Off to all outputs on all channels ----
    sendPanicNoteOff() {
        if (!this.outputs || this.outputs.size === 0) return;
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
        // Send a panic note-off before shutting down to release held notes
        worker.sendPanicNoteOff();
        worker.cleanup();
        // Force exit after 1 second to prevent blocking
        setTimeout(() => process.exit(0), 1000);
        process.exit(0);
    } else if (msg.type.startsWith('daw_')) {
        worker.handleDawControl(msg);
    } else if (msg.type === 'midi_send_to_target') {
        // Send a raw MIDI message to the target output
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
        // Send panic note-off on all outputs
        worker.sendPanicNoteOff();
    } else if (msg.type === 'reload_config') {
        // Reload the configuration
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
        parentPort?.postMessage({ type: 'config_reloaded' });
    } else if (msg.type === 'rebuild_mappings') {
        // Rebuild mappings on a hot-plug event
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
