/* === MIDI Router Server — Node.js + Worker Thread (ALSA) + WebSocket === */
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, extname } from 'path';
import { Worker } from 'worker_threads';

const PORT = 3000;
const FRONTEND_DIR = join(import.meta.dirname, 'frontend');

// === Worker Thread для MIDI роутинга ===
class MIDIRouterWorker {
    constructor() {
        this.worker = null;
        this.inputs = new Map();   // portId → name
        this.outputs = new Map();  // portId → name
        this.isReady = false;
    }

    async init() {
        console.log('[SERVER] Starting MIDI worker thread...');

        if (this.worker) {
            console.log('[SERVER] Terminating existing worker before restart');
            this.worker.postMessage({ type: 'shutdown' });
            await this.worker.terminate();
            this.isReady = false;
            
            if (this.worker._messageHandler) {
                this.worker.removeListener('message', this.worker._messageHandler);
            }
        }

        this.worker = new Worker(join(import.meta.dirname, 'worker-midi.js'));

        const handleMessage = (msg) => {
            this._handleWorkerMessage(msg);
        };
        this.worker.on('message', handleMessage);
        this.worker._messageHandler = handleMessage;

        this.worker.on('error', (err) => {
            console.error('[SERVER] Worker error:', err);
        });

        this.worker.on('exit', (code) => {
            console.log(`[SERVER] Worker exited with code ${code}`);
            if (this.worker && this.worker._messageHandler) {
                this.worker.removeListener('message', this.worker._messageHandler);
            }
            if (code !== 0) {
                console.log('[SERVER] Restarting worker...');
                setTimeout(() => this.init(), 1000);
            }
        });

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Worker init timeout'));
            }, 5000);

            const readyHandler = (msg) => {
                if (msg.type === 'ready') {
                    clearTimeout(timeout);
                    this.isReady = true;
                    console.log('[SERVER] Worker is ready');
                    this.worker.removeListener('message', readyHandler);
                    resolve();
                }
            };

            this.worker.on('message', readyHandler);
        });
    }

    _handleWorkerMessage(msg) {
        switch (msg.type) {
            case 'ports-enumerated':
                this.inputs.clear();
                this.outputs.clear();
                msg.inputs.forEach(i => this.inputs.set(i.id, i.name));
                msg.outputs.forEach(o => this.outputs.set(o.id, o.name));

                // Уведомляем клиентов о доступных портах
                this._broadcast({
                    type: 'devices',
                    inputs: [...this.inputs.entries()].map(([id, name]) => ({ id, name })),
                    outputs: [...this.outputs.entries()].map(([id, name]) => ({ id, name }))
                });

                console.log('[SERVER] Ports enumerated:', {
                    inputs: msg.inputs.length,
                    outputs: msg.outputs.length
                });
                break;

            case 'ready':
                console.log('[SERVER] Worker ready — auto-connect all to all');
                // Отправить panic note-off чтобы сбросить зажатые ноты
                if (this.worker) {
                    this.worker.postMessage({ type: 'panic_note_off' });
                }
                break;

            case 'config_reloaded':
                console.log('[SERVER] Config reloaded — mappings applied');
                this._broadcast({ type: 'config_reloaded' });
                break;

            case 'daw_midi':
                // DAW-события для визуализации (запись/проигрывание нот) в UI
                this._broadcast({ type: 'daw_event', payload: msg.data });
                break;

            case 'daw_state':
                this._broadcast({ type: 'daw_state', payload: msg.state });
                break;

            case 'daw_pad_map_list':
                // Обновление карты пэдов — перенаправляем во фронтенд
                this._broadcast({ type: 'daw_pad_map_list', map: msg.map, learnMode: msg.learnMode });
                break;

            case 'hotplug':
                // Пересборка маппингов при hot-plug событии
                if (this.worker) {
                    this.worker.postMessage({ type: 'rebuild_mappings' });
                }
                break;

            case 'hotplug-detected':
                // Уведомление о обнаружении нового устройства
                console.log('[SERVER] Hot-plug detected:', msg.deviceName);
                this._broadcast({
                    type: 'hotplug-notification',
                    deviceName: msg.deviceName,
                    action: msg.action
                });
                break;
        }
    }

    // Запросить состояние DAW у воркера (обещание резолвится на daw_state)
    _requestDawState() {
        return new Promise((resolve) => {
            const handler = (msg) => {
                if (msg.type === 'daw_state') {
                    this.worker.removeListener('message', handler);
                    resolve(msg.state);
                }
            };
            this.worker.on('message', handler);
            this.worker.postMessage({ type: 'daw_request_state' });
        });
    }

    _applyDawState(state) {
        this.worker.postMessage({ type: 'daw_apply_state', state });
    }

    // Получить список портов
    getPorts() {
        return {
            inputs: [...this.inputs.entries()].map(([id, name]) => ({ id, name })),
            outputs: [...this.outputs.entries()].map(([id, name]) => ({ id, name }))
        };
    }

    // Отправить сообщение всем WS клиентам
    _broadcast(message) {
        if (!wss || wss.clients.size === 0) return;

        const data = JSON.stringify(message);
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        });
    }

    // ---- DAW: сохранение/загрузка конфигурации на диск ----
    _configPath(name) {
        return join(import.meta.dirname, 'device_maps', `daw_${name}.json`);
    }

    async _saveConfig(name) {
        try {
            const path = this._configPath(name);
            const state = await this._requestDawState();
            await writeFileSync(path, JSON.stringify(state, null, 2));
            this._broadcastPresets();
            console.log(`[SERVER] DAW config saved -> ${name}`);
        } catch (e) {
            console.error('[SERVER] Save failed:', e.message);
        }
    }

    _listDawPresets() {
        const dir = join(import.meta.dirname, 'device_maps');
        let files = [];
        try { files = readdirSync(dir); } catch (e) {}
        return files.filter(f => f.startsWith('daw_') && f.endsWith('.json'))
            .map(f => f.replace(/^daw_/, '').replace(/\.json$/, ''));
    }

    _broadcastPresets() {
        this._broadcast({ type: 'daw-presets', names: this._listDawPresets() });
    }

    async _loadConfig(name) {
        try {
            const path = this._configPath(name);
            if (!existsSync(path)) {
                this._broadcast({ type: 'daw_error', message: `No preset '${name}'` });
                return;
            }
            const state = JSON.parse(readFileSync(path, 'utf8'));
            await this._applyDawState(state);
            console.log(`[SERVER] DAW config loaded <- ${name}`);
        } catch (e) {
            console.error('[SERVER] Load failed:', e.message);
        }
    }

    // Отправить сырое MIDI-сообщение на целевой выход
    _sendMidiToTarget(bytes, targetId) {
        if (!this.worker) {
            console.warn('[SERVER] Worker not available');
            return;
        }
        this.worker.postMessage({
            type: 'midi_send_to_target',
            bytes: bytes,
            target: targetId
        });
    }

    // Очистка при закрытии
    cleanup() {
        console.log('[SERVER] Shutting down worker...');
        if (this.worker) {
            // Отправить panic note-off перед выключением
            this.worker.postMessage({ type: 'panic_note_off' });
            this.worker.postMessage({ type: 'shutdown' });
            // Wait for worker to exit, then terminate if needed
            setTimeout(() => {
                if (this.worker && !this.worker.isTerminated && this.worker.exitCode === null) {
                    console.log('[SERVER] Worker did not exit gracefully — terminating');
                    this.worker.terminate();
                } else {
                    console.log('[SERVER] Worker exited cleanly');
                }
            }, 2000);
        }
    }
}

