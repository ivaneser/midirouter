/* === MIDI Router Server — Node.js + Worker Thread (ALSA) + WebSocket === */
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, extname } from 'path';
import { Worker } from 'worker_threads';
import { getCaptivePortalRedirect } from './wifi-ap/captive-portal.js';

const PORT = Number(process.env.PORT) || 3000;
const FRONTEND_DIR = join(import.meta.dirname, 'frontend');

// === Worker thread for MIDI routing ===
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

                // Notify clients about the available ports
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
                // Send panic note-off to release held notes
                if (this.worker) {
                    this.worker.postMessage({ type: 'panic_note_off' });
                }
                break;

            case 'config_reloaded':
                console.log('[SERVER] Config reloaded — mappings applied');
                this._broadcast({ type: 'config_reloaded' });
                break;

            case 'daw_midi':
                // DAW events for visualization (recording/playing notes) in the UI
                this._broadcast({ type: 'daw_event', payload: msg.data });
                break;

            case 'daw_state':
                this._broadcast({ type: 'daw_state', payload: msg.state });
                break;

            case 'daw_progress':
                this._broadcast({ type: 'daw_progress', payload: msg.payload });
                break;

            case 'daw_visual_event':
                this._broadcast({ type: 'daw_visual_event', event: msg.event });
                break;

            case 'daw_session_list':
            case 'daw_session_error':
                this._broadcast({
                    type: msg.type,
                    sessions: msg.sessions,
                    recent: msg.recent,
                    name: msg.name,
                    error: msg.error,
                });
                break;

            case 'daw_pad_map_list':
                // Pad map update — forward to the frontend
                this._broadcast({ type: 'daw_pad_map_list', map: msg.map, learnMode: msg.learnMode });
                break;

            case 'hotplug':
                // Rebuild mappings on a hot-plug event
                if (this.worker) {
                    this.worker.postMessage({ type: 'rebuild_mappings' });
                }
                break;

            case 'hotplug-detected':
                // Notify about a newly detected device
                console.log('[SERVER] Hot-plug detected:', msg.deviceName);
                this._broadcast({
                    type: 'hotplug-notification',
                    deviceName: msg.deviceName,
                    action: msg.action
                });
                break;
        }
    }

    // Request the DAW state from the worker (promise resolves on daw_state)
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

    // Get the list of ports
    getPorts() {
        return {
            inputs: [...this.inputs.entries()].map(([id, name]) => ({ id, name })),
            outputs: [...this.outputs.entries()].map(([id, name]) => ({ id, name }))
        };
    }

    // Send a message to all WS clients
    _broadcast(message) {
        if (!wss || wss.clients.size === 0) return;

        const data = JSON.stringify(message);
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        });
    }

    // ---- DAW: save/load configuration to disk ----
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

    // Send a raw MIDI message to the target output
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

    // Cleanup on close
    cleanup() {
        console.log('[SERVER] Shutting down worker...');
        if (this.worker) {
            // Send panic note-off before shutting down
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
    // HTTP server for the frontend — no caching of JS/CSS
    const server = createServer((req, res) => {
        const captivePortalRedirect = getCaptivePortalRedirect({
            host: req.headers.host,
            remoteAddress: req.socket.remoteAddress
        });
        if (captivePortalRedirect) {
            res.writeHead(captivePortalRedirect.statusCode, {
                Location: captivePortalRedirect.location
            });
            res.end();
            return;
        }

        // Strip query string (e.g. /css/style.css?v=3 → /css/style.css)
        const cleanUrl = req.url.split('?')[0];

        // Captive portal: OS connectivity probes hit arbitrary paths (via the
        // AP's DNS hijack + iptables port-80 redirect). Serve the UI for them
        // so the browser opens the web interface right after WiFi connect.
        const captivePortalPaths = new Set([
            '/captive.apple.com', '/apple.com', '/hotspot-detect.html',
            '/generate_204', '/generictest', '/ncsi.txt', '/__ping',
            '/connectivitycheck', '/connectivitycheck.gstatic.com',
            '/root/login-portal.html', '/safari',
        ]);

        let filePath;

        if (cleanUrl.startsWith('/device_maps/')) {
            filePath = join(import.meta.dirname, cleanUrl);
        } else if (captivePortalPaths.has(cleanUrl)) {
            filePath = join(FRONTEND_DIR, 'index.html');
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
            // Unknown path without a file extension in the REQUESTED URL →
            // serve the UI (SPA / captive portal fallback) so any redirected
            // probe URL still opens the app. Probe paths like
            // /captive.apple.com end in ".com" but are not real assets.
            if (!cleanUrl.startsWith('/device_maps/') && extname(cleanUrl) === '') {
                const data = readFileSync(join(FRONTEND_DIR, 'index.html'));
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(data);
                return;
            }
            res.writeHead(404);
            res.end('Not found');
        }
    });

    // WebSocket server
    wss = new WebSocketServer({ server });

    wss.on('connection', (ws, req) => {
        console.log('[SERVER] Client connected from', req.socket.remoteAddress);

        // Send the port list on connection
        ws.send(JSON.stringify({ type: 'devices', ...router.getPorts() }));

        ws.on('error', (err) => {
            console.error('[SERVER] WS error:', err.message);
        });

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());

                switch (message.type) {
                    case 'get-devices':
                        // Device request from the client — reply with the current ones
                        ws.send(JSON.stringify({ type: 'devices', ...router.getPorts() }));
                        break;

                    case 'daw-get':
                        // request the current DAW state from the worker
                        router.worker.postMessage({ type: 'daw_request_state' });
                        // list of available presets
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

                    case 'daw-set-master-loop-bars':
                        router.worker.postMessage({ type: 'daw_set_master_loop_bars', bars: message.bars });
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

                    // Audio latency offset (ms) for clip playback.
                    case 'daw-audio-offset':
                        router.worker.postMessage({ type: 'daw_audio_offset', ms: message.ms });
                        break;

                    // Click latency compensation (ms) for the audio metronome.
                    case 'daw-click-offset':
                        router.worker.postMessage({ type: 'daw_click_offset', ms: message.ms });
                        break;

                    // Quantization grid (beats) for recorded notes.
                    case 'daw-quantize-grid':
                        router.worker.postMessage({ type: 'daw_quantize_grid', beats: message.beats });
                        break;

                    // ---- MIDI Clock (MTC) ----
                    case 'daw-midi-clock-toggle':
                        router.worker.postMessage({ type: 'daw_midi_clock_toggle' });
                        break;

                    case 'daw-midi-clock-on':
                        router.worker.postMessage({ type: 'daw_midi_clock_on' });
                        break;

                    case 'daw-midi-clock-off':
                        router.worker.postMessage({ type: 'daw_midi_clock_off' });
                        break;

                    // ---- Clock master selection (MIDI Clock source) ----
                    case 'clock-source-select':
                        router.worker.postMessage({
                            type: 'clock_source_select',
                            kind: message.kind,       // 'internal' | 'external'
                            portName: message.portName,
                        });
                        break;

                    case 'clock-source-explicit-exclusions':
                        router.worker.postMessage({
                            type: 'clock_source_explicit_exclusions',
                            exclusions: message.exclusions || [],
                        });
                        break;

                    case 'daw-pad-learn':
                        router.worker.postMessage({ type: 'daw_pad_learn', on: !!message.on });
                        break;

                    case 'daw-pad-map':
                        // the user maps a note -> (trackIdx, slot) manually
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
                        // simulate a pad press from the web UI (for testing without a controller)
                        router.worker.postMessage({ type: 'daw_pad_trigger', trackIdx: message.trackIdx, slot: message.slot });
                        break;

                    case 'daw-load':
                        router._loadConfig(message.name);
                        break;

                    // Sessions: save/load recordings (DAW clips) to/from disk
                    case 'daw-save-session':
                        router.worker.postMessage({ type: 'daw_save_session', name: message.name });
                        break;

                    case 'daw-load-session':
                        router.worker.postMessage({ type: 'daw_load_session', name: message.name });
                        break;

                    case 'daw-delete-session':
                        router.worker.postMessage({ type: 'daw_delete_session', name: message.name });
                        break;

                    case 'daw-list-sessions':
                        router.worker.postMessage({ type: 'daw_list_sessions' });
                        break;

                    // Transport controls
                    case 'daw-play':
                        router.worker.postMessage({ type: 'daw_start_transport' });
                        break;

                    // Rec from stopped state: two-bar count-in, then the
                    // master loop runs (recording starts on pad press).
                    case 'daw-start-with-countin':
                        router.worker.postMessage({ type: 'daw_start_with_countin' });
                        break;

                    case 'daw-stop':
                        router.worker.postMessage({ type: 'daw_stop_transport' });
                        break;

                    case 'daw-rec-arm-toggle':
                        // Reset: clear all clips to zero and return Mode = Play
                        // — a new recording from scratch.
                        router.worker.postMessage({ type: 'daw_reset_arm_record' });
                        this._sendToAll({ type: 'daw_rec_arm_toggle' });
                        break;

                    // Track controls
                    case 'daw-clear-clip':
                        // long-press on a recorded pad: erase that clip only
                        router.worker.postMessage({ type: 'daw_clear_clip', trackIdx: message.trackIdx, slot: message.slot });
                        break;

                    case 'daw-track-arm':
                        router.worker.postMessage({ type: 'daw_arm_track', trackIdx: message.trackIdx });
                        break;

                    case 'daw-track-mute':
                        router.worker.postMessage({ type: 'daw_mute_track', trackIdx: message.trackIdx });
                        break;

                    case 'daw-track-solo':
                        router.worker.postMessage({ type: 'daw_solo_track', trackIdx: message.trackIdx });
                        break;

                    case 'daw-add-clip':
                        router.worker.postMessage({ type: 'daw_add_clip', trackIdx: message.trackIdx });
                        break;

                    case 'daw-add-track':
                        router.worker.postMessage({ type: 'daw_add_track' });
                        break;

                    case 'midi-send':
                        // Send a raw MIDI message to the specified output
                        if (message.data && message.target) {
                            const bytes = Array.isArray(message.data) ? message.data : (message.data.bytes || Array.from(message.data));
                            router._sendMidiToTarget(bytes, message.target);
                        }
                        break;

                    case 'reload-config':
                        // Reload the configuration from config.json
                        if (router.worker) {
                            router.worker.postMessage({ type: 'reload_config' });
                        }
                        break;

                    case 'get-config':
                        // Get the current configuration
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
                        // Save the configuration to config.json
                        try {
                            const configPath = join(import.meta.dirname, 'config.json');
                            writeFileSync(configPath, JSON.stringify(message.config, null, 2));
                            ws.send(JSON.stringify({ type: 'config_saved' }));
                            // Reload the configuration
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

    server.listen(PORT, '0.0.0.0', () => {
        console.log('\n========================================');
        console.log('  MIDI Router Server');
        console.log(`  HTTP/WS: http://localhost:${PORT}`);
        console.log('  Worker: ALSA routing (all→all)');
        console.log('========================================\n');
    });

    // Graceful shutdown
    let isShuttingDown = false;
    const SHUTDOWN_TIMEOUT_MS = 3000;

    /** Close every active WebSocket client, then destroy the server. */
    function closeClients() {
        if (!wss) return Promise.resolve();
        return new Promise(resolve => {
            const clients = wss.clients && [...wss.clients];
            if (clients.length === 0) {
                resolve();
                return;
            }
            let remaining = clients.length;
            const done = () => {
                if (--remaining === 0) resolve();
            };
            for (const client of clients) {
                const onClientClose = () => {
                    done();
                };
                // Register the 'close' listener *before* calling `client.close()`
                // so a client that closes synchronously never misses the event.
                client.once('close', onClientClose);

                // Guard against a client that never emits 'close'.
                let fallbackTimer = setTimeout(() => {
                    client.removeListener('close', onClientClose);
                    client.terminate();
                    done();
                }, SHUTDOWN_TIMEOUT_MS);

                client.on('close', () => {
                    clearTimeout(fallbackTimer);
                });

                // `close` is safe to call repeatedly and idempotent.
                try { client.close(1001, 'server shutdown'); } catch (_) {}
            }
        });
    }

    process.on('SIGINT', async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        console.log('\n[SERVER] Shutting down...');
        router.cleanup();

        // Wait for clients to close, then fall back to a bounded force-exit.
        try {
            await Promise.race([
                closeClients(),
                new Promise(resolve => {
                    setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT_MS);
                })
            ]);
        } catch (err) {
            console.error('[SERVER] Error closing clients:', err.message);
        }

        // If the server socket is still holding the process open, force it.
        if (server && server.listening) {
            try { await server.closeAsync(); } catch (_) {
                server.close();
            }
        }
        console.log('[SERVER] Exiting.');
        process.exit(0);
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
