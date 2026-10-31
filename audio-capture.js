import { spawn, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { NoiseFilter } from './audio-clean.js';

// Small ALSA periods keep the capture delay low (about 23 ms per period) for live listening.
const PERIOD_FRAMES = 1024;

// Instruments that show up as USB sound cards (many have no recording input, and a synth's passthrough
// codec makes arecord crash-loop): never the capture device.
const INSTRUMENT_CARDS = /blofeld|microfreak|craft|nts|preenfm|lpk|launchkey|nanopad|\bmk[23]?\b|\bkit\b|\bc20\b/i;

// The ALSA capture device for the attached audio interface, from `arecord -l`, which lists only the
// cards that can record: a "codec" interface first, then any card that is not an instrument.
export function pickCaptureDevice(arecordList) {
    const cards = [...String(arecordList).matchAll(/^card\s+\d+:\s+(\w+)\s+\[([^\]]*)\],\s+device\s+(\d+)/gim)]
        .map(([, short, description, device]) => ({ short, description, device }));
    const usable = cards.filter(c => !INSTRUMENT_CARDS.test(`${c.short} ${c.description}`) && !/^(headphones|vc4)/i.test(c.short));
    const found = usable.find(c => /codec/i.test(c.description)) || usable[0];
    return found ? `plughw:CARD=${found.short},DEV=${found.device}` : null;
}

// Owns the audio interface. Captures continuously with arecord into a rolling buffer; the browser
// listens to the live stream and mcpi (audio analysis and recording) gets its audio from here, so
// nothing else needs to open the device.
export class AudioCapture extends EventEmitter {
    constructor({
        device = process.env.MIDIROUTER_AUDIO_DEVICE,
        sampleRate = Number(process.env.MIDIROUTER_AUDIO_RATE) || 48000,   // 48 kHz: what Opus runs at, so no resampling
        channels = Number(process.env.MIDIROUTER_AUDIO_CHANNELS) === 1 ? 1 : 2,   // stereo, as the interface delivers it
        filter = process.env.MIDIROUTER_AUDIO_FILTER,   // noise reduction of the listened stream: off | light (default) | strong
        ringSeconds = 30,
        spawnProcess = spawn,
        readCards = () => execFileSync('arecord', ['-l'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }),
        retryMs = 3000,
        stallMs = 3000,
    } = {}) {
        super();
        this.configuredDevice = device || null;
        this.sampleRate = sampleRate;
        this.filterLevel = ['off', 'light', 'strong'].includes(filter) ? filter : 'light';
        this.cleanFilter = null;      // the one filter, alive while someone listens to the cleaned stream
        this.cleanSubscribers = 0;
        this.channels = channels;
        this.frameBytes = 2 * channels;   // 16-bit samples, one per channel
        this.maxBytes = Math.round(ringSeconds * sampleRate) * this.frameBytes;
        this.spawnProcess = spawnProcess;
        this.readCards = readCards;
        this.retryMs = retryMs;
        this.stallMs = stallMs;
        this.ring = [];
        this.ringBytes = 0;
        this.listeners_ = 0;
        this.state = 'stopped';   // stopped | no-device | waiting | live
        this.device = null;
        this.error = null;
        this.lastDataAt = 0;
        this.wanted = false;
        this.carry = null;
    }

    start() {
        if (this.wanted) return;
        this.wanted = true;
        this.watchdog = setInterval(() => this._checkStall(), 1000);
        this.watchdog.unref?.();
        this._open();
    }

    stop() {
        this.wanted = false;
        clearInterval(this.watchdog);
        clearTimeout(this.retryTimer);
        this.proc?.kill('SIGTERM');
        this.proc = null;
        this.state = 'stopped';
    }

    status() {
        return { state: this.state, device: this.device, sampleRate: this.sampleRate, channels: this.channels, filter: this.filterLevel, error: this.error, listeners: this.listeners_ };
    }

