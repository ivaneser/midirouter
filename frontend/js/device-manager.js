/* === Device Manager — MIDI device management === */
import { attachMidiKnob } from './midi-knob.js?v=23';
import { planWidgets, createXYPad, createAdsrGraph } from './synth-widgets.js?v=1';
import { connectedDevices, uniquePorts } from './connected-devices.js';
import { groupSynthControls } from './synth-layout.js?v=24';
import { deviceChannelKey, validMidiChannel } from './device-channels.js';

import {
    buildMidiCcBytes,
    classifySynthPortName,
    getControlsForModel,
    renderControlDefinition,
} from './synth-catalog.js?v=24';

export class DeviceManager {
    constructor() {
        this.inputs = [];   // [{id, name}]
        this.outputs = [];  // [{id, name}]
        this.onStateChange = null;
        this._synthControlCache = new Map();
        // Last value sent per device+CC, so a re-opened panel shows what the synth was set to.
        this._controlValues = new Map();
        this.channels = {};
        this.programs = new Map();
        this.presetNames = new Map();
        this.presetCounts = new Map();
    }

    async loadPresetCount(dev) {
        const model = classifySynthPortName(dev.name).model;
        const file = { 'arturia-microfreak': 'arturia_microfreak' }[model];
        if (!file || this.presetCounts.has(deviceChannelKey(dev.name))) return;
        try {
            const map = await (await fetch(`/device_maps/${file}.json`)).json();
            if (map.presetName?.programs > 128) this.presetCounts.set(deviceChannelKey(dev.name), map.presetName.programs);
        } catch (_) { /* keep 128 presets */ }
    }

    updatePresetName({ target, channel, program, name }) {
        const device = this.outputs.find(d => d.id === target);
        if (!device || typeof name !== 'string') return;
        const key = `${deviceChannelKey(device.name)}:${channel}`;
        if (this.programs.get(key) !== program) return;
        this.presetNames.set(`${key}:${program}`, name);
        this.refreshPresetLabels();
    }

    // Controls restored by loading a session: replace the remembered values (raw CC bytes).
    updateDeviceControls(controls, revision) {
        if (revision === this._controlsRevision) return;
        const first = this._controlsRevision === undefined;
        this._controlsRevision = revision;
        this._controlValues.clear();
        for (const { target, cc, value } of controls || []) this._controlValues.set(`${target}:${cc}`, value);
        if (!first) this.render();   // closes open panels; reopening shows the loaded values
    }

    // A control changed from elsewhere (another browser or the MCP server): remember the raw
    // value and move the matching widget in an open panel without sending any MIDI.
    applyRemoteControl({ target, cc, value }) {
        this._controlValues.set(`${target}:${cc}`, value);
        for (const panel of document.querySelectorAll?.('.synth-controls[data-device-id]') || []) {
            if (panel.dataset.deviceId !== target) continue;
            for (const input of panel.querySelectorAll(`[data-cc="${Number(cc)}"]`)) {
                const min = Number(input.dataset.min || 0);
                const display = value - (min < 0 ? -min : 0);
                if (input.type === 'range') {
                    if (input === document.activeElement) continue;   // the user is dragging it
                    input.value = String(display);
                    input.dispatchEvent(new Event('knob-sync'));
                } else if (input.type === 'checkbox') input.checked = display > 0;
                else if (input.tagName === 'SELECT') input.selectedIndex = display - min;
            }
        }
    }

    updateDevicePresets(presets) {
        this.programs.clear();
        for (const { target, channel, program } of presets || []) {
            this.programs.set(`${deviceChannelKey(target)}:${channel}`, program);
        }
        this.refreshPresetLabels();
    }

    refreshPresetLabels() {
        document.querySelectorAll?.('.device-program-name').forEach(label => {
            const key = `${label.dataset.deviceKey}:${this.channels[label.dataset.deviceKey] || 1}`;
            const program = this.programs.get(key);
            label.textContent = program == null ? '—' : this.presetNames.get(`${key}:${program}`) || String(program + 1);
            label.title = program == null ? 'Select a preset' : program > 127 ? `Preset ${program + 1} (bank ${(program >> 7) + 1}, program ${(program & 127) + 1})` : `Preset ${program + 1}`;
        });
    }

