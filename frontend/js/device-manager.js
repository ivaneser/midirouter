/* === Device Manager — управление MIDI устройствами === */

import { getSynthRenderData } from './synth-catalog.js';

export class DeviceManager {
    constructor() {
        this.inputs = [];   // [{id, name}]
        this.outputs = [];  // [{id, name}]
        this.onStateChange = null;
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

        // Slice 1: render supported synth cards from outputs.
        // The existing `midi-send` path (DeviceManager.sendMidi -> WS -> router._sendMidiToTarget)
        // is deliberately untouched here; it still uses this.outputs internally on the server.
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
                synthCards.appendChild(el);
            }
        }
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
