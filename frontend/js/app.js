/* === App — точка входа, связывающая DeviceManager и ControllerUI === */

class App {
    constructor() {
        this.dm = new DeviceManager();
        this.ui = null;  // Инициализируется после загрузки DOM
        this.connectedDevicePorts = new Map();  // deviceId → portId
    }

    async init() {
        // Задержка чтобы DOM точно был готов
        await new Promise(r => setTimeout(r, 100));

        this.ui = new ControllerUI(this.dm);
        this.portManager = new PortManager(this.dm);  // ← новый менеджер портов

        // Настройка обработчика изменений состояния
        this.dm.onStateChange = (state) => {
            console.log('State change:', state.type);
            if (state.type === 'devices') {
                this._updateDeviceList(state.devices);

                // Разделяем на inputs и outputs для PortManager
                const inputs = state.devices.filter(d => d.id.startsWith('input_'));
                const outputs = state.devices.filter(d => d.id.startsWith('output_'));
                if (this.portManager) {
                    this.portManager.updatePorts(inputs, outputs);
                }
            } else if (state.type === 'routes') {
                // Обновляем визуальное состояние маршрутов
                if (this.portManager) {
                    // Перерендерим всё — routes обновляются через серверные сообщения
                    this.portManager._render();
                }
            }
        };

        // Обработчик входящих MIDI сообщений
        this.dm.onMidiMessage = (bytes, sourcePort) => {
            console.log(`MIDI from ${sourcePort}:`, bytes);
            // Здесь можно добавить логику маршрутизации/лупинга
            this._logToPanel(`MIDI ← ${this._portName(sourcePort)}: ${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
        };

        // Обработка suggested-route от worker (Learning Mode)
        this.dm.onSuggestedRoute = (data) => {
            console.log('[App] Suggested route:', data);
            if (this.portManager) {
                this.portManager.showSuggestedRoute(data);
            }
        };

        // Обработка кнопки подключения
        const btn = document.getElementById('btn-connect');
        if (btn) {
            btn.addEventListener('click', () => this._handleConnect());
        }

        // Toggle Learning Mode — показываем только после подключения
        const toggleEl = document.getElementById('auto-discover-toggle');
        if (toggleEl) {
            toggleEl.addEventListener('change', () => {
                console.log('[App] Toggling auto-discover:', toggleEl.checked);
                this.dm.autoDiscoverMode = toggleEl.checked;
                if (this.dm.ws && this.dm.ws.readyState === WebSocket.OPEN) {
                    this.dm.ws.send(JSON.stringify({
                        type: 'auto-discover',
                        active: toggleEl.checked
                    }));
                } else {
                    alert('Сначала подключитесь к серверу');
                    toggleEl.checked = false;
                }
            });
        }

        // Кнопки модала подтверждения маршрута
        const btnAccept = document.getElementById('btn-accept-route');
        if (btnAccept && this.portManager) {
            btnAccept.addEventListener('click', () => {
                // Предлагаем первый доступный output порт
                if (this.portManager.outputs.length > 0) {
                    const outputId = this.portManager.outputs[0].id;
                    console.log('[App] Accepting route to:', outputId);
                    this.portManager.acceptSuggestedRoute(outputId);
                } else {
                    alert('Нет доступных выходных портов');
                }
            });
        }

        const btnReject = document.getElementById('btn-reject-route');
        if (btnReject) {
            btnReject.addEventListener('click', () => {
                this.portManager.rejectSuggestedRoute();
            });
        }

        // Загрузка устройства из JSON файлов
        await this.ui.loadDevices();

        console.log('App initialized');
    }

    async _handleConnect() {
        const urlInput = document.getElementById('ws-url');
        if (!urlInput || !this.dm) return;

        const url = urlInput.value.trim();
        try {
            await this.dm.connect(url);
            console.log('Connected to MIDI Router at', url);

            // После подключения получаем список доступных портов
            this._logToPanel(`Подключено к ${url}`);

            // Показываем Learning Mode toggle
            const autoDiscoverBar = document.querySelector('.auto-discover-bar');
            if (autoDiscoverBar) autoDiscoverBar.style.display = 'flex';

            // Запрашиваем список устройств
            if (this.dm.ws?.readyState === WebSocket.OPEN) {
                this.dm.ws.send(JSON.stringify({ type: 'request_devices' }));
            }
        } catch (e) {
            console.error('Connection failed:', e);
            alert(`Не удалось подключиться: ${e.message}`);
        }
    }

    _updateDeviceList(devices) {
        // Обновляем отображение физических MIDI-портов
        const countEl = document.getElementById('device-count');
        if (countEl) {
            countEl.textContent = `${devices.length} устройств`;
        }

        devices.forEach(device => {
            console.log('Device:', device.id, device.name);
            // Сохраняем привязку portId для отправки MIDI
            this.connectedDevicePorts.set(device.id, device.portId);

            // Обновляем portId в UI контроллеров устройства
            this._updateDevicePortId(device);
        });
    }

    _updateDevicePortId(device) {
        // Находим карточку устройства по имени и обновляем portId
        const cards = document.querySelectorAll('.device-card');
        for (const card of cards) {
            const h2 = card.querySelector('h2');
            if (h2 && h2.textContent.includes(device.name)) {
                card.dataset.portId = device.portId;
                // Обновляем portId в контроллерах устройства
                this._setCardPortId(card, device.portId);
            }
        }
    }

    _setCardPortId(card, portId) {
        const sliders = card.querySelectorAll('.control-slider');
        sliders.forEach(slider => {
            slider.dataset.portId = portId;
        });
    }

    _portName(portId) {
        // Форматируем имя порта для отображения
        return portId.replace(/_/g, ' ');
    }

    _logToPanel(message) {
        const logs = document.getElementById('logs');
        if (!logs) return;

        const entry = document.createElement('div');
        const time = new Date().toLocaleTimeString();
        entry.textContent = `[${time}] ${message}`;
        logs.prepend(entry);

        // Ограничиваем количество логов
        while (logs.children.length > 100) {
            logs.removeChild(logs.lastChild);
        }
    }
}

// Запуск приложения когда DOM готов
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    window.app = app;  // Для отладки в консоли
    app.init().catch(console.error);
});