    // The most recent `seconds` of audio as little-endian 16-bit PCM, channels interleaved (less when not that much was captured).
    snapshot(seconds) {
        const wanted = Math.min(this.ringBytes, Math.max(0, Math.round(seconds * this.sampleRate)) * this.frameBytes);
        if (wanted === 0) return Buffer.alloc(0);
        return Buffer.concat(this.ring).subarray(this.ringBytes - wanted);
    }

    // The cleaned stream: the incoming audio through one noise filter, shared by every listener (the cost does not
    // grow with their number). The filter exists while at least one listener uses it. Returns the unsubscribe function.
    subscribeClean(onChunk) {
        if (!this.cleanFilter && this.filterLevel !== 'off') this.cleanFilter = this._newFilter();
        this.cleanSubscribers++;
        this.on('clean', onChunk);
        return () => {
            this.off('clean', onChunk);
            if (--this.cleanSubscribers <= 0) { this.cleanSubscribers = 0; this.cleanFilter = null; }   // forget the noise it had learnt
        };
    }

    _newFilter() {
        return new NoiseFilter({ level: this.filterLevel, sampleRate: this.sampleRate, channels: this.channels });
    }

    // Switch the noise filter while listeners are connected: they carry on without reconnecting (with the
    // filter off they simply get the raw audio). The new filter starts learning the noise from scratch.
    setFilterLevel(level) {
        if (!['off', 'light', 'strong'].includes(level) || level === this.filterLevel) return;
        this.filterLevel = level;
        this.cleanFilter = this.cleanSubscribers > 0 && level !== 'off' ? this._newFilter() : null;
        this.emit('status', this.status());
    }

    _retry() {
        if (!this.wanted) return;
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this._open(), this.retryMs);
        this.retryTimer.unref?.();
    }

    _open() {
        if (!this.wanted || this.proc) return;
        let device = this.configuredDevice;
        if (!device) {
            try { device = pickCaptureDevice(this.readCards()); } catch { device = null; }
        }
        if (!device) {
            this.state = 'no-device';
            this.device = null;
            this.error = 'no USB audio interface found';
            this._retry();
            return;
        }
        this.device = device;
        this.state = 'waiting';
        this.carry = null;
        let proc;
        try {
            proc = this.spawnProcess('arecord', ['-t', 'raw', '-f', 'S16_LE', '-r', String(this.sampleRate), '-c', String(this.channels), '-D', device, `--period-size=${PERIOD_FRAMES}`, `--buffer-size=${PERIOD_FRAMES * 4}`], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
            this.state = 'no-device';
            this.error = error.message;
            this._retry();
            return;
        }
        this.proc = proc;
        this.lastDataAt = Date.now();
        let stderr = '';
        proc.stderr?.on('data', data => { stderr = (stderr + data).slice(-300); });
        proc.stdout.on('data', data => this._onData(data));
        proc.on('error', error => {   // arecord missing
            if (this.proc !== proc) return;
            this.proc = null;
            this.state = 'no-device';
            this.error = `arecord: ${error.message}`;
            this._retry();
        });
        proc.on('close', () => {
            if (this.proc !== proc) return;
            this.proc = null;
            this.state = 'waiting';
            this.error = stderr.trim().split('\n').pop() || 'capture stopped';
            this.emit('status', this.status());
            this._retry();
        });
    }

    _checkStall() {
        if (this.proc && Date.now() - this.lastDataAt > this.stallMs) {
            this.error = 'capture stalled';
            this.proc.kill('SIGKILL');   // the close handler reopens it
        }
    }

    _onData(data) {
        this.lastDataAt = Date.now();
        if (this.state !== 'live') {
            this.state = 'live';
            this.error = null;
            this.emit('status', this.status());
        }
        let chunk = this.carry ? Buffer.concat([this.carry, data]) : data;
        this.carry = null;
        const partial = chunk.length % this.frameBytes;   // keep whole frames (one sample per channel)
        if (partial) {
            this.carry = chunk.subarray(chunk.length - partial);
            chunk = chunk.subarray(0, chunk.length - partial);
        }
        if (!chunk.length) return;
        this.ring.push(chunk);
        this.ringBytes += chunk.length;
        while (this.ringBytes - this.ring[0].length >= this.maxBytes) this.ringBytes -= this.ring.shift().length;
        this.emit('chunk', chunk);
        if (this.cleanSubscribers > 0) {
            const cleaned = this.cleanFilter ? this.cleanFilter.process(chunk) : chunk;   // no filter: the audio as it is
            if (cleaned.length) this.emit('clean', cleaned);
        }
    }
}

