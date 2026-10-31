// Listens to the router's audio interface: GET /audio/live is raw 16-bit PCM (stereo, interleaved), played as it
// arrives through Web Audio with a small buffer (about 120 ms) to ride out network jitter.
const TARGET_AHEAD = 0.12;   // seconds of audio kept queued (the start value of the automatic buffer)
const MIN_AHEAD = 0.08, MAX_CUSHION = 0.5;   // the automatic buffer stays between these
const CALM_MS = 20000;       // this long without a dropout and the automatic buffer shrinks a little
const MAX_LAG = 0.4;         // lagging this far beyond the cushion: drop chunks to catch up
const RETRY_MS = 2000;

// Little-endian 16-bit samples from a byte chunk of interleaved channels: one Float32Array per channel.
// A trailing partial frame comes back in `rest` (a Uint8Array, or null) to start the next chunk.
export function pcmToFloat(bytes, carry = null, channels = 1) {
    let data = bytes;
    if (carry && carry.length) {
        data = new Uint8Array(carry.length + bytes.length);
        data.set(carry, 0);
        data.set(bytes, carry.length);
    }
    const frameBytes = 2 * channels;
    const frames = Math.floor(data.length / frameBytes);
    const out = Array.from({ length: channels }, () => new Float32Array(frames));
    let peak = 0;
    for (let i = 0; i < frames; i++) {
        for (let c = 0; c < channels; c++) {
            const at = i * frameBytes + c * 2;
            let value = data[at] | (data[at + 1] << 8);
            if (value >= 0x8000) value -= 0x10000;
            const sample = value / 32768;
            out[c][i] = sample;
            const magnitude = Math.abs(sample);
            if (magnitude > peak) peak = magnitude;
        }
    }
    const used = frames * frameBytes;
    return { channels: out, samples: out[0], peak, rest: used < data.length ? data.slice(used) : null };
}

// Volume slider position 0..1 -> gain: 0..1 up to the middle (unchanged sound), then up to x16 (+24 dB)
// for a quiet input.
export function sliderToGain(position) {
    const p = Math.max(0, Math.min(1, position));
    return p <= 0.5 ? p * 2 : 1 + (p - 0.5) * 2 * 15;
}

// One second of silence as a WAV file, played in a loop to put iOS into its "media" audio mode, where the
// ring/silent switch no longer mutes Web Audio.
function silentWavUrl() {
    const rate = 8000, samples = rate, bytes = new Uint8Array(44 + samples);
    const view = new DataView(bytes.buffer);
    const text = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, 36 + samples, true); text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
    text(36, 'data'); view.setUint32(40, samples, true);
    bytes.fill(128, 44);   // 8-bit PCM silence
    return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}

export class AudioListener {
    constructor(button, { log = () => {}, analyser = false, retry = false, onState = () => {}, mediaSession = false } = {}) {
        this.button = button;
        this.log = log;
        this.wantAnalyser = analyser;
        this.retry = retry;
        this.onState = onState;
        this.mediaSession = mediaSession;
        this.volume = 1;
        this.cushion = TARGET_AHEAD;
        this.autoBuffer = true;
        this.analyser = null;
        this.active = false;
        this.level = 0;
        this.button?.addEventListener('click', () => (this.active ? this.stop() : this.start()));
        this._render();
    }

    async start() {
        if (this.active) return;
        this.active = true;
        this.error = null;
        this._render();
        this.onState('connecting', null);
        try {
            if (this.mediaSession) this._playAsMedia();
            // Created synchronously so it happens inside the tap that started the playback.
            this.context ||= new AudioContext({ latencyHint: 'interactive' });
            this._ensureOutput();
            await this.context.resume();
        } catch (error) {
            this.error = error.message;
            this.log(`Audio: ${error.message}`);
            this.stop();
            return;
        }
        while (this.active) {
            this.controller = new AbortController();
            try {
                await this._stream();
                if (this.active) this.log('Audio stream ended');
            } catch (error) {
                if (error.name !== 'AbortError') {
                    this.error = error.message;
                    this.log(`Audio: ${error.message}`);
                }
            }
            if (this._fallback && this.active) { this._fallback = false; continue; }
            if (!this.active || !this.retry) break;
            this.level = 0;
            this.onState('reconnecting', this.error);
            await new Promise(resolve => setTimeout(resolve, RETRY_MS));
        }
        this.stop();
    }

