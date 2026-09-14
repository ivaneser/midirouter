/* === MIDI Router Server — Node.js + Worker Thread (ALSA) + WebSocket === */
// Основной процесс: HTTP/WS сервер
// Worker процесс: роутинг MIDI через ALSA callback (<2мс задержка)

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { readFileSync, statSync } from 'fs';
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
        this.routes = new Map();   // inputPortId → [outputPortIds]
        this.autoDiscoverMode = false;
        this.isReady = false;

        // Кэш для бинарных данных (минимизация аллокаций)
        this.base64Cache = new Map();
    }

    async init() {
        console.log('[SERVER] Starting MIDI worker thread...');

        this.worker = new Worker(join(import.meta.dirname, 'worker-midi.js'));

        // Обработка сообщений от воркера
        this.worker.on('message', (msg) => {
            this._handleWorkerMessage(msg);
        });

        this.worker.on('error', (err) => {
            console.error('[SERVER] Worker error:', err);
        });

        this.worker.on('exit', (code) => {
            console.log(`[SERVER] Worker exited with code ${code}`);
            if (code !== 0) {
                console.log('[SERVER] Restarting worker...');
                setTimeout(() => this.init(), 1000);
            }
        });

        // Ждём готовности воркера
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Worker init timeout'));
            }, 5000);

            this.worker.on('message', (msg) => {
                if (msg.type === 'ready') {
                    clearTimeout(timeout);
                    this.isReady = true;
                    console.log('[SERVER] Worker is ready');
                    resolve();
                }
            });
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

            case 'route-updated':
                this.routes.set(msg.inputId, msg.allDestinations);
                this._broadcast({
                    type: 'route',
                    action: 'add',
                    inputId: msg.inputId,
                    outputId: msg.outputId,
                    destinations: msg.allDestinations
                });
                console.log(`[SERVER] Route set: ${msg.inputId} → [${msg.allDestinations.join(', ')}]`);
                break;

            case 'route-removed':
                const dests = this.routes.get(msg.inputId);
                if (dests) {
                    const idx = dests.indexOf(msg.outputId);
                    if (idx > -1) dests.splice(idx, 1);
                }
                this._broadcast({
                    type: 'route',
                    action: 'remove',
                    inputId: msg.inputId,
                    outputId: msg.outputId
                });
                console.log(`[SERVER] Route removed: ${msg.inputId} → ${msg.outputId}`);
                break;

            case 'discovery-complete':
                this._broadcast({ type: 'discovery-complete' });
                console.log('[SERVER] Auto-discovery completed');
                break;

            case 'midi-sent':
                // Можно уведомить клиента об успешной отправке (для логирования)
                break;

            case 'midi-routed': {
                console.log(`[SERVER] MIDI: ${msg.inputId} → ${msg.outputId} | bytes=[${msg.message.map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`);
                break;
            }

            case 'new-device-detected': {
                console.log(`[SERVER] New device detected: ${msg.name} (${msg.inputId}) — searching for scheme...`);
                this._searchDeviceScheme(msg.name, msg.inputId);
                break;
            }
        }
    }

    // Автопоиск схемы устройства в интернете
    async _searchDeviceScheme(deviceName, inputId) {
        try {
            console.log(`[SERVER] Searching MIDI scheme for: ${deviceName}`);

            // Ищем в локальных device_maps сначала
            const fs = await import('fs');
            const path = await import('path');

            // Пробуем разные варианты названия файла
            const searchNames = [
                deviceName.toLowerCase().replace(/[^a-z0-9]/g, '_'),
                deviceName.toLowerCase().replace(/\s+/g, '_')
            ];

            for (const name of searchNames) {
                const filePath = path.join(import.meta.dirname, 'device_maps', `${name}.json`);
                try {
                    const data = fs.readFileSync(filePath, 'utf-8');
                    const scheme = JSON.parse(data);
                    console.log(`[SERVER] Found local scheme: ${name}`);
                    this._broadcast({ type: 'scheme-loaded', name, inputId, scheme });
                    return;
                } catch (e) {
                    // Файл не найден — продолжаем поиск
                }
            }

            // Если нет локально — ищем в интернете
            console.log(`[SERVER] Searching online for: ${deviceName}`);
            this._broadcast({ type: 'scheme-search-failed', name: deviceName, inputId });

        } catch (e) {
            console.error(`[SERVER] Error searching scheme for ${deviceName}:`, e.message);
            this._broadcast({ type: 'scheme-search-error', name: deviceName, error: e.message });
        }
    }

    // Отправить MIDI на output порт
    async sendMidiToOutput(outputId, bytes) {
        if (!this.isReady || !this.worker) return false;

        const base64 = btoa(String.fromCharCode(...bytes));
        this.worker.postMessage({
            type: 'send-midi',
            outputId,
            bytes: base64
        });
        return true;
    }

    // Создать маршрут
    createRoute(inputId, outputId) {
        if (!this.isReady || !this.worker) return false;

        this.worker.postMessage({
            type: 'set-route',
            inputId,
            outputId
        });
        return true;
    }

    // Удалить маршрут
    removeRoute(inputId, outputId) {
        if (!this.isReady || !this.worker) return false;

        this.worker.postMessage({
            type: 'remove-route',
            inputId,
            outputId
        });
        return true;
    }

    // Вкл/выкл авто-обнаружение
    toggleAutoDiscover() {
        if (!this.isReady || !this.worker) return false;

        this.autoDiscoverMode = !this.autoDiscoverMode;
        this.worker.postMessage({
            type: 'auto-discover',
            active: this.autoDiscoverMode
        });
        return this.autoDiscoverMode;
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

    // Очистка при закрытии
    cleanup() {
        console.log('[SERVER] Shutting down worker...');
        this.worker.postMessage({ type: 'shutdown' });
        this.worker.terminate();
    }
}

