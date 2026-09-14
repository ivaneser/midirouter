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
            this._logToPanel(`MIDI ← ${this._portName(sourcePort)}: ${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
        };

        // Обработка событий схемы устройства от сервера
        this.dm.onSchemeEvent = (event) => {
            console.log(`[APP] Scheme event: ${event.type}`, event);
            switch (event.type) {
                case 'scheme-loaded':
                    if (this.ui && event.scheme) {
                        this.ui.renderDynamicControls(event.name, event.inputId, event.scheme);
                        this._logToPanel(`✅ Схема загружена для: ${event.name}`);
                    }
                    break;

                case 'scheme-search-failed':
                    console.warn(`[APP] Scheme not found for: ${event.name}`);
                    // Создаём пустую карточку с подсказкой
                    if (this.ui) {
                        this._createUnknownDeviceCard(event.name, event.inputId);
                    }
                    break;

                case 'scheme-search-error':
                    console.error(`[APP] Scheme search error:`, event.error);
                    this._logToPanel(`❌ Ошибка поиска схемы для: ${event.name}`);
                    break;
            }
        };

        // Обработка кнопки подключения
        const btn = document.getElementById('btn-connect');
        if (btn) {
            btn.addEventListener('click', () => this._handleConnect());
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

    _createUnknownDeviceCard(name, inputId) {
        const container = document.getElementById('devices-container');
        if (!container) return;

        console.log(`[APP] Creating unknown device card: ${name}`);

        // Создаём карточку с подсказкой
        const card = document.createElement('div');
        card.className = 'device-card';

        const header = document.createElement('div');
        header.className = 'card-header';
        header.innerHTML = `
            <h2>${name}</h2>
            <span class="arrow">▶</span>
        `;

        const body = document.createElement('div');
        body.className = 'device-body';

        // Создаём секцию с подсказкой
        const hintSection = document.createElement('div');
        hintSection.style.padding = '20px';
        hintSection.style.textAlign = 'center';
        hintSection.style.color = '#999';
        hintSection.innerHTML = `
            <p>Схема для этого устройства не найдена.</p>
            <p style="font-size: 14px;">Пожалуйста, создайте JSON файл в папке device_maps/</p>
            <code style="background: #333; padding: 4px 8px; border-radius: 4px;">${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}.json</code>
        `;

        body.appendChild(hintSection);
        card.appendChild(header);
        card.appendChild(body);

        container.appendChild(card);

        // Обновляем счётчик устройств
        const countEl = document.getElementById('device-count');
        if (countEl) {
            countEl.textContent = `${container.children.length} устройств`;
        }
    }
}

// Запуск приложения когда DOM готов
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    window.app = app;  // Для отладки в консоли
    app.init().catch(console.error);
});