// GET /audio/live[?raw=1][&backfill=seconds]: PCM (S16_LE, channels interleaved; rate in X-Sample-Rate, channel count in X-Channels). Optionally starts
// with the last `backfill` seconds, then follows the capture live. A client that cannot keep up
// loses chunks instead of slowing the capture.
export function serveLiveAudio(capture, req, res, opus = null) {
    const status = capture.status();
    if (status.state !== 'live') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: status.error || `audio capture ${status.state}`, state: status.state }));
        return;
    }
    const params = new URL(req.url, 'http://x').searchParams;
    // By default the stream is the noise-filtered capture. ?raw=1 is the untouched capture (what analysis needs;
    // only it can start with ?backfill=seconds of recent audio).
    const raw = params.get('raw') === '1';
    const backfill = raw ? Math.max(0, Math.min(Number(params.get('backfill')) || 0, capture.maxBytes / capture.frameBytes / capture.sampleRate)) : 0;
    const send = chunk => { if (res.writableLength < 262144) res.write(chunk); };
    // ?codec=opus asks for the Opus stream (the browser can decode it); the server's stream quality decides whether it is used.
    const useOpus = !raw && params.get('codec') === 'opus' && opus?.available;
    res.writeHead(200, {
        'Content-Type': useOpus ? 'application/octet-stream' : 'audio/L16',
        'X-Codec': useOpus ? 'opus' : 'pcm',
        ...(useOpus ? { 'X-Bitrate': String(opus.bitrate) } : {}),
        'X-Sample-Rate': String(useOpus ? 48000 : capture.sampleRate),   // Opus is always 48 kHz (a 44.1 kHz capture is resampled)
        'X-Channels': String(capture.channels),
        'X-Filter': raw ? 'off' : capture.filterLevel,   // as it was when this listener connected
        'Cache-Control': 'no-store',
    });
    res.flushHeaders();   // the player starts as soon as it has the headers, not with the first chunk
    res.socket?.setNoDelay(true);   // send every chunk at once: no waiting to fill a packet
    if (backfill > 0) send(capture.snapshot(backfill));
    let unsubscribe;
    if (useOpus) {
        // Opus listeners get the packets as they are encoded; a change to or from raw PCM ends the stream so the player reconnects.
        const offPackets = opus.subscribe(send);
        const onQuality = () => { if (!opus.available) res.end(); };
        opus.on('quality', onQuality);
        unsubscribe = () => { offPackets(); opus.off('quality', onQuality); };
    } else if (raw) { capture.on('chunk', send); unsubscribe = () => capture.off('chunk', send); }
    else {
        unsubscribe = capture.subscribeClean(send);
        // A switch to Opus ends a raw PCM stream so the player reconnects with the new format.
        if (opus && params.get('codec') === 'opus') {
            const onQuality = () => { if (opus.available) res.end(); };
            opus.on('quality', onQuality);
            const off = unsubscribe;
            unsubscribe = () => { off(); opus.off('quality', onQuality); };
        }
    }
    capture.listeners_++;
    res.once('close', () => {
        unsubscribe();
        capture.listeners_ = Math.max(0, capture.listeners_ - 1);
    });
}
