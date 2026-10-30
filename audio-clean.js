// Noise reduction for the audio that is listened to (the browser and the Pi's headphone jack). The raw
// stream stays untouched for analysis (mcpi). Both levels remove steady hiss while music plays (a spectral
// noise reducer: it learns the spectrum of the steady noise and takes it out) and mute what is left between
// the notes (a noise gate that finds the noise floor by itself):
//   light   firm but gentle: the hiss drops by up to 8 dB while music plays, 12 dB more in the pauses.
//   strong  the hiss drops by up to 15 dB while music plays, 12 dB more in the pauses; a held note that lasts
//           longer than about 20 seconds can be taken for noise and dulled.
// Both work on interleaved 16-bit PCM and keep one state per filter; they delay the audio by about 23 ms.

const FRAME = 1024;
const HOP = FRAME / 2;
const BLOCK = 64;   // gate decisions are made every 64 samples (about 1.5 ms)

export const FILTER_LEVELS = ['light', 'strong'];

// ---- gate -----------------------------------------------------------------------------------------------

// Linked across channels. The threshold follows the noise floor: the quietest 0.5 s of the last ten seconds, measured
// on a level smoothed over 40 ms (a 64-sample block of a low hum or rumble swings far too much to measure the
// floor with), so it works whatever the input gain is. The gate opens on the fast level, closes on the smooth one.
class Gate {
    constructor(sampleRate, { depthDb = 12, marginDb = 6, ratio = 4 } = {}) {
        this.depthDb = depthDb;
        this.marginDb = marginDb;
        this.ratio = ratio;
        this.openCoef = 1 - Math.exp(-BLOCK / sampleRate / 0.005);
        this.closeCoef = 1 - Math.exp(-BLOCK / sampleRate / 0.2);
        this.levelCoef = 1 - Math.exp(-BLOCK / sampleRate / 0.04);
        this.blocksPerSlot = Math.round(0.5 * sampleRate / BLOCK);
        this.slots = [];            // quietest smoothed level (dB) of each past half second
        this.slotMin = Infinity;
        this.slotBlocks = 0;
        this.power = null;          // the smoothed level (power)
        this.reductionDb = 0;       // current attenuation (0 = open)
        this.carry = [];            // samples that do not fill a whole block yet, per channel
    }

    floorDb() {
        return Math.max(-80, Math.min(this.slotMin, ...this.slots));
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
            this.power = this.power === null ? energy : this.power + (energy - this.power) * this.levelCoef;
            const fastDb = 10 * Math.log10(energy + 1e-12);
            const smoothDb = 10 * Math.log10(this.power + 1e-12);
            if (smoothDb < this.slotMin) this.slotMin = smoothDb;
            if (++this.slotBlocks >= this.blocksPerSlot) {
                this.slots.push(this.slotMin);
                if (this.slots.length > 20) this.slots.shift();
                this.slotMin = Infinity;
                this.slotBlocks = 0;
            }
            const threshold = Math.min(this.floorDb() + this.marginDb, -30);
            // Open when either level is above the threshold; otherwise close in proportion to how far the smooth level
            // is below it. The attenuation is never negative: a gate does not amplify.
            const target = fastDb >= threshold || smoothDb >= threshold ? 0 : Math.min(this.depthDb, (this.ratio - 1) * (threshold - smoothDb));
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

const VALLEY_SPAN = 10;  // bins each side (about 430 Hz at 44.1 kHz)
const VALLEY_PERCENTILE = 0.1;   // the valleys: the quietest tenth of the neighbours
const VALLEY_CAP = 1.8;  // that percentile sits below the average of pure noise; this brings it back to the noise level
const VALLEY_EVERY = 4;  // frames between refreshes (the valleys change slowly, and this keeps the cost down)

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
        this.valley = new Float64Array(FRAME / 2 + 1);
        this.window = new Float64Array(2 * VALLEY_SPAN + 1);
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
        // Hiss is smooth across neighbouring frequencies, a held note is a narrow peak: the noise level of a frequency is
        // never taken higher than the typical valley around it, so a steady drone is not mistaken for noise.
        if (this.frames % VALLEY_EVERY === 1) {
            for (let k = 0; k < bins; k++) {
                let count = 0;
                for (let j = Math.max(0, k - VALLEY_SPAN); j <= Math.min(bins - 1, k + VALLEY_SPAN); j++) this.window[count++] = this.smooth[j];
                const sorted = this.window.subarray(0, count).sort();
                this.valley[k] = sorted[Math.floor((count - 1) * VALLEY_PERCENTILE)];
            }
        }
        for (let k = 0; k < bins; k++) {
            let floor = this.blockMin[k];
            for (const block of this.history) if (block[k] < floor) floor = block[k];
            floor = Math.min(floor, VALLEY_CAP * this.valley[k]);
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

// floorGain: the least a frequency is turned down by while music plays; strength: how much of the learnt noise is taken out.
const LEVELS = {
    light: { floorGain: 0.4, strength: 1.0 },    // at most -8 dB
    strong: { floorGain: 0.18, strength: 1.4 },  // at most -15 dB
};

export class NoiseFilter {
    constructor({ level = 'light', sampleRate = 44100, channels = 2 } = {}) {
        if (!FILTER_LEVELS.includes(level)) throw new Error(`unknown noise filter level "${level}"`);
        this.level = level;
        this.channels = channels;
        this.gate = new Gate(sampleRate);
        this.spectral = Array.from({ length: channels }, () => new SpectralChannel(sampleRate, LEVELS[level]));
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
        channels = channels.map((data, c) => this.spectral[c].process(data));
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