    stop() {
        const wasActive = this.active;
        this.controller?.abort();
        this.controller = null;
        this.active = false;
        this.level = 0;
        this.silent?.pause();
        this._render();
        if (wasActive) this.onState('stopped', this.error);
    }

    // 'auto' (grows after a dropout, shrinks when the connection is calm) or a fixed number of milliseconds.
    setBuffer(mode) {
        const ms = Number(mode);
        this.autoBuffer = !(ms > 0);
        this.cushion = this.autoBuffer ? TARGET_AHEAD : Math.min(MAX_CUSHION, Math.max(0.04, ms / 1000));
    }

    // Opus needs the browser's AudioDecoder; without it, or after it failed once, the raw stream is used.
    _canOpus() {
        return !this.rawOnly && typeof AudioDecoder !== 'undefined' && typeof EncodedAudioChunk !== 'undefined';
    }

    async _stream() {
        const response = await fetch(this._canOpus() ? '/audio/live?codec=opus' : '/audio/live', { signal: this.controller.signal, cache: 'no-store' });
        if (!response.ok) {
            const reason = (await response.json().catch(() => ({}))).error || `HTTP ${response.status}`;
            throw new Error(reason);
        }
        const rate = Number(response.headers.get('X-Sample-Rate')) || 44100;
        this.channels = Math.max(1, Math.min(2, Number(response.headers.get('X-Channels')) || 1));
        this.next = 0;
        this.error = null;
        const reader = response.body.getReader();
        this._animate();
        if (response.headers.get('X-Codec') === 'opus') await this._readOpus(reader, rate);
        else await this._readPcm(reader, rate);
    }

