// Noise reduction for the audio that is listened to (the browser and the Pi's headphone jack). The raw
// stream stays untouched for analysis (mcpi). Two levels:
//   light   an automatic noise gate: learns the noise floor and turns passages near it down by up to 12 dB,
//           so the hiss between notes disappears. No delay.
//   strong  a spectral noise reducer (learns the spectrum of the steady noise and subtracts it, so the hiss
//           also drops while music plays), followed by the same gate. About 23 ms delay.
// Both work on interleaved 16-bit PCM and keep one state per listener.

const FRAME = 1024;
const HOP = FRAME / 2;
const BLOCK = 64;   // gate decisions are made every 64 samples (about 1.5 ms)

export const FILTER_LEVELS = ['light', 'strong'];

// ---- gate -----------------------------------------------------------------------------------------------

// Linked across channels. The threshold follows the noise floor, found as the quietest 0.5 s block of the last
// ten seconds, so it works whatever the input gain is.
class Gate {
    constructor(sampleRate, { depthDb = 12, marginDb = 6, ratio = 4 } = {}) {
        this.depthDb = depthDb;
        this.marginDb = marginDb;
        this.ratio = ratio;
        this.openCoef = 1 - Math.exp(-BLOCK / sampleRate / 0.005);
        this.closeCoef = 1 - Math.exp(-BLOCK / sampleRate / 0.2);
        this.blocksPerSlot = Math.round(0.5 * sampleRate / BLOCK);
        this.slots = [];            // quietest block level (dB) of each past half second
        this.slotMin = Infinity;
        this.slotBlocks = 0;
        this.reductionDb = 0;       // current attenuation (0 = open)
        this.carry = [];            // samples that do not fill a whole block yet, per channel
    }

    floorDb() {
        return Math.min(this.slotMin, ...this.slots);
    }

    // channels: array of Float32Array, all the same length. Processes in place.
    process(channels) {
        const count = channels.length;
        if (!this.carry.length) this.carry = channels.map(() => new Float32Array(0));
        const joined = channels.map((data, c) => {
            const merged = new Float32Array(this.carry[c].length + data.length);
            merged.set(this.carry[c], 0);
            merged.set(data, this.carry[c].length);
            return merged;
        });
        const total = joined[0].length;
        const whole = total - (total % BLOCK);
        for (let start = 0; start < whole; start += BLOCK) {
            let energy = 0;
            for (let c = 0; c < count; c++) {
                let sum = 0;
                for (let i = start; i < start + BLOCK; i++) sum += joined[c][i] * joined[c][i];
                energy = Math.max(energy, sum / BLOCK);
            }
            const levelDb = 10 * Math.log10(energy + 1e-12);
            if (levelDb < this.slotMin) this.slotMin = levelDb;
            if (++this.slotBlocks >= this.blocksPerSlot) {
                this.slots.push(this.slotMin);
                if (this.slots.length > 20) this.slots.shift();
                this.slotMin = Infinity;
                this.slotBlocks = 0;
            }
            const threshold = Math.min(this.floorDb() + this.marginDb, -30);
            const target = levelDb >= threshold ? 0 : Math.min(this.depthDb, (this.ratio - 1) * (threshold - levelDb));
            const previous = this.reductionDb;
            this.reductionDb += (target - previous) * (target < previous ? this.openCoef : this.closeCoef);
            const from = 10 ** (-previous / 20), to = 10 ** (-this.reductionDb / 20);
            for (let c = 0; c < count; c++) {
                for (let i = 0; i < BLOCK; i++) joined[c][start + i] *= from + (to - from) * (i + 1) / BLOCK;   // no steps
            }
        }
        this.carry = joined.map(data => data.slice(whole));
        // The samples of a partial block wait for the next call; this call returns only whole blocks.
        return joined.map(data => data.subarray(0, whole));
    }
}

// ---- spectral noise reducer -----------------------------------------------------------------------------

const WINDOW = Float64Array.from({ length: FRAME }, (_, i) => Math.sin(Math.PI * (i + 0.5) / FRAME));   // sqrt-Hann: 50 % overlap sums to 1
const BITS = Math.log2(FRAME);
const REVERSE = Uint16Array.from({ length: FRAME }, (_, i) => { let r = 0; for (let b = 0; b < BITS; b++) r |= ((i >> b) & 1) << (BITS - 1 - b); return r; });
const COS = Float64Array.from({ length: FRAME / 2 }, (_, i) => Math.cos(2 * Math.PI * i / FRAME));
const SIN = Float64Array.from({ length: FRAME / 2 }, (_, i) => -Math.sin(2 * Math.PI * i / FRAME));

// In-place radix-2 FFT of FRAME points (forward; the inverse is done by swapping re and im).
function fft(re, im) {
    for (let i = 0; i < FRAME; i++) {
        const j = REVERSE[i];
        if (j > i) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let size = 2; size <= FRAME; size <<= 1) {
        const half = size >> 1, step = FRAME / size;
        for (let start = 0; start < FRAME; start += size) {
            for (let k = 0; k < half; k++) {
                const wr = COS[k * step], wi = SIN[k * step];
                const a = start + k, b = a + half;
                const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
                re[b] = re[a] - tr; im[b] = im[a] - ti;
                re[a] += tr; im[a] += ti;
            }
        }
    }
}

