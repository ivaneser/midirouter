/**
 * MetronomeController — spawns and controls the Python audio metronome
 * (metronome.py) via stdin/stdout IPC.
 *
 * The Python metronome plays actual audio clicks through `aplay -M` to the
 * 3.5mm headphone jack. This controller sends start/stop/bpm commands to it.
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class MetronomeController {
    constructor(options = {}) {
        this.bpm = options.bpm || 120;
        this.beats = options.beats || 4;
        this.volume = options.volume || 0.8;
        this.pythonPath = options.pythonPath || 'python3';
        this.metronomeScript = path.resolve(
            __dirname,
            options.metronomeScript || 'metronome.py'
        );

        this._process = null;
        this._running = false;
        this._pid = null;
        this._lineBuffer = '';
        this._listeners = {
            status: [],
            error: [],
            output: []
        };

        // Check if aplay is available
        this._audioAvailable = this._checkAudio();
    }

    _checkAudio() {
        try {
            fs.accessSync('/dev/snd', fs.constants.R_OK);
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Start the Python metronome process.
     * @returns {Promise<boolean>} - success status
     */
    start() {
        return new Promise((resolve, reject) => {
            if (this._process) {
                resolve(true);
                return;
            }

            // Check for aplay first
            const aplayExists = this._checkAplay();
            if (!aplayExists) {
                console.warn('[METRONOME] aplay not found. Install alsa-utils.');
                reject(new Error('aplay not found'));
                return;
            }

            this._process = spawn(this.pythonPath, [this.metronomeScript,
                '-B', String(this.bpm),
                '-b', String(this.beats),
                '-v', String(this.volume)
            ], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }
            });

            this._pid = this._process.pid;
            console.log(`[METRONOME] Started Python metronome (PID: ${this._pid})`);

            let stdoutReady = false;
            let stderrLines = [];

            this._process.stdout.on('data', (data) => {
                const str = data.toString();
                for (const line of str.split('\n')) {
                    if (line.trim()) {
                        this._handleLine(line);
                    }
                }
            });

            this._process.stderr.on('data', (data) => {
                const str = data.toString();
                stderrLines.push(str.trim());
                if (stderrLines.length > 10) stderrLines.shift();
                console.warn(`[METRONOME] stderr: ${stderrLines.join(' ')}`);
            });

            this._process.on('error', (err) => {
                console.error(`[METRONOME] Process error: ${err.message}`);
                this._process = null;
                this._running = false;
                this._pid = null;
                reject(err);
            });

            this._process.on('close', (code, signal) => {
                console.log(`[METRONOME] Process exited with code ${code}, signal ${signal}`);
                this._process = null;
                this._running = false;
                this._pid = null;
                // Emit error event for reconnection
                this._emit('error', new Error(`Process exited: ${code}/${signal}`));
            });

            // Give it a moment to initialize
            setTimeout(() => {
                if (this._process && this._pid) {
                    this._running = true;
                    resolve(true);
                } else {
                    reject(new Error('Failed to start metronome'));
                }
            }, 1000);
        });
    }

    /**
     * Stop the Python metronome process.
     * @returns {Promise<boolean>} - success status
     */
    stop() {
        return new Promise((resolve) => {
            if (!this._process || !this._pid) {
                this._running = false;
                resolve(true);
                return;
            }

            // Send 'stop' command via stdin (process now stays alive, just goes silent)
            try {
                this._process.stdin.write('stop\n');
                this._running = false;
                setTimeout(() => resolve(true), 50);
            } catch (e) {
                console.warn(`[METRONOME] Failed to send stop command: ${e.message}`);
                resolve(false);
            }
        });
    }

    /**
     * Send a start command to the Python metronome.
     * @returns {Promise<boolean>} - success status
     */
    play() {
        return new Promise((resolve) => {
            if (!this._process || !this._pid) {
                this.start().then(() => resolve(true)).catch(() => resolve(false));
                return;
            }

            try {
                this._process.stdin.write('start\n');
                setTimeout(() => resolve(true), 100);
            } catch (e) {
                console.warn(`[METRONOME] Failed to send start command: ${e.message}`);
                resolve(false);
            }
        });
    }

    /**
     * Set the BPM.
     * @param {number} bpm - Beats per minute (20-300)
     * @returns {Promise<boolean>} - success status
     */
    setBpm(bpm) {
        return new Promise((resolve) => {
            if (!this._process || !this._pid) {
                this.bpm = bpm;
                resolve(false);
                return;
            }

            const clampedBpm = Math.max(20, Math.min(300, bpm));
            try {
                this._process.stdin.write(`bpm ${clampedBpm}\n`);
                this.bpm = clampedBpm;
                setTimeout(() => resolve(true), 100);
            } catch (e) {
                console.warn(`[METRONOME] Failed to send BPM command: ${e.message}`);
                resolve(false);
            }
        });
    }

    /**
     * Set the beats per measure.
     * @param {number} beats - Beats per measure (1-16)
     * @returns {Promise<boolean>} - success status
     */
    setBeats(beats) {
        return new Promise((resolve) => {
            if (!this._process || !this._pid) {
                this.beats = beats;
                resolve(false);
                return;
            }

            const clampedBeats = Math.max(1, Math.min(16, beats));
            try {
                this._process.stdin.write(`beats ${clampedBeats}\n`);
                this.beats = clampedBeats;
                setTimeout(() => resolve(true), 100);
            } catch (e) {
                console.warn(`[METRONOME] Failed to send beats command: ${e.message}`);
                resolve(false);
            }
        });
    }

    /**
     * Get the current status of the Python metronome.
     * @returns {Promise<Object|null>} - Status object or null if not running
     */
    getStatus() {
        return new Promise((resolve) => {
            if (!this._process || !this._pid) {
                resolve(null);
                return;
            }

            try {
                this._process.stdin.write('status\n');
                // The response will come via stdout, handled by _handleLine
                setTimeout(() => resolve(this._lastStatus), 500);
            } catch (e) {
                console.warn(`[METRONOME] Failed to get status: ${e.message}`);
                resolve(null);
            }
        });
    }

    _handleLine(line) {
        // Parse "[metronome] ..." prefixed lines and raw JSON status responses
        let prefix = '';
        let content = line;

        if (line.startsWith('[metronome]')) {
            const match = line.match(/^\[metronome\]\s*(.*)/);
            if (match) {
                prefix = 'info';
                content = match[1];
            }
        } else if (line.startsWith('{') && line.endsWith('}')) {
            // JSON status response
            try {
                const status = JSON.parse(line);
                this._lastStatus = status;
                this._emit('status', status);
            } catch (e) {
                // Not JSON, treat as regular output
            }
        }

        if (prefix || line.includes('{')) return;

        // Other output lines
        this._emit('output', line);
    }

    _checkAplay() {
        try {
            fs.accessSync('/usr/bin/aplay', fs.constants.X_OK);
            return true;
        } catch (e) {
            // Try PATH lookup
            const paths = (process.env.PATH || '').split(':');
            for (const p of paths) {
                try {
                    fs.accessSync(path.join(p, 'aplay'), fs.constants.X_OK);
                    return true;
                } catch (e2) { /* not found in this path */ }
            }
            return false;
        }
    }

    _emit(event, data) {
        const listeners = this._listeners[event];
        if (listeners) {
            for (const fn of listeners) {
                try {
                    fn(data);
                } catch (e) {
                    console.error(`[METRONOME] Error in ${event} listener: ${e.message}`);
                }
            }
        }
    }

    on(event, fn) {
        if (this._listeners[event]) {
            this._listeners[event].push(fn);
        }
    }

    off(event, fn) {
        if (this._listeners[event]) {
            const idx = this._listeners[event].indexOf(fn);
            if (idx !== -1) {
                this._listeners[event].splice(idx, 1);
            }
        }
    }

    /**
     * Kill the process and clean up.
     */
    kill() {
        if (this._process && this._pid) {
            try {
                this._process.stdin.end();
                this._process.kill('SIGTERM');
            } catch (e) {
                // Process already dead
            }
            this._process = null;
            this._running = false;
            this._pid = null;
        }
    }

    isRunning() {
        return this._running && !!this._process && !!this._pid;
    }
}
