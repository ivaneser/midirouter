// Listens to the router's audio interface: GET /audio/live is raw 16-bit mono PCM, played as it
// arrives through Web Audio with a small buffer (about 120 ms) to ride out network jitter.
const TARGET_AHEAD = 0.12;   // seconds of audio kept queued
const MAX_AHEAD = 0.5;       // beyond this the player is lagging: drop chunks to catch up

// Little-endian 16-bit samples from a byte chunk. An odd trailing byte is returned in `rest` to join the next chunk.
export function pcmToFloat(bytes, carry = null) {
    let data = bytes;
    if (carry !== null) {
        data = new Uint8Array(bytes.length + 1);
        data[0] = carry;
        data.set(bytes, 1);
    }
    const whole = data.length - (data.length % 2);
    const samples = new Float32Array(whole / 2);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
        let value = data[i * 2] | (data[i * 2 + 1] << 8);
        if (value >= 0x8000) value -= 0x10000;
        samples[i] = value / 32768;
        const magnitude = Math.abs(samples[i]);
        if (magnitude > peak) peak = magnitude;
    }
    return { samples, peak, rest: whole < data.length ? data[whole] : null };
}

export class AudioListener {
    constructor(button, { log = () => {} } = {}) {
        this.button = button;
        this.log = log;
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
        this.controller = new AbortController();
        try {
            this.context ||= new AudioContext({ latencyHint: 'interactive' });
            await this.context.resume();
            const response = await fetch('/audio/live', { signal: this.controller.signal, cache: 'no-store' });
            if (!response.ok) {
                const reason = (await response.json().catch(() => ({}))).error || `HTTP ${response.status}`;
                throw new Error(reason);
            }
            const rate = Number(response.headers.get('X-Sample-Rate')) || 44100;
            this.next = 0;
            const reader = response.body.getReader();
            let carry = null;
            this._animate();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                const { samples, peak, rest } = pcmToFloat(value, carry);
                carry = rest;
                this.level = Math.max(peak, this.level * 0.85);
                if (samples.length) this._play(samples, rate);
            }
            this.log('Audio stream ended');
        } catch (error) {
            if (error.name !== 'AbortError') {
                this.log(`Audio: ${error.message}`);
                this.error = error.message;
            }
        } finally {
            this.stop();
        }
    }

    stop() {
        this.controller?.abort();
        this.controller = null;
        this.active = false;
        this.level = 0;
        this._render();
    }

    _play(samples, rate) {
        const context = this.context;
        const buffer = context.createBuffer(1, samples.length, rate);
        buffer.copyToChannel(samples, 0);
        const now = context.currentTime;
        if (this.next < now + 0.02) this.next = now + TARGET_AHEAD;   // first chunk, or an underrun: queue a fresh cushion
        if (this.next - now > MAX_AHEAD) return;                       // too far behind: skip this chunk
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.start(this.next);
        this.next += buffer.duration;
    }

    _animate() {
        const frame = () => {
            if (!this.active) return;
            this.button?.style.setProperty('--level', String(Math.min(1, this.level)));
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