    updateChannels(channels) {
        this.channels = { ...channels };
        document.querySelectorAll?.('.device-midi-channel').forEach(select => {
            select.value = String(this.channels[select.dataset.deviceKey] || 1);
        });
        this.refreshPresetLabels();
    }

    channelForDevice(device) {
        const channel = this.channels[deviceChannelKey(device.name)];
        return validMidiChannel(channel) ? channel : 1;
    }

    /** Refresh the port list */
    updatePorts(inputs, outputs) {
        this.inputs = uniquePorts(inputs);
        this.outputs = uniquePorts(outputs);
        this._notifyChange();
        this.render();
    }

    /** Get all devices */
    getAllDevices() {
        return connectedDevices(this.inputs, this.outputs);
    }

    /** Get a device by ID */
    getDeviceById(id) {
        return this.inputs.find(d => d.id === id) || this.outputs.find(d => d.id === id);
    }

    /**
     * Rendering devices: one flat list of all MIDI ports (inputs + outputs).
     * The device name is clickable: a click expands a panel with its parameters
     * (synth controls from device_maps) or a placeholder for unknown devices.
     */
    render() {
        const deviceList = document.getElementById('device-list');
        if (!deviceList) return;

        deviceList.innerHTML = '';
        for (const dev of this.getAllDevices()) {

            const el = document.createElement('div');
            el.className = 'device-item connected';

            const nameEl = document.createElement('button');
            nameEl.type = 'button';
            nameEl.className = 'device-item-name';
            nameEl.textContent = dev.displayName;
            nameEl.title = `${dev.name} · ${dev.input && dev.output ? 'Input / Output' : dev.output ? 'Output' : 'Input'}`;
            nameEl.setAttribute('aria-expanded', 'false');
            nameEl.addEventListener('click', () => this._toggleDevicePanel(dev, el, nameEl));

            el.appendChild(nameEl);
            if (dev.output) {
                this.loadPresetCount(dev);
                const presets = document.createElement('div');
                presets.className = 'device-program-controls';
                const presetLabel = document.createElement('output');
                presetLabel.className = 'device-program-name';
                presetLabel.dataset.deviceKey = deviceChannelKey(dev.name);
                presetLabel.setAttribute('aria-label', `${dev.displayName} preset`);
                presetLabel.setAttribute('aria-live', 'polite');
                const programKey = () => `${deviceChannelKey(dev.name)}:${this.channelForDevice(dev)}`;
                for (const [text, step, description] of [['‹', -1, 'Previous preset'], ['›', 1, 'Next preset']]) {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.textContent = text;
                    button.title = `${description} (${step > 0 ? '+1' : '−1'})`;
                    button.setAttribute('aria-label', `${dev.displayName}: ${description}`);
                    button.addEventListener('click', () => {
                        if (window.app?.ws?.readyState !== WebSocket.OPEN) return;
                        const key = programKey();
                        const program = Math.max(0, Math.min(this.presetCounts.get(deviceChannelKey(dev.name)) - 1 || 127, (this.programs.get(key) ?? 0) + step));
                        window.app.ws.send(JSON.stringify({ type: 'select-preset', target: dev.id, channel: this.channelForDevice(dev), index: program }));
                        this.programs.set(key, program);
                        // Clear cached names until this selection is confirmed by the device.
                        this.presetNames.delete(`${key}:${program}`);
                        this.refreshPresetLabels();
                        presets.title = `Last requested preset: ${program + 1}`;
                    });
                    if (step > 0) presets.appendChild(presetLabel);
                    presets.appendChild(button);
                }
                el.appendChild(presets);
                const channel = document.createElement('select');
                channel.className = 'device-midi-channel';
                channel.dataset.deviceKey = deviceChannelKey(dev.name);
                channel.setAttribute('aria-label', `${dev.displayName} MIDI channel`);
                channel.title = 'Match the instrument’s MIDI receive channel';
                for (let number = 1; number <= 16; number++) {
                    const option = document.createElement('option');
                    option.value = String(number);
                    option.textContent = `Ch ${number}`;
                    channel.appendChild(option);
                }
                channel.value = String(this.channelForDevice(dev));
                channel.addEventListener('change', () => {
                    const value = Number(channel.value);
                    if (!validMidiChannel(value)) return;
                    if (window.app?.ws?.readyState === WebSocket.OPEN) {
                        this.channels[deviceChannelKey(dev.name)] = value;
                        this.refreshPresetLabels();
                        window.app.ws.send(JSON.stringify({ type: 'set-device-channel', target: dev.id, channel: value }));
                    } else {
                        channel.value = String(this.channelForDevice(dev));
                        window.app?.log?.('Connect to the router to save the MIDI channel.');
                    }
                });
                el.appendChild(channel);
            }
            deviceList.appendChild(el);
        }
        this.refreshPresetLabels();
    }

