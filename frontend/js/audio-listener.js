// Listens to the router's audio over WebRTC: the browser's own receiver (NetEQ) orders the packets by their RTP
// timestamps, hides lost ones, and keeps a jitter buffer that follows the sender's clock, so Wi-Fi hiccups and clock
// drift do not click. The buffer is large on purpose (default 500 ms): this is for listening, not for playing live.
const DEFAULT_BUFFER_MS = 500;   // the "Auto" buffer
const MAX_BUFFER_MS = 4000;      // what the receiver accepts
const RETRY_MS = 2000;

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
        this.bufferMs = DEFAULT_BUFFER_MS;
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

    // 'auto' (500 ms) or a fixed number of milliseconds. A running call picks it up at once.
    setBuffer(mode) {
        const ms = Number(mode);
        this.bufferMs = ms > 0 ? Math.min(MAX_BUFFER_MS, ms) : DEFAULT_BUFFER_MS;
        this._applyBuffer();
    }

    // How long the receiver holds audio back. Chrome calls it jitterBufferTarget (ms), older versions playoutDelayHint (s);
    // a browser with neither keeps its own adaptive buffer.
    _applyBuffer() {
        const receiver = this.receiver;
        if (!receiver) return;
        try { receiver.jitterBufferTarget = this.bufferMs; } catch { /* not supported */ }
        try { if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = this.bufferMs / 1000; } catch { /* not supported */ }
    }

    _canWebRtc() {
        return typeof RTCPeerConnection !== 'undefined' && typeof fetch === 'function';
    }

    async _stream() {
        if (!this._canWebRtc()) throw new Error('this browser has no WebRTC');
        await this._streamWebRtc();
    }

    // The router answers the offer with its ICE candidates already in it, so no trickle exchange is needed.
    async _streamWebRtc() {
        const signal = this.controller.signal;
        const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
        this.webrtcLive = false;
        const pc = new RTCPeerConnection({ iceServers: [] });
        let tap = null, meter = null, sink = null;
        const cleanup = () => {
            this.receiver = null;
            clearInterval(meter);
            try { sink?.pause(); sink.srcObject = null; } catch { /* nothing to stop */ }
            try { tap?.disconnect(); } catch { /* already disconnected */ }
            pc.close();
        };
        try {
            const transceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
            const stream = new Promise(resolve => { pc.ontrack = event => resolve(event.streams[0] || new MediaStream([event.track])); });
            // Chrome plays Opus as mono unless the offer asks for stereo.
            const offer = await pc.createOffer();
            await pc.setLocalDescription({ type: 'offer', sdp: offer.sdp.replace(/^(a=fmtp:(\d+) [^\r\n]*)/gm, (line, _all, type) => (new RegExp(`a=rtpmap:${type} opus/`).test(offer.sdp) && !/stereo=1/.test(line) ? `${line};stereo=1;sprop-stereo=1` : line)) });
            await new Promise(resolve => {
                if (pc.iceGatheringState === 'complete') return resolve();
                pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') resolve(); };
                setTimeout(resolve, 1000);
            });
            const response = await fetch('/audio/webrtc', {
                method: 'POST', signal, cache: 'no-store', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sdp: pc.localDescription.sdp }),
            });
            const answer = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(answer.error || `HTTP ${response.status}`);
            }
            await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
            this.channels = Math.max(1, Math.min(2, Number(answer.channels) || 2));
            const connected = new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('no connection (is UDP blocked?)')), 6000);
                const check = () => {
                    if (pc.connectionState === 'connected') { clearTimeout(timer); resolve(); }
                    else if (pc.connectionState === 'failed') { clearTimeout(timer); reject(new Error('connection failed')); }
                };
                pc.onconnectionstatechange = check;
                check();
            });
            const media = await stream;
            await connected;
            if (signal.aborted) throw abortError();
            // Chrome only delivers a remote stream that is also attached to a media element; this one is silent.
            sink = Object.assign(new Audio(), { srcObject: media, muted: true });
            sink.play().catch(() => {});
            this.receiver = transceiver.receiver;
            this._applyBuffer();
            const source = this.context.createMediaStreamSource(media);
            source.connect(this.output);
            tap = this.context.createAnalyser();
            tap.fftSize = 512;
            source.connect(tap);
            const samples = new Float32Array(tap.fftSize);
            meter = setInterval(() => {
                tap.getFloatTimeDomainData(samples);
                let peak = 0;
                for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
                this.level = Math.max(peak, this.level * 0.85);
            }, 50);
            this.webrtcLive = true;
            this.error = null;
            this._animate();
            this.onState('live', null);
            this.log('Audio over WebRTC');
            await new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => reject(abortError()), { once: true });
                pc.addEventListener('connectionstatechange', () => {
                    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) resolve();
                });
            });
        } finally {
            cleanup();
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