// === HTTP + WebSocket Server ===
let wss;
const router = new MIDIRouterWorker();

function startServer() {
    // HTTP сервер для фронтенда — без кэширования JS/CSS
    const server = createServer((req, res) => {
        // Strip query string (e.g. /css/style.css?v=3 → /css/style.css)
        const cleanUrl = req.url.split('?')[0];

        let filePath;

        if (cleanUrl.startsWith('/device_maps/')) {
            filePath = join(import.meta.dirname, cleanUrl);
        } else {
            filePath = join(FRONTEND_DIR, cleanUrl === '/' ? 'index.html' : cleanUrl);
        }

        const ext = extname(filePath);
        const mimeTypes = {
            '.html': 'text/html',
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.json': 'application/json'
        };

        try {
            const data = readFileSync(filePath);
            if (ext === '.js' || ext === '.css') {
                res.setHeader('Cache-Control', 'no-cache, no-store');
            }
            res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
            res.end(data);
        } catch (e) {
            res.writeHead(404);
            res.end('Not found');
        }
    });

    // WebSocket сервер
    wss = new WebSocketServer({ server });

    wss.on('connection', (ws, req) => {
        console.log('[SERVER] Client connected from', req.socket.remoteAddress);

        // Отправляем список портов при подключении
        ws.send(JSON.stringify({ type: 'devices', ...router.getPorts() }));

        ws.on('error', (err) => {
            console.error('[SERVER] WS error:', err.message);
        });

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());

                switch (message.type) {
                    case 'get-devices':
                        // Запрос устройств от клиента — ответим текущими
                        ws.send(JSON.stringify({ type: 'devices', ...router.getPorts() }));
                        break;

                    case 'daw-get':
                        // запросить текущее состояние DAW у воркера
                        router.worker.postMessage({ type: 'daw_request_state' });
                        // список доступных пресетов
                        router._broadcastPresets();
                        break;

                    case 'daw-set-tempo':
                        router.worker.postMessage({ type: 'daw_set_tempo', bpm: message.bpm });
                        break;

                    case 'daw-tap-tempo':
                        router.worker.postMessage({ type: 'daw_tap_tempo' });
                        break;

                    case 'daw-set-record-mode':
                        router.worker.postMessage({ type: 'daw_set_record_mode', mode: message.mode });
                        break;

                    case 'daw-set-slots':
                        router.worker.postMessage({ type: 'daw_set_slots', n: message.n });
                        break;

                    case 'daw-metronome-toggle':
                        router.worker.postMessage({ type: 'daw_metronome_toggle' });
                        break;

                    case 'daw-metronome-on':
                        router.worker.postMessage({ type: 'daw_metronome_on' });
                        break;

                    case 'daw-metronome-off':
                        router.worker.postMessage({ type: 'daw_metronome_off' });
                        break;

                    case 'daw-metronome-note':
                        router.worker.postMessage({ type: 'daw_metronome_note', note: message.note });
                        break;

                    case 'daw-metronome-beats-per-measure':
                        router.worker.postMessage({ type: 'daw_metronome_beats_per_measure', bpm: message.bpm });
                        break;

                    case 'daw-pad-learn':
                        router.worker.postMessage({ type: 'daw_pad_learn', on: !!message.on });
                        break;

                    case 'daw-pad-map':
                        // пользователь вручную мапит note -> (trackIdx, slot)
                        router.worker.postMessage({
                            type: 'daw_pad_map',
                            note: message.note,
                            trackIdx: message.trackIdx,
                            slot: message.slot,
                        });
                        break;

                    case 'daw-save':
                        router._saveConfig(message.name);
                        ws.send(JSON.stringify({ type: 'daw_saved', name: message.name }));
                        break;

                    case 'daw-pad-trigger':
                        // симуляция нажатия пада из веб-UI (для тестирования без контроллера)
                        router.worker.postMessage({ type: 'daw_pad_trigger', trackIdx: message.trackIdx, slot: message.slot });
                        break;

                    case 'daw-load':
                        router._loadConfig(message.name);
                        break;

                    // Transport controls
                    case 'daw-play':
                        router.worker.postMessage({ type: 'daw_start_transport' });
                        break;

                    case 'daw-stop':
                        router.worker.postMessage({ type: 'daw_stop_transport' });
                        break;

                    case 'daw-rec-arm-toggle':
                        // Toggle global record arm (used by Launchkey)
                        this._sendToAll({ type: 'daw_rec_arm_toggle' });
                        break;

                    // Track controls
                    case 'daw-track-arm':
                        router.worker.postMessage({ type: 'daw_arm_track', trackIdx: message.trackIdx });
                        break;

                    case 'daw-track-mute':
                        router.worker.postMessage({ type: 'daw_mute_track', trackIdx: message.trackIdx });
                        break;

                    case 'daw-track-solo':
                        router.worker.postMessage({ type: 'daw_solo_track', trackIdx: message.trackIdx });
                        break;

                    case 'midi-send':
                        // Отправить сырой MIDI-сообщение на указанный выход
                        if (message.data && message.target) {
                            const bytes = Array.isArray(message.data) ? message.data : (message.data.bytes || Array.from(message.data));
                            router._sendMidiToTarget(bytes, message.target);
                        }
                        break;

                    case 'reload-config':
                        // Перезагрузить конфигурацию из config.json
                        if (router.worker) {
                            router.worker.postMessage({ type: 'reload_config' });
                        }
                        break;

                    case 'get-config':
                        // Получить текущую конфигурацию
                        try {
                            const configPath = join(import.meta.dirname, 'config.json');
                            if (existsSync(configPath)) {
                                const config = JSON.parse(readFileSync(configPath, 'utf8'));
                                ws.send(JSON.stringify({ type: 'config', config }));
                            } else {
                                ws.send(JSON.stringify({ type: 'config', config: null }));
                            }
                        } catch (e) {
                            console.error('[SERVER] Get config error:', e.message);
                            ws.send(JSON.stringify({ type: 'config_error', message: e.message }));
                        }
                        break;

                    case 'save-config':
                        // Сохранить конфигурацию в config.json
                        try {
                            const configPath = join(import.meta.dirname, 'config.json');
                            writeFileSync(configPath, JSON.stringify(message.config, null, 2));
                            ws.send(JSON.stringify({ type: 'config_saved' }));
                            // Перезагрузить конфигурацию
                            if (router.worker) {
                                router.worker.postMessage({ type: 'reload_config' });
                            }
                        } catch (e) {
                            console.error('[SERVER] Save config error:', e.message);
                            ws.send(JSON.stringify({ type: 'config_error', message: e.message }));
                        }
                        break;

                    default:
                        console.warn('[SERVER] Unknown message:', message.type);
                }
            } catch (e) {
                console.error('[SERVER] Message error:', e.message);
            }
        });

        ws.on('close', (code, reason) => {
            console.log('[SERVER] Client disconnected:', code, reason.toString());
        });
    });

    server.listen(PORT, () => {
        console.log('\n========================================');
        console.log('  MIDI Router Server');
        console.log(`  HTTP/WS: http://localhost:${PORT}`);
        console.log('  Worker: ALSA routing (all→all)');
        console.log('========================================\n');
    });

    // Graceful shutdown
    let isShuttingDown = false;
    process.on('SIGINT', () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        console.log('\n[SERVER] Shutting down...');
        router.cleanup();
        
        // Force exit after 3 seconds if graceful close doesn't complete
        const forceExit = setTimeout(() => {
            console.log('[SERVER] Force exiting...');
            process.exit(1);
        }, 3000);
        forceExit.unref();
        
        wss.close(() => server.close(() => {
            clearTimeout(forceExit);
            console.log('[SERVER] All connections closed. Exiting.');
            process.exit(0);
        }));
    });
}

async function main() {
    // Start the HTTP/WS server FIRST so :3000 is always reachable, even if the
    // MIDI worker fails to initialise (e.g. ALSA /dev/snd issues in a sandbox).
    startServer();

    // Initialise the worker in the background — a failure must NOT take the web
    // server down. The worker's own 'exit' handler retries on crash.
    router.init().catch((e) => {
        console.error('[SERVER] Worker init failed (web UI still running):', e.message);
    });
}

main();
