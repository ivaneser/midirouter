// Measures how far the melody lags the metronome click in a recording that holds both (the click and a
// test note are mixed into the audio interface's input). Pure functions: no MIDI, no audio device.

function toMono(pcm, channels) {
    const frames = Math.floor(pcm.length / (2 * channels));
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += pcm.readInt16LE((i * channels + c) * 2);
        out[i] = sum / channels / 32768;
    }
    return out;
}

// Amplitude of one frequency over time: complex demodulation, then a triangular smoothing window (two moving
// averages) of about `windowSec`, which keeps other frequencies (the click against the note) out far better than
// a plain moving average does. One value per hop.
function movingAverage(values, w) {
    const n = values.length, prefix = new Float64Array(n + 1), out = new Float64Array(n);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + values[i];
    for (let i = 0; i < n; i++) out[i] = (prefix[Math.min(n, i + 1)] - prefix[Math.max(0, i + 1 - w)]) / w;   // window ending at i
    return out;
}

function bandEnvelope(samples, sampleRate, hz, windowSec, hopSec) {
    const n = samples.length;
    const half = Math.max(1, Math.round(windowSec * sampleRate / 2));
    const hop = Math.max(1, Math.round(hopSec * sampleRate));
    const re = new Float64Array(n), im = new Float64Array(n);
    const step = 2 * Math.PI * hz / sampleRate;
    for (let i = 0; i < n; i++) { re[i] = samples[i] * Math.cos(step * i); im[i] = samples[i] * Math.sin(step * i); }
    const smoothRe = movingAverage(movingAverage(re, half), half), smoothIm = movingAverage(movingAverage(im, half), half);
    const env = [];
    for (let end = 2 * half; end < n; end += hop) env.push(2 * Math.hypot(smoothRe[end], smoothIm[end]));
    // The value at sample `end` averages the 2*half samples before it with a triangular weight: centred `half` samples earlier.
    return { env, timeOf: k => (2 * half + k * hop - half) / sampleRate };
}

// Start times (s) of the bursts in an envelope: where it first reaches `edge` of that burst's peak.
function onsets({ env, timeOf }, hopSec, { edge = 0.2, gate = 0.3, minPeak = 0.002 } = {}) {
    const peak = Math.max(...env);
    if (!(peak >= minPeak)) return [];
    const found = [];
    const look = Math.round(0.08 / hopSec), back = Math.round(0.03 / hopSec);
    let armed = true;   // armed again once the envelope has fallen well below the gate (ripple around it is not a new burst)
    for (let k = 1; k < env.length; k++) {
        if (env[k] < gate * peak * 0.5) armed = true;
        if (!armed || !(env[k] >= gate * peak && env[k - 1] < gate * peak)) continue;
        let local = 0;
        for (let j = k; j < Math.min(env.length, k + look); j++) local = Math.max(local, env[j]);
        let start = k;
        for (let j = Math.max(0, k - back); j <= k; j++) if (env[j] >= edge * local) { start = j; break; }
        found.push(timeOf(start));
        armed = false;
    }
    return found;
}

const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// The detector reports a burst slightly before it starts (the smoothing window sees it coming) and by an amount
// that depends on the window. Run it on an ideal burst to learn that amount, so click and note are compared fairly.
const biasCache = new Map();
function detectorBias({ sampleRate, hz, windowSec, decaySec }) {
    const key = [sampleRate, hz, windowSec, decaySec].join();
    if (!biasCache.has(key)) {
        const frames = Math.round(1.2 * sampleRate), start = 0.5, burst = new Float32Array(frames);
        const length = decaySec ? 0.06 : 0.12;
        for (let i = 0; i < length * sampleRate; i++) {
            const t = i / sampleRate;
            burst[Math.round(start * sampleRate) + i] = 0.5 * (decaySec ? Math.exp(-t / decaySec) : 1) * Math.sin(2 * Math.PI * hz * t);
        }
        const found = onsets(bandEnvelope(burst, sampleRate, hz, windowSec, 0.001), 0.001);
        biasCache.set(key, found.length === 1 ? found[0] - start : 0);
    }
    return biasCache.get(key);
}

// pcm: 16-bit little-endian interleaved. Click bursts are found at clickHz (the plain and the accented click),
// notes at noteHz. Returns the median note lag behind the click in ms (positive: the note is late).
export function measureLag(pcm, { sampleRate, channels = 2, noteHz, clickHz = [1000, 2000], beatSec }) {
    const samples = toMono(pcm, channels);
    const hop = 0.001, clickWindow = 0.012, noteWindow = 0.04;
    // The note is far louder than the click on a real input and its onset splatters into the click bands: take the
    // low frequencies (the note) out before looking for clicks.
    const lowPass = movingAverage(samples, Math.max(2, Math.round(sampleRate / 700)));
    const highs = samples.map((v, i) => v - lowPass[i]);
    const clicks = [];
    for (const hz of clickHz) {
        const bias = detectorBias({ sampleRate, hz, windowSec: clickWindow, decaySec: 0.015 });
        clicks.push(...onsets(bandEnvelope(highs, sampleRate, hz, clickWindow, hop), hop).map(t => t - bias));
    }
    clicks.sort((a, b) => a - b);
    const distinctClicks = clicks.filter((t, i) => i === 0 || t - clicks[i - 1] > 0.03);   // plain and accent band both fire on one click
    const noteBias = detectorBias({ sampleRate, hz: noteHz, windowSec: noteWindow, decaySec: 0 });
    const notes = onsets(bandEnvelope(samples, sampleRate, noteHz, noteWindow, hop), hop).map(t => t - noteBias);
    const pairs = [];
    for (const note of notes) {
        let nearest = null;
        for (const click of distinctClicks) if (nearest === null || Math.abs(click - note) < Math.abs(nearest - note)) nearest = click;
        if (nearest !== null && Math.abs(nearest - note) < beatSec / 2) pairs.push({ click: nearest, note, lagMs: (note - nearest) * 1000 });
    }
    const lags = pairs.map(p => p.lagMs);
    const lagMs = lags.length ? median(lags) : null;
    const jitterMs = lags.length ? lags.reduce((sum, l) => sum + Math.abs(l - lagMs), 0) / lags.length : null;
    return { lagMs, jitterMs, pairs: pairs.length, clicks: distinctClicks.length, notes: notes.length, detail: pairs.map(p => [Math.round(p.click * 1000), Math.round(p.note * 1000)]) };
}