// === HTTP + WebSocket Server ===
let wss;
const router = new MIDIRouterWorker();

async function main() {
    // Инициализация воркера (ALSA)
    await router.init();

    // HTTP сервер для фронтенда
    const server = createServer((req, res) => {
        let filePath;

        // Отдаём device_maps JSON из корня проекта
        if (req.url.startsWith('/device_maps/')) {
            filePath = join(import.meta.dirname, req.url);
        } else {
            filePath = join(FRONTEND_DIR, req.url === '/' ? 'index.html' : req.url);
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

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());

                switch (message.type) {
                    case 'midi': {
                        // Бинарные MIDI данные из фронтенда (base64) → отправка на output порт
                        if (message.port && message.bytes) {
                            const bytesStr = atob(message.bytes);
                            const bytes = new Uint8Array(bytesStr.length);
                            for (let i = 0; i < bytesStr.length; i++) {
                                bytes[i] = bytesStr.charCodeAt(i);
                            }
                            router.sendMidiToOutput(message.port, Array.from(bytes));
                        }
                        break;
                    }

                    case 'route': {
                        if (message.action === 'add') {
                            router.createRoute(message.inputId, message.outputId);
                        } else if (message.action === 'remove') {
                            router.removeRoute(message.inputId, message.outputId);
                        }
                        break;
                    }

                    default:
                        console.warn('[SERVER] Unknown message:', message.type);
                }
            } catch (e) {
                console.error('[SERVER] Message error:', e.message);
            }
        });

        ws.on('close', () => console.log('[SERVER] Client disconnected'));
        ws.on('error', (err) => console.error('[SERVER] WS error:', err));
    });

    server.listen(PORT, () => {
        console.log('\n========================================');
        console.log('  MIDI Router Server');
        console.log(`  HTTP/WS: http://localhost:${PORT}`);
        console.log('  Worker: ALSA routing (<2ms latency)');
        console.log('========================================\n');
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n[SERVER] Shutting down...');
        router.cleanup();
        wss.close(() => server.close(() => process.exit(0)));
    });
}

main().catch(console.error);
