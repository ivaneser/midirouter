/* === Device Manager — MIDI device management === */
import { attachMidiKnob } from './midi-knob.js';

import {
    buildMidiCcBytes,
    classifySynthPortName,
    getControlsForModel,
    renderControlDefinition,
} from './synth-catalog.js';

export class DeviceManager {
    constructor() {
        this.inputs = [];   // [{id, name}]
        this.outputs = [];  // [{id, name}]
        this.onStateChange = null;
        this._synthControlCache = new Map();
    }

    /** Refresh the port list */
    updatePorts(inputs, outputs) {
        this.inputs = inputs || [];
        this.outputs = outputs || [];
        this._notifyChange();
        this.render();
    }

    /** Get all devices */
    getAllDevices() {
        return [...this.inputs, ...this.outputs];
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
        const seen = new Set();
        for (const dev of [...this.inputs, ...this.outputs]) {
            if (seen.has(dev.name)) continue;
            seen.add(dev.name);

            const el = document.createElement('div');
            el.className = 'device-item connected';

            const nameEl = document.createElement('button');
            nameEl.type = 'button';
            nameEl.className = 'device-item-name';
            nameEl.textContent = dev.name;
            nameEl.setAttribute('aria-expanded', 'false');
            nameEl.addEventListener('click', () => this._toggleDevicePanel(dev, el, nameEl));

            el.appendChild(nameEl);
            deviceList.appendChild(el);
        }
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
        itemElement.appendChild(panel);
        nameButton.setAttribute('aria-expanded', 'true');

        if (!model) {
            const message = document.createElement('div');
            message.className = 'synth-controls-message';
            message.textContent = 'No parameter controls available for this device.';
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
            hint.textContent = 'Drag knobs up or down · Shift for fine adjustment · Keyboard arrows supported';
            panel.appendChild(hint);
            const groups = new Map();
            for (const definition of controls) {
                const category = definition.category || 'Parameters';
                if (!groups.has(category)) {
                    const section = document.createElement('section');
                    section.className = 'synth-control-section';
                    const heading = document.createElement('h5');
                    const categoryLabels = { osc: 'Oscillator', env: 'Envelope', mod: 'Modulation', amp: 'Amplifier', lfo: 'LFO', arp: 'Arpeggiator', fx_mod: 'Modulation effect', fx_delay: 'Delay effect', fx_reverb: 'Reverb effect' };
                    heading.textContent = categoryLabels[category] || category.replaceAll('_', ' ');
                    section.appendChild(heading);
                    const group = document.createElement('div');
                    group.className = 'synth-control-grid';
                    section.appendChild(group);
                    groups.set(category, group);
                    panel.appendChild(section);
                }
                groups.get(category).appendChild(this._createDeviceControl(device, model, definition));
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
                input.value = input.min;
            }
        } else {
            return row;
        }

        input.dataset.cc = String(definition.cc);
        input.setAttribute('aria-label', instruction.label.text);
        if (input.type === 'checkbox') {
            input.checked = false;
        }
        const sendValue = value => this.sendMidi(device.id, buildMidiCcBytes(model, definition.cc, value));
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
    sendMidi(targetId, bytes) {
        if (window.app && window.app.ws && window.app.ws.readyState === WebSocket.OPEN) {
            window.app.ws.send(JSON.stringify({
                type: 'midi-send',
                data: { bytes, timestamp: Date.now() },
                target: targetId
            }));
        }
    }
}
