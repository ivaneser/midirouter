/* === MIDI Router — auto-connect all to all === */

import { DeviceManager } from './device-manager.js';
import { DAWUI } from './daw-ui.js';
import { ConfigEditor } from './config-editor.js';

// Auto-detect WebSocket URL from current page location
(function autoDetectWsUrl() {
    const wsUrlInput = document.getElementById('ws-url');
    })();

// Auto-detect WebSocket URL from page location
function getWsUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}`;
}

const connectBtn = document.getElementById('btn-connect');
const statusEl = document.getElementById('connection-status');
const logsDiv = document.getElementById('logs');

let ws = null;

// Initialize managers
const deviceManager = new DeviceManager();
const dawUI = new DAWUI(deviceManager);
const configEditor = new ConfigEditor({
    deviceManager,
    ws: null, // will be set after connection
    log
});

// Global references for other modules
window.app = {
    deviceManager,
    dawUI,
    configEditor,
    ws: null,
    log
};

// === WebSocket ===

function connect() {
    const url = getWsUrl();

    log('Connecting to ' + url + '...');
    statusEl.textContent = '● Connecting...';
    statusEl.className = 'status-indicator disconnected';

    ws = new WebSocket(url);
    window.app.ws = ws;

    ws.onopen = () => {
        statusEl.textContent = '● Connected';
        statusEl.className = 'status-indicator connected';
        connectBtn.textContent = 'Disconnect';
        log('Connected');
        
        // Request devices after connecting
        send({ type: 'get-devices' });
        // Request configuration
        send({ type: 'get-config' });
        // Request DAW state (clips, grid) — must be AFTER WS connection
        send({ type: 'daw-get' });
    };

    ws.onclose = () => {
        statusEl.textContent = '● Disconnected';
        statusEl.className = 'status-indicator disconnected';
        connectBtn.textContent = 'Connect';
        log('Disconnected');
        window.app.ws = null;
    };

    ws.onerror = () => {
        log('WS error — check URL and that server is running');
        statusEl.textContent = '● Error';
        statusEl.className = 'status-indicator disconnected';
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleMessage(msg);
        } catch (e) {
            log('Parse error: ' + e.message);
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
            // Refresh the clock source dropdown so hot-plugged inputs appear.
            dawUI.refreshClockSourceSelect();
            log(`Devices: ${msg.inputs?.length || 0} input, ${msg.outputs?.length || 0} output`);
            break;

        case 'daw_state':
        case 'daw_pad_map_list':
        case 'daw-presets':
        case 'daw_event':
        case 'daw_progress':
        case 'daw_visual_event':
            dawUI.handleMessage(msg);
            break;

        case 'config':
            if (msg.config) {
                configEditor.loadConfig(msg.config);
                log('📋 Configuration loaded');
            }
            break;

        case 'config_saved':
            configEditor.handleConfigSaved();
            break;

        case 'config_reloaded':
            log('✅ Configuration applied — routes active');
            break;

        case 'config_error':
            log('Configuration error: ' + msg.message);
            break;

        case 'hotplug-notification':
            // Re-fetch full device list so the Devices panel stays in sync
            send({ type: 'get-devices' });
            if (configEditor && configEditor._handleHotplugEvent) {
                configEditor._handleHotplug(msg);
            }
            log(`🔌 ${msg.deviceName} (${msg.direction}) — ${msg.action === 'added' ? 'connected' : 'disconnected'}`);
            break;

        default:
            log('Message: ' + msg.type);
    }
}

// === Render devices ===

function renderDevices() {
    deviceManager.render();
}

// === Send to server ===

function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

// === Logs ===

function log(msg) {
    if (!logsDiv) return;
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.textContent = '[' + time + '] ' + msg;
    logsDiv.appendChild(entry);
    logsDiv.scrollTop = logsDiv.scrollHeight;
}