    async _toggleDevicePanel(device, itemElement, nameButton) {
        const current = itemElement.querySelector('.synth-controls');
        if (current) {
            current.remove();
            nameButton.setAttribute('aria-expanded', 'false');
            return;
        }

        const { model } = classifySynthPortName(device.name);
        const panel = document.createElement('div');
        panel.className = 'synth-controls';
        panel.setAttribute('aria-label', `${device.name} controls`);
        panel.dataset.deviceId = device.id;
        itemElement.appendChild(panel);
        nameButton.setAttribute('aria-expanded', 'true');

        if (!model || !device.output) {
            const message = document.createElement('div');
            message.className = 'synth-controls-message';
            message.textContent = !device.output
                ? 'Input-only port. A MIDI output is needed to control this instrument.'
                : 'No parameter controls available for this device.';
            panel.appendChild(message);
            return;
        }

        const loading = document.createElement('div');
        loading.className = 'synth-controls-message';
        loading.textContent = 'Loading controls…';
        panel.appendChild(loading);

        try {
            let definitions = this._synthControlCache.get(model);
            if (!definitions) {
                definitions = getControlsForModel(model);
                this._synthControlCache.set(model, definitions);
            }
            const controls = await definitions;
            if (!itemElement.contains(panel)) return;
            if (!controls || controls.length === 0) {
                this._synthControlCache.delete(model);
                throw new Error('Control map is empty or unavailable.');
            }
            panel.replaceChildren();
            const hint = document.createElement('p');
            hint.className = 'synth-controls-hint';
            hint.textContent = 'Drag knobs up or down, or drag points on the filter pad and envelope graphs · Shift for fine adjustment · Arrow keys supported';
            panel.appendChild(hint);
            for (const { label, controls: sectionControls } of groupSynthControls(controls)) {
                const section = document.createElement('section');
                section.className = 'synth-control-section';
                const heading = document.createElement('h5');
                heading.textContent = label;
                section.appendChild(heading);
                const group = document.createElement('div');
                group.className = 'synth-control-grid';
                section.appendChild(group);
                panel.appendChild(section);
                const { widgets, rest } = planWidgets(sectionControls);
                const send = (definition, value) => {
                    const bytes = buildMidiCcBytes(model, definition.cc, value, definition);
                    this._controlValues.set(`${device.id}:${definition.cc}`, bytes[2]);
                    this.sendMidi(device.id, bytes);
                };
                const saved = definition => {
                    const raw = this._controlValues.get(`${device.id}:${definition.cc}`);
                    return raw === undefined ? undefined : raw - (Number(definition.min) < 0 ? -Number(definition.min) : 0);
                };
                for (const plan of widgets) {
                    group.appendChild(plan.kind === 'xy' ? createXYPad(plan, send, saved) : createAdsrGraph(plan, send, saved));
                }
                for (const definition of rest) {
                    group.appendChild(this._createDeviceControl(device, model, definition));
                }
            }
        } catch (error) {
            this._synthControlCache.delete(model);
            if (!itemElement.contains(panel)) return;
            panel.replaceChildren();
            const message = document.createElement('div');
            message.className = 'synth-controls-message error';
            message.setAttribute('role', 'alert');
            message.textContent = 'Could not load device controls. Try again.';
            panel.appendChild(message);
            console.error(`Failed to load controls for ${model}:`, error);
        }
    }

