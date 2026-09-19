/* === MIDI Router — all-to-all passthrough + DAW / Clip mode === */
import midi from '@julusian/midi';
import { parentPort } from 'worker_threads';
import { DAWEngine, noteOn, noteOff } from './daw.js';
import { portIndex, PortRecord } from './port-index.js';
import { ChannelFilter, VelocityFilter, MessageTypeFilter } from './filters.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class MIDIRouterWorker {
    constructor() {
        this.inputs = new Map();   // deviceName -> RtMidiIn instance
        this.outputs = new Map();  // deviceName -> RtMidiOut instance

        // DAW engine
        this.daw = new DAWEngine();
        this.daw._onEvent = (evt) => parentPort.postMessage({ type: 'daw_midi', data: evt.data });

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
                console.log(`[WORKER] Adding channel filter for ${name}:`, mapping.filters.channels);
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
            try { this.outputs.forEach(o => o.sendMessage([0x80 | 0, leadNote & 0x7f, 0])); } catch (e) {}
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

    _sendToAllOutputs(bytes) {
        for (const [, midiOut] of this.outputs) {
            try { midiOut.sendMessage(bytes); } catch (e) {}
        }
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
        try { this.outputs.forEach(o => o.sendMessage([0x90 | 0, note & 0x7f, vel])); } catch (e) {}
    }

    // flash: bright pulse that auto-offers after ms
    _flashLed(note, brightness, ms) {
        const vel = this._ledVelocity('red', brightness);   // downbeat = bright red pulse
        if (vel === 0) return;
        try { this.outputs.forEach(o => o.sendMessage([0x90 | 0, note & 0x7f, vel])); } catch (e) {}
        setTimeout(() => {
            try { this.outputs.forEach(o => o.sendMessage([0x80 | 0, note & 0x7f, 0])); } catch (e) {}
        }, ms);
    }

    _clearLed(note) {
        try { this.outputs.forEach(o => o.sendMessage([0x80 | 0, note & 0x7f, 0])); } catch (e) {}
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

        // While recording and the pressed key is NOT a mapped pad -> record it
        if (this.daw.recording && !isPad) {
            const statusByte = 0x90 | ((channel - 1) & 0x0f);
            this.daw.recordEvent(statusByte, note, velocity, now);
        }

        if (velocity > 0) {
            if (isPad) {
                const { trackIdx, slot } = this.padMap.get(note);
                const res = this.daw.triggerPad(trackIdx, slot, now);
                if (res.action === 'play') {
                    this.daw.setClipPlay(trackIdx, slot, now);
                    this._startTrackPlayback(trackIdx, slot);
                } else if (res.action === 'stop') {
                    this.daw.setClipPlay(trackIdx, slot, now);
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
                this.daw.setClipPlay(trackIdx, slot, now);
                this._startTrackPlayback(trackIdx, slot);
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
        const channel = type + 1;
        const label = {
            '9': `noteOn   ch${channel} n${bytes[1]} v${bytes[2]}`,
            '8': `noteOff  ch${channel} n${bytes[1]}`,
            '7': `CC       ch${channel} cc${bytes[1]} val${bytes[2]}`,
            'a': `afterCh  ch${channel} n${bytes[1]} v${bytes[2]}`,
            'c': `progCh   ch${channel} ${bytes[1]}`,
            'e': `chanPr   ch${channel} ${bytes[1]}`,
        }[String(type)];
        const name = label || (type >= 8 ? `sys  ${bytes[0] === 0xf8 ? 'timing clock' : bytes[0] === 0xfa ? 'start' : bytes[0] === 0xfb ? 'continue' : bytes[0] === 0xfc ? 'stop' : bytes[0] === 0xfe ? 'active sensing' : 'unknown sys'}` : `raw#${bytes.join(',')}`);

        // Skip loopback/timer ports to prevent feedback loops
        const isLoopback = deviceName.toLowerCase().includes('loopback') ||
                           deviceName.toLowerCase().includes('timer') ||
                           deviceName.toLowerCase().includes('midi through');
        if (isLoopback) {
            console.log(`[MIDI] [LOOPBACK] Ignoring: ${name}`);
            return;
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
        for (const [, mapping] of this._mappings) {
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
            
            // Debug: log filtered message
            if (mapping.filters.length > 0) {
                console.log(`[MIDI] [FILTER] Passed: ${name} channel=${processed.channel+1}`);
            }
            
            // Send to outputs
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
        
        // If no mappings matched, use default all-to-all routing
        if (this._mappings.size === 0) {
            let sent = 0;
            for (const [, midiOut] of this.outputs) {
                try { midiOut.sendMessage(Buffer.from(bytes)); sent++; } catch (e) {}
            }
            console.log(`[MIDI] ${deviceName} -> ${sent}/${this.outputs.size} outs: ${name}`);
        }
    }

    // ---- DAW control from server ----
    handleDawControl(msg) {
        const daw = this.daw;
        switch (msg.type) {
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
                this._broadcastState();
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
}

const worker = new MIDIRouterWorker();

parentPort.on('message', (msg) => {
    if (msg.type === 'shutdown') {
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
