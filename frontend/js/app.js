/* === MIDI Router — auto-connect all to all === */

import { DeviceManager } from './device-manager.js?v=58';
import { DAWUI } from './daw-ui.js?v=55';
import { ConfigEditor } from './config-editor.js';
import { PianoRoll } from './piano-roll.js?v=46';
import { MidiKeyboard } from './midi-keyboard.js?v=55';
import { SectionOrder } from './section-order.js?v=1';

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

// Keep the clip launcher in reach on phones; timing remains one tap away.
const timingPanel = document.querySelector('.timing-details');
if (timingPanel) timingPanel.open = window.matchMedia('(min-width: 700px)').matches;


// Initialize managers
const deviceManager = new DeviceManager();
const pianoRoll = new PianoRoll();
const midiKeyboard = new MidiKeyboard(deviceManager);
const dawUI = new DAWUI(deviceManager);
dawUI.onClipSelect = (track, slot) => pianoRoll.selectClip(track, slot);
const configEditor = new ConfigEditor({
    deviceManager,
    ws: null, // will be set after connection
    log
});

// Draggable page sections; the router keeps their order between restarts.
const sectionOrder = new SectionOrder(document.getElementById('app'), order => send({ type: 'set-ui-layout', order }));

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
        midiKeyboard.syncRecordingInput();
        bestSyncRtt = Infinity;
        window.app.clockOffset = 0;
        for (let i = 0; i < 8; i++) setTimeout(syncClock, i * 120);
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
        // Saved sessions list (for the Load picker)
        send({ type: 'daw-list-sessions' });
    };

    ws.onclose = () => {
        midiKeyboard.releaseAll();
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
        midiKeyboard.releaseAll();
        ws.close();
    } else {
        connect();
    }
});

// === Shutdown ===
document.getElementById('btn-panic')?.addEventListener('click', () => {
    midiKeyboard.releaseAll();
    if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'midi-panic' }));
        log('Panic: releasing notes on all MIDI outputs.');
    }
});

const shutdownBtn = document.getElementById('btn-shutdown');
if (shutdownBtn) {
    shutdownBtn.addEventListener('click', () => {
        if (!confirm('Shut down the MIDI Router server? All clips and sessions will be lost.')) return;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'shut-down' }));
            log('Shutdown command sent — closing connection...');
            ws.close();
        }
    });
}

// === Server messages ===

// Clock offset to the router (router Date.now() − browser Date.now()). The sample with
// the smallest round trip is the most accurate, so only that one is kept.
let bestSyncRtt = Infinity;
function syncClock() {
    if (ws?.readyState === WebSocket.OPEN) send({ type: 'time-sync', t0: Date.now() });
}
function handleTimeSync(msg) {
    const t1 = Date.now();
    const rtt = t1 - msg.t0;
    if (!Number.isFinite(rtt) || rtt < 0 || rtt >= bestSyncRtt) return;
    bestSyncRtt = rtt;
    window.app.clockOffset = msg.ts - (msg.t0 + t1) / 2;
}
setInterval(() => { bestSyncRtt *= 1.5; syncClock(); }, 15000);

function handleMessage(msg) {
    if (msg.type === 'time-sync') return handleTimeSync(msg);
    if (msg.type === 'daw_state') pianoRoll.update(msg.payload);
    if (msg.type === 'daw_state' && msg.payload?.deviceControls) deviceManager.updateDeviceControls(msg.payload.deviceControls, msg.payload.deviceControlsRev);
    if (msg.type === 'daw_state' && msg.payload?.devicePresets) deviceManager.updateDevicePresets(msg.payload.devicePresets);
    if (msg.type === 'daw_progress') pianoRoll.updateProgress(msg.payload?.playing === false ? [] : msg.payload?.clipProgress || []);
    switch (msg.type) {
        case 'ui-layout':
            sectionOrder.apply(msg.order);
            break;
        case 'preset-name':
            deviceManager.updatePresetName(msg);
            break;
        case 'device-control':
            deviceManager.applyRemoteControl(msg);
            break;
        case 'device-channels':
            deviceManager.updateChannels(msg.channels || {});
            break;
        case 'device-channel-error':
            log('Could not save MIDI channel: ' + msg.message);
            break;
        case 'devices':
            deviceManager.updatePorts(msg.inputs || [], msg.outputs || []);
            midiKeyboard.updatePorts();
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
        case 'daw_session_list':
        case 'daw_session_error':
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
