/* === Device Manager — управление MIDI устройствами === */

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

    /** Обновить список портов */
    updatePorts(inputs, outputs) {
        this.inputs = inputs || [];
        this.outputs = outputs || [];
        this._notifyChange();
        this.render();
    }

    /** Получить все устройства */
    getAllDevices() {
        return [...this.inputs, ...this.outputs];
    }

    /** Получить устройство по ID */
    getDeviceById(id) {
        return this.inputs.find(d => d.id === id) || this.outputs.find(d => d.id === id);
    }

    /**
     * Рендеринг устройств: один плоский список всех MIDI-портов (входы + выходы).
     * Название устройства кликабельно: по клику раскрывается панель параметров
     * (контролы синтезатора из device_maps) или заглушка для неизвестных устройств.
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
            for (const definition of controls) {
                panel.appendChild(this._createDeviceControl(device, model, definition));
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
        if (input.type === 'checkbox') {
            input.checked = false;
        }
        const eventName = input.type === 'range' ? 'input' : 'change';
        input.addEventListener(eventName, () => {
            const value = input.type === 'checkbox'
                ? (input.checked ? 127 : 0)
                : input.type === 'range'
                    ? input.value
                    : input.selectedIndex + Number(definition.min || 0);
            this.sendMidi(device.id, buildMidiCcBytes(model, definition.cc, value));
        });
        row.appendChild(input);
        return row;
    }

    /** Уведомить об изменении */
    _notifyChange() {
        if (this.onStateChange) {
            this.onStateChange({
                type: 'devices',
                inputs: this.inputs,
                outputs: this.outputs
            });
        }
    }

    /** Отправить MIDI сообщение */
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
