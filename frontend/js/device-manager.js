/* === Device Manager — управление MIDI устройствами === */

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

    /** Рендеринг устройств: один плоский список всех MIDI-портов (входы + выходы) */
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
            el.textContent = dev.name;
            deviceList.appendChild(el);
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
