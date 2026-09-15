/* === Device Manager — WebSocket + MIDI маршрутизация === */

class DeviceManager {
    constructor() {
        this.ws = null;
        this.devices = new Map();  // deviceId → deviceInfo
        this.routes = new Map();   // inputPortId → outputPortId
        this.onStateChange = null;
        this.onMidiMessage = null;
        this.autoDiscoverMode = false;
    }

    connect(url) {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(url);

                this.ws.onopen = () => {
                    console.log('Connected to MIDI Router');
                    this._updateStatus(true);
                    resolve();
                };

                this.ws.onmessage = (event) => {
                    const data = JSON.parse(event.data);
                    this._handleMessage(data);
                };

                this.ws.onerror = (err) => reject(err);
                this.ws.onclose = () => this._updateStatus(false);
            } catch (e) {
                reject(e);
            }
        });
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
            this._updateStatus(false);
        }
    }

    _handleMessage(data) {
        switch (data.type) {
            case 'devices':
                this.devices.clear();
                // Сервер отправляет { inputs: [...], outputs: [...] }
                (data.inputs || []).forEach(d => this.devices.set(d.id, d));
                (data.outputs || []).forEach(d => this.devices.set(d.id, d));
                this._notifyChange('devices');
                break;

            case 'route-updated': {
                // Сервер прислал подтверждение маршрута — добавляем в routes
                if (!this.routes.has(data.inputId)) {
                    this.routes.set(data.inputId, []);
                }
                const dests = this.routes.get(data.inputId);
                if (!dests.includes(data.outputId)) {
                    dests.push(data.outputId);
                }
                this._notifyChange('routes');
                break;
            }

            case 'route-removed': {
                // Сервер удалил маршрут — убираем из локального состояния
                const dests = this.routes.get(data.inputId);
                if (dests) {
                    const idx = dests.indexOf(data.outputId);
                    if (idx > -1) dests.splice(idx, 1);
                    if (dests.length === 0) this.routes.delete(data.inputId);
                }
                this._notifyChange('routes');
                break;
            }

            case 'route':
                if (data.action === 'add') {
                    this.routes.set(data.inputId, data.outputId);
                } else if (data.action === 'remove') {
                    this.routes.delete(data.inputId);
                }
                this._notifyChange('routes');
                break;

            case 'midi':
                // Бинарные MIDI сообщения (Uint8Array)
                if (this.onMidiMessage) {
                    const bytes = new Uint8Array(data.bytes);
                    this.onMidiMessage(bytes, data.sourcePort);
                }
                break;

            case 'auto-discover':
                this.autoDiscoverMode = data.active;
                console.log('Auto-discovery:', data.active ? 'ON' : 'OFF');
                break;

            case 'discovery-complete':
                console.log('[DeviceManager] Auto-discovery completed — route created');
                break;

            case 'scheme-loaded':
                if (this.onSchemeEvent) {
                    this.onSchemeEvent({ type: 'scheme-loaded', name: data.name, inputId: data.inputId, scheme: data.scheme });
                }
                break;

            case 'scheme-search-failed':
                if (this.onSchemeEvent) {
                    this.onSchemeEvent({ type: 'scheme-search-failed', name: data.name, inputId: data.inputId });
                }
                break;

            case 'scheme-search-error':
                if (this.onSchemeEvent) {
                    this.onSchemeEvent({ type: 'scheme-search-error', name: data.name, error: data.error });
                }
                break;

            default:
                console.warn('Unknown message type:', data.type);
        }
    }

    // Отправка MIDI сообщения на порт
    sendMidi(portId, bytes) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const bin = new Uint8Array(bytes);
        const base64 = btoa(String.fromCharCode(...bin));
        this.ws.send(JSON.stringify({
            type: 'midi',
            port: portId,
            bytes: base64
        }));
    }

    // Отправка CC от виртуального контроллера
    sendCC(portId, ccNumber, value) {
        const bytes = [0xB0 | (this.channel - 1 || 0), ccNumber, value];
        this.sendMidi(portId, bytes);
    }

    // Toggle режим авто-обнаружения
    toggleAutoDiscover() {
        if (!this.ws) return;
        this.autoDiscoverMode = !this.autoDiscoverMode;
        this.ws.send(JSON.stringify({
            type: 'auto-discover',
            active: this.autoDiscoverMode
        }));
    }

    // Создать маршрут input → output с фильтрацией по каналам (channels = null → все каналы)
    createRoute(inputId, outputId, channels = null) {
        if (!this.ws) return;
        this.ws.send(JSON.stringify({
            type: 'route',
            action: 'add',
            inputId,
            outputId,
            channels: channels  // массив каналов [1,3] или null для всех
        }));
    }

    // Удалить маршрут
    removeRoute(inputId, outputId) {
        if (!this.ws) return;
        this.ws.send(JSON.stringify({
            type: 'route',
            action: 'remove',
            inputId,
            outputId
        }));
    }

    _updateStatus(connected) {
        const el = document.getElementById('connection-status');
        if (el) {
            el.className = `status-indicator ${connected ? 'connected' : 'disconnected'}`;
            el.textContent = connected ? '● Подключено' : '● Отключено';
        }
    }

    _notifyChange(type) {
        if (this.onStateChange) {
            this.onStateChange({ type, devices: [...this.devices.values()], routes: [...this.routes.entries()] });
        }
    }
}
