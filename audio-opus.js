import { EventEmitter } from 'node:events';
import OpusScript from 'opusscript';

// Opus frames of 20 ms at 48 kHz.
const FRAME_SAMPLES = 960;
export const OPUS_RATE = 48000;

// "opus-96" -> 96000 bit/s; "pcm" (or anything else) -> null.
export function qualityBitrate(quality) {
    const match = /^opus-(\d+)$/.exec(String(quality));
    return match ? Number(match[1]) * 1000 : null;
}

// Linear-interpolation resampler for interleaved 16-bit audio (Opus runs at 48 kHz, the capture at 44.1 kHz). It keeps
// its position between chunks, so the stream is continuous.
export class Resampler {
    constructor(fromRate, toRate, channels) {
        this.step = fromRate / toRate;   // input samples per output sample
        this.channels = channels;
        this.position = 0;               // position of the next output sample, in input frames, relative to `last`
        this.last = new Int16Array(channels);
        this.haveLast = false;
    }

    process(chunk) {
        const channels = this.channels;
        const frames = Math.floor(chunk.length / (2 * channels));
        const input = new Int16Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + frames * channels * 2));
        // Index -1 is the last frame of the previous chunk.
        const at = (frame, channel) => (frame < 0 ? this.last[channel] : input[frame * channels + channel]);
        if (!this.haveLast) { this.haveLast = true; this.position = 0; for (let c = 0; c < channels; c++) this.last[c] = input[c] ?? 0; }
        const out = [];
        while (this.position < frames - 1 + 1e-9 && Math.floor(this.position) + 1 < frames) {
            const base = Math.floor(this.position), fraction = this.position - base;
            for (let c = 0; c < channels; c++) out.push(Math.round(at(base, c) * (1 - fraction) + at(base + 1, c) * fraction));
            this.position += this.step;
        }
        if (frames) {
            for (let c = 0; c < channels; c++) this.last[c] = input[(frames - 1) * channels + c];
            this.position -= frames;
        }
        return Buffer.from(Int16Array.from(out).buffer);
    }
}

// One Opus encoder shared by every listener that asks for it: the (noise-filtered) capture is encoded once and each
// packet goes to all of them, so the cost does not grow with their number. Packets are framed as a 2-byte big-endian
// length followed by the Opus packet. The encoder exists while at least one listener uses it.
export class OpusBroadcast extends EventEmitter {
    constructor(capture, { quality = 'opus-96' } = {}) {
        super();
        this.capture = capture;
        this.quality = quality;
        this.packing = 2;   // frames per network write (see PACKING_FRAMES)
        this.encoder = null;
        this.pending = Buffer.alloc(0);
        this.count = 0;
        this.unsubscribeCapture = null;
    }

    // Opus runs at 48 kHz: a 44.1 kHz capture is resampled for it; a capture at another rate gets the raw stream.
    get available() {
        return [OPUS_RATE, 44100].includes(this.capture.sampleRate) && qualityBitrate(this.quality) != null;
    }

    get bitrate() {
        return qualityBitrate(this.quality);
    }

    setQuality(quality) {
        const was = this.quality;
        this.quality = quality;
        if (this.encoder && this.bitrate) this.encoder.setBitrate(this.bitrate);
        if (was !== quality) this.emit('quality', quality, was);
    }

    // Returns the unsubscribe function.
    subscribe(onPacket) {
        if (this.count === 0) this._start();
        this.count++;
        this.on('packet', onPacket);
        return () => {
            this.off('packet', onPacket);
            if (--this.count <= 0) { this.count = 0; this._stop(); }
        };
    }

    _start() {
        this.encoder = new OpusScript(OPUS_RATE, this.capture.channels, OpusScript.Application.AUDIO);
        if (this.bitrate) this.encoder.setBitrate(this.bitrate);
        // Tuned for music at a steady rate: music mode, the most thorough search, bitrate kept near the target (constrained VBR).
        for (const [ctl, value] of [[4024, 3002], [4010, 10], [4006, 1], [4020, 1]]) {
            try { this.encoder.encoderCTL(ctl, value); } catch { /* an option this build lacks */ }
        }
        this.pending = Buffer.alloc(0);
        this.resampler = this.capture.sampleRate === OPUS_RATE ? null : new Resampler(this.capture.sampleRate, OPUS_RATE, this.capture.channels);
        this.unsubscribeCapture = this.capture.subscribeClean(chunk => this._feed(chunk));
    }

    _stop() {
        this.unsubscribeCapture?.();
        this.unsubscribeCapture = null;
        this.encoder?.delete?.();
        this.encoder = null;
        this.pending = Buffer.alloc(0);
    }

    _feed(chunk) {
        if (!this.encoder) return;
        if (this.resampler) chunk = this.resampler.process(chunk);
        const frameBytes = FRAME_SAMPLES * this.capture.frameBytes;
        this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
        while (this.pending.length >= frameBytes) {
            const frame = this.pending.subarray(0, frameBytes);
            this.pending = this.pending.subarray(frameBytes);
            let packet;
            try { packet = this.encoder.encode(frame, FRAME_SAMPLES); } catch { continue; }
            const framed = Buffer.allocUnsafe(2 + packet.length);
            framed.writeUInt16BE(packet.length, 0);
            Buffer.from(packet).copy(framed, 2);
            this.emit('packet', framed);
        }
        if (this.pending.length) this.pending = Buffer.from(this.pending);   // do not keep the whole chunk alive
    }
}
