import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { AudioCapture } from './audio-capture.js';
import { OPUS_RATE, qualityBitrate } from './audio-quality.js';

// The audio chain split over two threads. This (main) thread keeps what is cheap and must stay where the web
// server is: the arecord capture, the ring buffer for recordings and analysis, and the HTTP responses. The worker
// (audio-worker.js) does the costly part: the noise filter, the Opus encoder and the WebRTC peers. Raw chunks go
// to the worker only while something there listens; its results come back as messages.
//
// `ThreadedAudioCapture` and `ThreadedOpus` have the interface of AudioCapture and OpusBroadcast, so the HTTP code
// that serves listeners does not know the difference.
const RESTART_MS = 1000;

export class ThreadedOpus extends EventEmitter {
    constructor(hub, quality) {
        super();
        this.hub = hub;
        this.quality = quality;
        this.packing = 2;   // frames per network write (see PACKING_FRAMES)
        this.count = 0;
    }

    // Browsers listen over WebRTC, which is Opus only: a saved "pcm" (the old raw stream) now means Opus at 128 kbit/s.
    get encoded() { return qualityBitrate(this.quality) != null ? this.quality : 'opus-128'; }

    get available() {
        return [OPUS_RATE, 44100].includes(this.hub.sampleRate);
    }

    get bitrate() { return qualityBitrate(this.encoded); }

    setQuality(quality) {
        const was = this.quality;
        this.quality = quality;
        this.hub._send({ type: 'quality', quality: this.encoded });
        if (was !== quality) this.emit('quality', quality, was);
    }

    // Returns the unsubscribe function.
    subscribe(onPacket) {
        if (this.count++ === 0) this.hub._setOpus(true);
        this.on('packet', onPacket);
        return () => {
            this.off('packet', onPacket);
            if (--this.count <= 0) { this.count = 0; this.hub._setOpus(false); }
        };
    }

    // A WebRTC call, answered in the worker. Resolves with { sdp, close } like answerOffer().
    answerOffer(sdp, { onClose = () => {} } = {}) {
        return this.hub._offer(sdp, onClose);
    }
}

export class ThreadedAudioCapture extends AudioCapture {
    constructor(options = {}) {
        super(options);
        this.quality = options.quality || 'opus-96';
        this.worker = null;
        this.cleanOn = false;
        this.opusOn = false;
        this.calls = new Map();   // id -> { resolve, reject, onClose }
        this.nextCall = 1;
        this.threadWanted = true;
        this.opus = new ThreadedOpus(this, this.quality);
        this.opus.hub = this;
    }

    start() {
        super.start();
        this._spawn();
    }

    stop() {
        this.threadWanted = false;
        clearTimeout(this.respawnTimer);
        this.worker?.terminate();
        this.worker = null;
        super.stop();
    }

    // The cleaned stream is made in the worker: only chunks that someone there needs are sent.
    subscribeClean(onChunk) {
        this.cleanSubscribers++;
        this.on('clean', onChunk);
        this._setClean(true);
        return () => {
            this.off('clean', onChunk);
            if (--this.cleanSubscribers <= 0) { this.cleanSubscribers = 0; this._setClean(false); }
        };
    }

    _emitClean(chunk) {
        if (!this.worker || !this._needsChunks()) return;
        const copy = new Uint8Array(chunk);   // the ring keeps the original; the worker gets its own to take over
        this.worker.postMessage({ type: 'chunk', data: copy }, [copy.buffer]);
    }

    _needsChunks() { return this.cleanOn || this.opusOn || this.calls.size > 0; }

    setFilterLevel(level) {
        if (!['off', 'light', 'strong'].includes(level) || level === this.filterLevel) return;
        this.filterLevel = level;
        this._send({ type: 'filter', level });
        this.emit('status', this.status());
    }

    _send(message) { this.worker?.postMessage(message); }
    _setClean(on) { this.cleanOn = on; this._send({ type: 'clean', on }); }
    _setOpus(on) { this.opusOn = on; this._send({ type: 'opus', on }); }

    _offer(sdp, onClose) {
        if (!this.worker) return Promise.reject(new Error('The audio thread is not running'));
        const id = this.nextCall++;
        return new Promise((resolve, reject) => {
            this.calls.set(id, { resolve, reject, onClose });
            this.worker.postMessage({ type: 'offer', id, sdp });
        });
    }

    _spawn() {
        if (!this.threadWanted || this.worker) return;
        const worker = new Worker(new URL('./audio-worker.js', import.meta.url), {
            workerData: { sampleRate: this.sampleRate, channels: this.channels, filter: this.filterLevel, quality: this.opus.encoded },
        });
        this.worker = worker;
        worker.on('message', message => this._onWorkerMessage(worker, message));
        worker.on('error', error => console.error('[AUDIO] Audio thread error:', error.message));
        worker.on('exit', () => {
            if (this.worker !== worker) return;
            this.worker = null;
            // Every call dies with the thread; listeners that stay (HTTP) are resubscribed by the new one.
            for (const [id, call] of this.calls) { this.calls.delete(id); call.reject(new Error('The audio thread restarted')); call.onClose?.(); }
            if (!this.threadWanted) return;
            console.error(`[AUDIO] Audio thread stopped, restarting in ${RESTART_MS} ms`);
            this.respawnTimer = setTimeout(() => this._spawn(), RESTART_MS);
            this.respawnTimer.unref?.();
        });
        // State the new thread has to know about.
        if (this.cleanOn) worker.postMessage({ type: 'clean', on: true });
        if (this.opusOn) worker.postMessage({ type: 'opus', on: true });
    }

    _onWorkerMessage(worker, message) {
        if (worker !== this.worker) return;
        switch (message.type) {
            case 'clean':
                if (this.cleanSubscribers > 0) this.emit('clean', Buffer.from(message.data.buffer, message.data.byteOffset, message.data.byteLength));
                break;
            case 'opus':
                this.opus.emit('packet', Buffer.from(message.packet.buffer, message.packet.byteOffset, message.packet.byteLength));
                break;
            case 'answer': {
                const call = this.calls.get(message.id);
                if (!call) break;
                if (message.error) { this.calls.delete(message.id); call.reject(new Error(message.error)); break; }
                call.resolve({ sdp: message.sdp, close: () => this.worker?.postMessage({ type: 'hangup', id: message.id }) });
                break;
            }
            case 'closed': {
                const call = this.calls.get(message.id);
                if (call) { this.calls.delete(message.id); call.onClose?.(); }
                break;
            }
        }
    }
}

// The capture and its Opus stream, with the heavy half on its own thread.
export function createAudioThread(options = {}) {
    const capture = new ThreadedAudioCapture(options);
    return { capture, opus: capture.opus };
}
