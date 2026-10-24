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
    MULTITIMBRAL_PARTS,
    MAP_FILES,
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
        const file = MAP_FILES[model];
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
        for (const { target, channel, cc, value } of controls || []) this._controlValues.set(`${target}:${channel}:${cc}`, value);
        if (!first) this.render();   // closes open panels; reopening shows the loaded values
    }

    // A control changed from elsewhere (another browser or the MCP server): remember the raw
    // value and move the matching widget in an open panel without sending any MIDI.
    applyRemoteControl({ target, channel, cc, value }) {
        this._controlValues.set(`${target}:${channel}:${cc}`, value);
        for (const panel of document.querySelectorAll?.('.synth-controls[data-device-id]') || []) {
            if (panel.dataset.deviceId !== target || this.channelForKey(panel.dataset.unitKey, panel.dataset.part) !== channel) continue;
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
            const key = `${label.dataset.baseKey || label.dataset.deviceKey}:${this.channelForKey(label.dataset.deviceKey, label.dataset.part)}`;
            const program = this.programs.get(key);
            label.textContent = program == null ? '—' : this.presetNames.get(`${key}:${program}`) || String(program + 1);
            label.title = program == null ? 'Select a preset' : program > 127 ? `Preset ${program + 1} (bank ${(program >> 7) + 1}, program ${(program & 127) + 1})` : `Preset ${program + 1}`;
        });
    }

    updateChannels(channels) {
        const parts = obj => Object.keys(obj).filter(key => key.includes('#')).sort().join();
        const partsChanged = parts(this.channels) !== parts(channels);
        this.channels = { ...channels };
        if (partsChanged) this.render();   // a part was added or removed
        document.querySelectorAll?.('.device-midi-channel').forEach(select => {
            select.value = String(this.channels[select.dataset.deviceKey] || 1);
        });
        this.refreshPresetLabels();
    }

    channelForDevice(device, part) {
        return this.channelForKey(this.unitKey(device, part), part);
    }

    // Channel saved for a device, or for one part of a multitimbral device (default: part N on channel N).
    channelForKey(key, part) {
        const channel = this.channels[key];
        return validMidiChannel(channel) ? channel : (Number(part) || 1);
    }

    unitKey(device, part) {
        return part ? `${deviceChannelKey(device.name)}#${part}` : deviceChannelKey(device.name);
    }

    // Parts that exist for a multitimbral device (those with a saved channel), in order.
    partsOf(device) {
        const prefix = `${deviceChannelKey(device.name)}#`;
        return Object.keys(this.channels).filter(key => key.startsWith(prefix))
            .map(key => Number(key.slice(prefix.length))).filter(part => part >= 1 && part <= 16).sort((a, b) => a - b);
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
            el.appendChild(nameEl);

            const model = classifySynthPortName(dev.name).model;
            if (dev.output && MULTITIMBRAL_PARTS[model]) {
                // One card for the instrument; its parts are separate cards with their own controls and channels.
                el.className += ' device-group';
                nameEl.setAttribute('aria-expanded', 'true');
                this._renderParts(el, nameEl, dev, MULTITIMBRAL_PARTS[model]);
            } else {
                nameEl.addEventListener('click', () => this._toggleDevicePanel(dev, el, nameEl));
                if (dev.output) this._appendUnitControls(el, dev);
            }
            deviceList.appendChild(el);
        }
        this.refreshPresetLabels();
    }

    _renderParts(group, nameEl, dev, maxParts) {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'device-part-add';
        add.textContent = '+ Add part';
        add.title = `Add a part (up to ${maxParts}); part N starts on MIDI channel N`;
        const list = document.createElement('div');
        list.className = 'device-parts';
        const parts = this.partsOf(dev);
        add.disabled = parts.length >= maxParts;
        add.addEventListener('click', () => {
            if (window.app?.ws?.readyState !== WebSocket.OPEN) {
                window.app?.log?.('Connect to the router to add a part.');
                return;
            }
            const next = Array.from({ length: maxParts }, (_, i) => i + 1).find(part => !this.partsOf(dev).includes(part));
            if (next) window.app.ws.send(JSON.stringify({ type: 'set-device-part', target: dev.id, part: next, channel: next }));
        });
        nameEl.addEventListener('click', () => {
            const open = list.hidden;
            list.hidden = !open;
            nameEl.setAttribute('aria-expanded', String(open));
        });
        group.appendChild(add);
        if (!parts.length) {
            const empty = document.createElement('div');
            empty.className = 'synth-controls-message';
            empty.textContent = 'No parts yet. Add one for each part you use; each part has its own MIDI channel, preset and controls.';
            list.appendChild(empty);
        }
        for (const part of parts) {
            const card = document.createElement('div');
            card.className = 'device-item device-part connected';
            const partName = document.createElement('button');
            partName.type = 'button';
            partName.className = 'device-item-name';
            partName.textContent = `Part ${part}`;
            partName.title = `${dev.displayName} · part ${part}`;
            partName.setAttribute('aria-expanded', 'false');
            partName.addEventListener('click', () => this._toggleDevicePanel(dev, card, partName, part));
            card.appendChild(partName);
            this._appendUnitControls(card, dev, part);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'device-part-remove';
            remove.textContent = '×';
            remove.title = `Remove part ${part}`;
            remove.setAttribute('aria-label', `${dev.displayName}: remove part ${part}`);
            remove.addEventListener('click', () => {
                if (window.app?.ws?.readyState === WebSocket.OPEN) window.app.ws.send(JSON.stringify({ type: 'remove-device-part', target: dev.id, part }));
            });
            card.appendChild(remove);
            list.appendChild(card);
        }
        group.appendChild(list);
    }

    // Preset ‹ › buttons with the preset name, and the MIDI channel selector, for a device
    // or for one part of a multitimbral device.
    _appendUnitControls(el, dev, part) {
        const label = part ? `${dev.displayName} part ${part}` : dev.displayName;
        const unitKey = this.unitKey(dev, part);
        const baseKey = deviceChannelKey(dev.name);
        this.loadPresetCount(dev);
        const presets = document.createElement('div');
        presets.className = 'device-program-controls';
        const presetLabel = document.createElement('output');
        presetLabel.className = 'device-program-name';
        presetLabel.dataset.deviceKey = unitKey;
        presetLabel.dataset.baseKey = baseKey;
        if (part) presetLabel.dataset.part = String(part);
        presetLabel.setAttribute('aria-label', `${label} preset`);
        presetLabel.setAttribute('aria-live', 'polite');
        const programKey = () => `${baseKey}:${this.channelForDevice(dev, part)}`;
        for (const [text, step, description] of [['‹', -1, 'Previous preset'], ['›', 1, 'Next preset']]) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = text;
            button.title = `${description} (${step > 0 ? '+1' : '−1'})`;
            button.setAttribute('aria-label', `${label}: ${description}`);
            button.addEventListener('click', () => {
                if (window.app?.ws?.readyState !== WebSocket.OPEN) return;
                const key = programKey();
                const program = Math.max(0, Math.min(this.presetCounts.get(baseKey) - 1 || 127, (this.programs.get(key) ?? 0) + step));
                window.app.ws.send(JSON.stringify({ type: 'select-preset', target: dev.id, channel: this.channelForDevice(dev, part), index: program }));
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
        channel.dataset.deviceKey = unitKey;
        channel.setAttribute('aria-label', `${label} MIDI channel`);
        channel.title = 'Match the instrument’s MIDI receive channel';
        for (let number = 1; number <= 16; number++) {
            const option = document.createElement('option');
            option.value = String(number);
            option.textContent = `Ch ${number}`;
            channel.appendChild(option);
        }
        channel.value = String(this.channelForDevice(dev, part));
        channel.addEventListener('change', () => {
            const value = Number(channel.value);
            if (!validMidiChannel(value)) return;
            if (window.app?.ws?.readyState === WebSocket.OPEN) {
                this.channels[unitKey] = value;
                this.refreshPresetLabels();
                window.app.ws.send(JSON.stringify(part
                    ? { type: 'set-device-part', target: dev.id, part, channel: value }
                    : { type: 'set-device-channel', target: dev.id, channel: value }));
            } else {
                channel.value = String(this.channelForDevice(dev, part));
                window.app?.log?.('Connect to the router to save the MIDI channel.');
            }
        });
        el.appendChild(channel);
    }

    async _toggleDevicePanel(device, itemElement, nameButton, part) {
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
        panel.dataset.unitKey = this.unitKey(device, part);
        if (part) panel.dataset.part = String(part);
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
                    this._controlValues.set(`${device.id}:${this.channelForDevice(device, part)}:${definition.cc}`, bytes[2]);
                    this.sendMidi(device.id, bytes, part);
                };
                const saved = definition => {
                    const raw = this._controlValues.get(`${device.id}:${this.channelForDevice(device, part)}:${definition.cc}`);
                    return raw === undefined ? undefined : raw - (Number(definition.min) < 0 ? -Number(definition.min) : 0);
                };
                for (const plan of widgets) {
                    group.appendChild(plan.kind === 'xy' ? createXYPad(plan, send, saved) : createAdsrGraph(plan, send, saved));
                }
                for (const definition of rest) {
                    group.appendChild(this._createDeviceControl(device, model, definition, part));
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

    _createDeviceControl(device, model, definition, part) {
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
        const valueKey = () => `${device.id}:${this.channelForDevice(device, part)}:${definition.cc}`;
        const rawSaved = this._controlValues.get(valueKey());
        const savedValue = rawSaved === undefined ? undefined : rawSaved - (Number(definition.min) < 0 ? -Number(definition.min) : 0);
        const sendValue = value => {
            const bytes = buildMidiCcBytes(model, definition.cc, value, definition);
            this._controlValues.set(valueKey(), bytes[2]);
            this.sendMidi(device.id, bytes, part);
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

    sendMidi(targetId, bytes, part) {
        const device = this.outputs.find(port => port.id === targetId);
        if (device && (bytes[0] & 0xF0) === 0xB0) {
            bytes = [0xB0 | (this.channelForDevice(device, part) - 1), ...bytes.slice(1)];
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