// One channel. The noise spectrum is the per-bin minimum of the smoothed magnitude over the last twenty seconds
// (scaled up, since a minimum sits below the average): steady noise is learnt, notes that do not last twenty
// seconds are not mistaken for it.
class SpectralChannel {
    constructor(sampleRate, { floorGain = 0.25, bias = 1.7, strength = 1.2 } = {}) {
        this.floorGain = floorGain;
        this.bias = bias;
        this.strength = strength;
        this.input = new Float64Array(0);
        this.overlap = new Float64Array(FRAME);
        this.re = new Float64Array(FRAME);
        this.im = new Float64Array(FRAME);
        this.smooth = new Float64Array(FRAME / 2 + 1);
        this.gain = new Float64Array(FRAME / 2 + 1).fill(1);
        this.blockMin = new Float64Array(FRAME / 2 + 1).fill(Infinity);
        this.history = [];
        this.framesPerBlock = Math.round(2 * sampleRate / HOP);   // two seconds
        this.frames = 0;
        this.noise = new Float64Array(FRAME / 2 + 1).fill(Infinity);
    }

    // samples: Float32Array. Returns the samples that are finished (a multiple of HOP, delayed by one frame).
    process(samples) {
        const merged = new Float64Array(this.input.length + samples.length);
        merged.set(this.input, 0);
        merged.set(samples, this.input.length);
        const out = [];
        let position = 0;
        while (merged.length - position >= FRAME) {
            this._frame(merged, position);
            for (let i = 0; i < HOP; i++) out.push(this.overlap[i]);
            this.overlap.copyWithin(0, HOP);
            this.overlap.fill(0, FRAME - HOP);
            position += HOP;
        }
        this.input = merged.slice(position);
        return Float32Array.from(out);
    }

    _frame(data, position) {
        const { re, im } = this;
        for (let i = 0; i < FRAME; i++) { re[i] = data[position + i] * WINDOW[i]; im[i] = 0; }
        fft(re, im);
        const bins = FRAME / 2 + 1;
        for (let k = 0; k < bins; k++) {
            const magnitude = Math.hypot(re[k], im[k]);
            this.smooth[k] = this.frames === 0 ? magnitude : this.smooth[k] * 0.8 + magnitude * 0.2;
            if (this.smooth[k] < this.blockMin[k]) this.blockMin[k] = this.smooth[k];
        }
        if (++this.frames % this.framesPerBlock === 0) {
            this.history.push(Float64Array.from(this.blockMin));
            if (this.history.length > 10) this.history.shift();
            this.blockMin.fill(Infinity);
        }
        for (let k = 0; k < bins; k++) {
            let floor = this.blockMin[k];
            for (const block of this.history) if (block[k] < floor) floor = block[k];
            this.noise[k] = floor;
            const magnitude = Math.hypot(re[k], im[k]);
            const wanted = magnitude > 0 ? Math.max(this.floorGain, 1 - this.strength * this.bias * floor / magnitude) : this.floorGain;
            // Opens at once (keeps attacks), closes over a few frames (no flutter).
            this.gain[k] = wanted > this.gain[k] ? wanted : this.gain[k] * 0.6 + wanted * 0.4;
            re[k] *= this.gain[k]; im[k] *= this.gain[k];
            if (k > 0 && k < bins - 1) { re[FRAME - k] = re[k]; im[FRAME - k] = -im[k]; }   // keep the spectrum symmetric (real output)
        }
        // Inverse FFT by swapping real and imaginary parts: the real result ends up in `re`.
        fft(im, re);
        for (let i = 0; i < FRAME; i++) this.overlap[i] += re[i] / FRAME * WINDOW[i];
    }
}

// ---- the filter -----------------------------------------------------------------------------------------

export class NoiseFilter {
    constructor({ level = 'light', sampleRate = 44100, channels = 2 } = {}) {
        if (!FILTER_LEVELS.includes(level)) throw new Error(`unknown noise filter level "${level}"`);
        this.level = level;
        this.channels = channels;
        this.gate = new Gate(sampleRate);
        this.spectral = level === 'strong' ? Array.from({ length: channels }, () => new SpectralChannel(sampleRate)) : null;
        this.pending = Buffer.alloc(0);
    }

    // Interleaved 16-bit PCM in, interleaved 16-bit PCM out. The output can be shorter than the input
    // (the filter holds back what does not fill a block yet) and is always whole frames.
    process(chunk) {
        const frameBytes = 2 * this.channels;
        const bytes = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
        const frames = Math.floor(bytes.length / frameBytes);
        this.pending = bytes.subarray(frames * frameBytes);
        if (!frames) return Buffer.alloc(0);
        let channels = Array.from({ length: this.channels }, (_, c) => {
            const data = new Float32Array(frames);
            for (let i = 0; i < frames; i++) data[i] = bytes.readInt16LE(i * frameBytes + c * 2) / 32768;
            return data;
        });
        if (this.spectral) channels = channels.map((data, c) => this.spectral[c].process(data));
        const cleaned = this.gate.process(channels);
        const count = cleaned[0].length;
        const out = Buffer.alloc(count * frameBytes);
        for (let i = 0; i < count; i++) {
            for (let c = 0; c < this.channels; c++) {
                const value = Math.max(-1, Math.min(1, cleaned[c][i]));
                out.writeInt16LE(Math.round(value * 32767), i * frameBytes + c * 2);
            }
        }
        return out;
    }
}
