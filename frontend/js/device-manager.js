/* === Device Manager — управление MIDI устройствами === */

import {
    buildMidiCcBytes,
    getControlsForModel,
    getSynthRenderData,
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

    /** Рендеринг устройств */
    render() {
        const inputList = document.getElementById('input-list');
        const synthCards = document.getElementById('synth-cards');

        if (inputList) {
            inputList.innerHTML = '';
            for (const inp of this.inputs) {
                const el = document.createElement('div');
                el.className = 'device-item connected';
                el.textContent = inp.name;
                inputList.appendChild(el);
            }
        }

        // Synth cards: supported outputs expose their parameter controls in-place.
        if (synthCards) {
            const cards = getSynthRenderData(this.outputs);
            synthCards.innerHTML = '';
            for (const card of cards) {
                const el = document.createElement('div');
                el.className = 'synth-card' + (card.supported ? ' supported' : '');
                el.dataset.targetId = card.id;

                const nameEl = document.createElement('div');
                nameEl.className = 'synth-card-name';
                nameEl.textContent = card.name;

                const statusEl = document.createElement('div');
                statusEl.className = 'synth-card-status';
                statusEl.textContent = card.supported ? 'Supported' : 'Unsupported';

                el.appendChild(nameEl);
                el.appendChild(statusEl);

                if (card.supported) {
                    const toggle = document.createElement('button');
                    toggle.type = 'button';
                    toggle.className = 'synth-card-toggle';
                    toggle.textContent = 'Show controls';
                    toggle.setAttribute('aria-expanded', 'false');
                    toggle.addEventListener('click', () => this._toggleSynthControls(
                        card, el, toggle
                    ));
                    el.appendChild(toggle);
                }
                synthCards.appendChild(el);
            }
        }
    }

    async _toggleSynthControls(card, cardElement, toggle) {
        const current = cardElement.querySelector('.synth-controls');
        if (current) {
            current.remove();
            toggle.setAttribute('aria-expanded', 'false');
            toggle.textContent = 'Show controls';
            return;
        }

        const panel = document.createElement('div');
        panel.className = 'synth-controls';
        panel.setAttribute('aria-label', `${card.name} controls`);
        const loading = document.createElement('div');
        loading.className = 'synth-controls-message';
        loading.textContent = 'Loading controls…';
        panel.appendChild(loading);
        cardElement.appendChild(panel);
        toggle.setAttribute('aria-expanded', 'true');
        toggle.textContent = 'Hide controls';

        try {
            let definitions = this._synthControlCache.get(card.model);
            if (!definitions) {
                definitions = getControlsForModel(card.model);
                this._synthControlCache.set(card.model, definitions);
            }
            const controls = await definitions;
            if (!cardElement.contains(panel)) return;
            if (!controls || controls.length === 0) {
                this._synthControlCache.delete(card.model);
                throw new Error('Control map is empty or unavailable.');
            }
            panel.replaceChildren();
            for (const definition of controls) {
                panel.appendChild(this._createSynthControl(card, definition));
            }
        } catch (error) {
            this._synthControlCache.delete(card.model);
            if (!cardElement.contains(panel)) return;
            panel.replaceChildren();
            const message = document.createElement('div');
            message.className = 'synth-controls-message error';
            message.setAttribute('role', 'alert');
            message.textContent = 'Could not load synth controls. Try again.';
            panel.appendChild(message);
            console.error(`Failed to load controls for ${card.model}:`, error);
        }
    }

    _createSynthControl(card, definition) {
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
            this.sendMidi(card.id, buildMidiCcBytes(card.model, definition.cc, value));
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
