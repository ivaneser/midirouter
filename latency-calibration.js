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

// Amplitude of one frequency over time (complex demodulation, then a short moving average), one value per hop.
function bandEnvelope(samples, sampleRate, hz, windowSec, hopSec) {
    const n = samples.length;
    const w = Math.max(2, Math.round(windowSec * sampleRate));
    const hop = Math.max(1, Math.round(hopSec * sampleRate));
    const ci = new Float64Array(n + 1), cq = new Float64Array(n + 1);
    const step = 2 * Math.PI * hz / sampleRate;
    for (let i = 0; i < n; i++) {
        ci[i + 1] = ci[i] + samples[i] * Math.cos(step * i);
        cq[i + 1] = cq[i] + samples[i] * Math.sin(step * i);
    }
    const env = [];
    for (let end = w; end <= n; end += hop) env.push(2 * Math.hypot(ci[end] - ci[end - w], cq[end] - cq[end - w]) / w);
    // env[k] describes the window ending at (w + k*hop) samples; its centre is half a window earlier.
    return { env, timeOf: k => (w + k * hop - w / 2) / sampleRate };
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

// pcm: 16-bit little-endian interleaved. Click bursts are found at clickHz (the plain and the accented click),
// notes at noteHz. Returns the median note lag behind the click in ms (positive: the note is late).
export function measureLag(pcm, { sampleRate, channels = 2, noteHz, clickHz = [1000, 2000], beatSec }) {
    const samples = toMono(pcm, channels);
    const hop = 0.001, window = 0.01;
    const clicks = [];
    for (const hz of clickHz) clicks.push(...onsets(bandEnvelope(samples, sampleRate, hz, window, hop), hop));
    clicks.sort((a, b) => a - b);
    const distinctClicks = clicks.filter((t, i) => i === 0 || t - clicks[i - 1] > 0.03);   // plain and accent band both fire on one click
    const notes = onsets(bandEnvelope(samples, sampleRate, noteHz, window, hop), hop);
    if (process.env.LAT_DEBUG) console.log('clicks', distinctClicks.map(t => t.toFixed(3)).join(' '), '\nnotes', notes.map(t => t.toFixed(3)).join(' '));
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