    async _readOpus(reader, rate) {
        let failed = null;
        const decoder = new AudioDecoder({
            output: data => {
                try {
                    const frames = data.numberOfFrames;
                    const channels = Array.from({ length: data.numberOfChannels }, (_, plane) => {
                        const samples = new Float32Array(frames);
                        data.copyTo(samples, { planeIndex: plane, format: 'f32-planar' });
                        return samples;
                    });
                    let peak = 0;
                    for (const sample of channels[0]) peak = Math.max(peak, Math.abs(sample));
                    this.level = Math.max(peak, this.level * 0.85);
                    this._play(channels, rate);
                } finally { data.close(); }
            },
            error: error => { failed = error; this.controller?.abort(); },
        });
        decoder.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: this.channels });
        let buffer = new Uint8Array(0), stamp = 0, first = true;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (first) { first = false; this.onState('live', null); }
                const joined = new Uint8Array(buffer.length + value.length);
                joined.set(buffer, 0);
                joined.set(value, buffer.length);
                let at = 0;
                while (joined.length - at >= 2) {
                    const size = (joined[at] << 8) | joined[at + 1];
                    if (joined.length - at - 2 < size) break;
                    if (decoder.decodeQueueSize < 20) {   // a stalled decoder drops packets instead of piling them up
                        decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: stamp, data: joined.subarray(at + 2, at + 2 + size) }));
                    }
                    stamp += 20000;
                    at += 2 + size;
                }
                buffer = joined.slice(at);
            }
        } catch (error) {
            if (failed) {   // the browser cannot decode this: carry on with the raw stream
                this.log(`Opus: ${failed.message}, using raw audio`);
                this.rawOnly = true;
                this._fallback = true;
                return;
            }
            throw error;
        } finally {
            try { decoder.close(); } catch { /* already closed */ }
        }
    }

    async _readPcm(reader, rate) {
        let carry = null;
        let first = true;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (first) {
                first = false;
                this.onState('live', null);
            }
            const chunk = pcmToFloat(value, carry, this.channels);
            carry = chunk.rest;
            this.level = Math.max(chunk.peak, this.level * 0.85);
            if (chunk.samples.length) this._play(chunk.channels, rate);
        }
    }

    _ensureOutput() {
        if (this.wantAnalyser && !this.analyser) {
            const context = this.context;
            this.analyser = context.createAnalyser();
            this.analyser.fftSize = 1024;
            this.analyser.smoothingTimeConstant = 0.6;
            // Quiet sound should show: the range the pictures use is -85..-25 dBFS.
            this.analyser.minDecibels = -85;
            this.analyser.maxDecibels = -25;
            // The picture follows the sound as it arrives; the volume control and limiter come after it.
            this.gainNode = context.createGain();
            this.gainNode.gain.value = this.volume;
            const limiter = context.createDynamicsCompressor();
            limiter.threshold.value = -6;
            limiter.knee.value = 3;
            limiter.ratio.value = 20;
            limiter.attack.value = 0.003;
            limiter.release.value = 0.15;
            this.limiter = limiter;
            this._setLimiter(this.volume > 1);
            // Left and right analysed on their own (they only listen: their output is muted).
            const splitter = context.createChannelSplitter(2);
            const mute = context.createGain();
            mute.gain.value = 0;
            mute.connect(context.destination);
            this.sides = [0, 1].map(channel => {
                const side = context.createAnalyser();
                side.fftSize = this.analyser.fftSize;
                side.smoothingTimeConstant = this.analyser.smoothingTimeConstant;
                side.minDecibels = this.analyser.minDecibels;
                side.maxDecibels = this.analyser.maxDecibels;
                splitter.connect(side, channel);
                side.connect(mute);
                return side;
            });
            this.analyser.connect(splitter);
            this.analyser.connect(this.gainNode);
            this.gainNode.connect(limiter);
            limiter.connect(context.destination);
        }
        this.output = this.analyser || this.context.destination;
    }

    // [left, right] analysers of a stereo stream, or null for a mono one (the picture then uses the mix).
    stereoAnalysers() {
        return this.channels === 2 && this.sides ? this.sides : null;
    }

    // gain: 1 = the sound as it is; more boosts a quiet input.
    setVolume(gain) {
        this.volume = gain;
        if (this.gainNode) this.gainNode.gain.setTargetAtTime(gain, this.context.currentTime, 0.02);
        this._setLimiter(gain > 1);
    }

    // The limiter only acts when the sound is boosted; at or below normal volume it is neutral (ratio 1),
    // so the audio plays as it arrives.
    _setLimiter(on) {
        if (!this.limiter) return;
        this.limiter.threshold.value = on ? -6 : 0;
        this.limiter.ratio.value = on ? 20 : 1;
    }

    _playAsMedia() {
        try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* not supported */ }
        try {
            this.silent ||= Object.assign(new Audio(silentWavUrl()), { loop: true });
            this.silent.setAttribute('playsinline', '');
            this.silent.play().catch(() => {});
        } catch { /* the sound still plays, only the silent switch may mute it */ }
    }

    _play(channels, rate) {
        const context = this.context;
        const buffer = context.createBuffer(channels.length, channels[0].length, rate);
        channels.forEach((samples, index) => buffer.copyToChannel(samples, index));
        const now = context.currentTime;
        if (this.next < now + 0.02) {   // first chunk, or an underrun: queue a fresh cushion
            if (this.next > 0 && this.autoBuffer) {   // a dropout: the automatic buffer grows
                this.cushion = Math.min(MAX_CUSHION, this.cushion * 1.5);
                this.lastDropout = performance.now();
            }
            this.next = now + this.cushion;
        } else if (this.autoBuffer && this.cushion > MIN_AHEAD && performance.now() - (this.lastDropout ?? (this.lastDropout = performance.now())) > CALM_MS) {
            this.cushion = Math.max(MIN_AHEAD, this.cushion * 0.9);   // calm for a while: a little less delay
            this.lastDropout = performance.now();
        }
        if (this.next - now > this.cushion + MAX_LAG) return;          // too far behind: skip this chunk
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.output);
        source.start(this.next);
        this.next += buffer.duration;
    }

    _animate() {
        if (!this.button || this._animating) return;
        this._animating = true;
        const frame = () => {
            if (!this.active) { this._animating = false; return; }
            this.button.style.setProperty('--level', String(Math.min(1, this.level)));
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    }

    _render() {
        if (!this.button) return;
        this.button.classList.toggle('active', this.active);
        this.button.setAttribute('aria-pressed', String(this.active));
        this.button.textContent = this.active ? '■ Listening' : '🔊 Listen';
        if (!this.active) {
            this.button.style.setProperty('--level', '0');
            this.button.title = this.error ? `Audio unavailable: ${this.error}` : 'Hear the audio interface live';
        } else {
            this.button.title = 'Stop listening';
        }
    }
}
