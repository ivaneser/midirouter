/* === MIDI Router — авто-соединение всех со всеми === */

import { DeviceManager } from './device-manager.js';
import { DAWUI } from './daw-ui.js';
import { ConfigEditor } from './config-editor.js';

// Auto-detect WebSocket URL from current page location
(function autoDetectWsUrl() {
    const wsUrlInput = document.getElementById('ws-url');
    if (!wsUrlInput) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrlInput.value = `${protocol}//${location.host}`;
})();

const wsUrlInput = document.getElementById('ws-url');
const connectBtn = document.getElementById('btn-connect');
const statusEl = document.getElementById('connection-status');
const logsDiv = document.getElementById('logs');

let ws = null;

// Инициализация менеджеров
const deviceManager = new DeviceManager();
const dawUI = new DAWUI(deviceManager);
const configEditor = new ConfigEditor({
    deviceManager,
    ws: null // будет установлен после подключения
});

// Глобальные ссылки для других модулей
window.app = {
    deviceManager,
    dawUI,
    configEditor,
    ws: null
};

// === WebSocket ===

function connect() {
    const url = wsUrlInput.value.trim();
    if (!url) return;

    log('Подключение к ' + url + '...');
    statusEl.textContent = '● Подключение...';
    statusEl.className = 'status-indicator disconnected';

    ws = new WebSocket(url);
    window.app.ws = ws;

    ws.onopen = () => {
        statusEl.textContent = '● Подключено';
        statusEl.className = 'status-indicator connected';
        connectBtn.textContent = 'Отключиться';
        log('Подключено');
        
        // Запросить устройства после подключения
        send({ type: 'get-devices' });
        // Запросить конфигурацию
        send({ type: 'get-config' });
    };

    ws.onclose = () => {
        statusEl.textContent = '● Отключено';
        statusEl.className = 'status-indicator disconnected';
        connectBtn.textContent = 'Подключиться';
        log('Отключено');
        window.app.ws = null;
    };

    ws.onerror = () => {
        log('WS ошибка — проверьте URL и что сервер запущен');
        statusEl.textContent = '● Ошибка';
        statusEl.className = 'status-indicator disconnected';
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleMessage(msg);
        } catch (e) {
            log('Ошибка парсинга: ' + e.message);
        }
    };
}

connectBtn.addEventListener('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
    } else {
        connect();
    }
});

// === Сообщения сервера ===

function handleMessage(msg) {
    switch (msg.type) {
        case 'devices':
            deviceManager.updatePorts(msg.inputs || [], msg.outputs || []);
            log(`Устройства: ${msg.inputs?.length || 0} input, ${msg.outputs?.length || 0} output`);
            break;

        case 'daw_state':
        case 'daw_pad_map_list':
        case 'daw-presets':
        case 'daw_event':
            dawUI.handleMessage(msg);
            break;

        case 'config':
            if (msg.config) {
                configEditor.loadConfig(msg.config);
            }
            break;

        case 'config_saved':
            configEditor.handleConfigSaved();
            break;

        case 'config_error':
            log('Ошибка конфигурации: ' + msg.message);
            break;

        case 'hotplug-notification':
            if (configEditor && configEditor._handleHotplugEvent) {
                configEditor._handleHotplug(msg);
            }
            log(`🔌 ${msg.deviceName} (${msg.direction}) — ${msg.action === 'added' ? 'подключено' : 'отключено'}`);
            break;

        default:
            log('Сообщение: ' + msg.type);
    }
}

// === Рендер устройств ===

function renderDevices() {
    deviceManager.render();
}

// === Отправка на сервер ===

function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

// === Логи ===

function log(msg) {
    if (!logsDiv) return;
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.textContent = '[' + time + '] ' + msg;
    logsDiv.appendChild(entry);
    logsDiv.scrollTop = logsDiv.scrollHeight;
}