    _createDeviceControl(device, model, definition) {
        const instruction = renderControlDefinition(definition);
        const row = document.createElement('label');
        row.className = 'synth-control';
        const title = document.createElement('span');
        title.className = 'synth-control-name';
        title.textContent = instruction.label.text;
        row.appendChild(title);

        let input;
        if (instruction.tag === 'select') {
            input = document.createElement('select');
            for (const optionText of instruction.options || []) {
                const option = document.createElement('option');
                option.textContent = String(optionText);
                input.appendChild(option);
            }
        } else if (instruction.tag === 'input') {
            input = document.createElement('input');
            input.type = instruction.attrs.type;
            if (input.type === 'range') {
                input.min = instruction.attrs.min;
                input.max = instruction.attrs.max;
                input.value = instruction.attrs.value;
            }
        } else {
            return row;
        }

        input.dataset.cc = String(definition.cc);
        input.dataset.min = String(definition.min ?? 0);
        input.setAttribute('aria-label', instruction.label.text);
        if (input.type === 'checkbox') {
            input.checked = false;
        }
        const valueKey = `${device.id}:${definition.cc}`;
        const rawSaved = this._controlValues.get(valueKey);
        const savedValue = rawSaved === undefined ? undefined : rawSaved - (Number(definition.min) < 0 ? -Number(definition.min) : 0);
        const sendValue = value => {
            const bytes = buildMidiCcBytes(model, definition.cc, value, definition);
            this._controlValues.set(valueKey, bytes[2]);
            this.sendMidi(device.id, bytes);
        };
        if (savedValue !== undefined) {
            if (input.type === 'range') input.value = String(savedValue);
            else if (input.type === 'checkbox') input.checked = savedValue > 0;
            else input.selectedIndex = savedValue - Number(definition.min || 0);
        }
        if (input.type === 'range') {
            row.className += ' synth-control-knob';
            const dial = document.createElement('span');
            dial.className = 'midi-knob';
            const face = document.createElement('span');
            face.className = 'midi-knob-face';
            face.setAttribute('aria-hidden', 'true');
            dial.appendChild(face);
            input.className = 'midi-knob-input';
            dial.appendChild(input);
            row.appendChild(dial);
            const readout = document.createElement('output');
            readout.className = 'midi-knob-value';
            row.appendChild(readout);
            attachMidiKnob(input, dial, readout, sendValue);
        } else {
            row.className += input.type === 'checkbox' ? ' synth-control-toggle' : ' synth-control-select';
            input.addEventListener('change', () => {
                const value = input.type === 'checkbox'
                    ? (input.checked ? 127 : 0)
                    : input.selectedIndex + Number(definition.min || 0);
                sendValue(value);
            });
            row.appendChild(input);
        }
        const cc = document.createElement('span');
        cc.className = 'synth-control-cc';
        cc.textContent = `CC ${definition.cc}`;
        row.appendChild(cc);
        return row;
    }

    /** Notify about a change */
    _notifyChange() {
        if (this.onStateChange) {
            this.onStateChange({
                type: 'devices',
                inputs: this.inputs,
                outputs: this.outputs
            });
        }
    }

    /** Send a MIDI message */
    sendPerformance(targets, bytes) {
        if (window.app?.ws?.readyState === WebSocket.OPEN) {
            // Stamp the event on the router's clock so recordings ignore network latency.
            const at = Math.round(Date.now() + (window.app.clockOffset || 0));
            window.app.ws.send(JSON.stringify({ type: 'midi-performance', targets, bytes, at }));
        }
    }

    sendMidi(targetId, bytes) {
        const device = this.outputs.find(port => port.id === targetId);
        if (device && (bytes[0] & 0xF0) === 0xB0) {
            bytes = [0xB0 | (this.channelForDevice(device) - 1), ...bytes.slice(1)];
        }
        if (window.app && window.app.ws && window.app.ws.readyState === WebSocket.OPEN) {
            window.app.ws.send(JSON.stringify({
                type: 'midi-send',
                data: { bytes, timestamp: Date.now() },
                target: targetId
            }));
        }
    }
}
