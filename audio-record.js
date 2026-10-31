// Records one sound from the capture: from the moment it is asked until the sound has died away, with the
// silence in front of the first note and behind the last one cut off. The router owns the audio interface,
// so analysis tools ask it for a recording instead of capturing the audio themselves.
const WINDOW_MS = 10;
const KEEP_BEFORE_MS = 10;   // a little room ahead of the attack
const KEEP_AFTER_MS = 30;    // and behind the last audible window

const dbOf = (buffer, channels) => {
    const samples = buffer.length >> 1;
    if (!samples) return -120;
    let sum = 0;
    for (let i = 0; i < samples; i++) { const v = buffer.readInt16LE(i * 2) / 32768; sum += v * v; }
    return 10 * Math.log10(Math.max(sum / samples, 1e-12));
};

// The level (dBFS) under which audio counts as silence: the measured noise floor + margin, never above -40
// and never below -75.
export function silenceThreshold(floorDb, marginDb = 10) {
    return Math.max(-75, Math.min(-40, floorDb + marginDb));
}

export function recordUntilQuiet(capture, { maxSeconds = 6, quietFor = 0.4, silenceDb = null, marginDb = 10, onsetWait = null, signal = null } = {}) {
    const { sampleRate, channels, frameBytes } = capture;
    const windowBytes = Math.max(1, Math.round(sampleRate * WINDOW_MS / 1000)) * frameBytes;
    const floorDb = dbOf(capture.snapshot(0.3), channels);
    const threshold = Number.isFinite(silenceDb) ? silenceDb : silenceThreshold(floorDb, marginDb);
    const quietWindows = Math.max(1, Math.round(quietFor * 1000 / WINDOW_MS));
    const keepBefore = Math.round(KEEP_BEFORE_MS / WINDOW_MS);
    const keepAfter = Math.round(KEEP_AFTER_MS / WINDOW_MS);
    const waitForSound = onsetWait ?? maxSeconds;

    return new Promise(resolve => {
        const windows = [];          // kept windows, from the first note on
        const before = [];           // windows of the silence in front, only the last few are kept
        let pending = Buffer.alloc(0);
        let heardSound = false, quietRun = 0, lastLoud = -1, seen = 0, done = false, onsetAt = 0;
        const started = Date.now();

        const finish = stoppedQuiet => {
            if (done) return;
            done = true;
            capture.off('chunk', onChunk);
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', abort);
            const kept = heardSound ? windows.slice(0, lastLoud + 1 + keepAfter) : [];
            const lead = heardSound ? before.slice(-keepBefore) : [];
            const pcm = Buffer.concat([...lead, ...kept]);
            const seconds = pcm.length / frameBytes / sampleRate;
            resolve({ pcm, sampleRate, channels, stoppedQuiet: stoppedQuiet && heardSound, heardSound, silenceDb: threshold, floorDb,
                seconds, leadSilenceS: onsetAt * WINDOW_MS / 1000 - lead.length * WINDOW_MS / 1000,
                trailSilenceS: heardSound ? Math.max(0, windows.length - 1 - lastLoud - keepAfter) * WINDOW_MS / 1000 : 0 });
        };
        const abort = () => finish(false);
        const timer = setTimeout(() => finish(false), maxSeconds * 1000);
        signal?.addEventListener?.('abort', abort);

        const onChunk = chunk => {
            pending = Buffer.concat([pending, chunk]);
            while (!done && pending.length >= windowBytes) {
                const window = pending.subarray(0, windowBytes);
                pending = pending.subarray(windowBytes);
                seen++;
                const loud = dbOf(window, channels) >= threshold;
                if (!heardSound) {
                    if (!loud) {
                        before.push(window);
                        if (before.length > keepBefore) before.shift();
                        if ((Date.now() - started) / 1000 > waitForSound) { finish(true); return; }
                        continue;
                    }
                    heardSound = true;
                    onsetAt = seen - 1;
                }
                windows.push(window);
                if (loud) { lastLoud = windows.length - 1; quietRun = 0; }
                else if (++quietRun >= quietWindows) { finish(true); return; }
            }
        };
        capture.on('chunk', onChunk);
    });
}

// A 16-bit PCM WAV file around the samples.
export function wavOf(pcm, sampleRate, channels) {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * channels * 2, 28);
    header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

// GET /audio/record?max=seconds&quietFor=seconds[&silenceDb=dB][&margin=dB]
// The headers go out at once (the caller starts the sound when it has them); the body, sent when the recording
// is complete, is JSON: the measurements and the audio as base64 PCM (S16_LE, channels interleaved).
export function serveRecording(capture, req, res) {
    const status = capture.status();
    if (status.state !== 'live') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: status.error || `audio capture ${status.state}`, state: status.state }));
        return;
    }
    const params = new URL(req.url, 'http://x').searchParams;
    const number = (name, fallback, min, max) => { const v = params.get(name); const n = v === null || v === '' ? NaN : Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; };
    const abort = new AbortController();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.flushHeaders();
    res.once('close', () => abort.abort());
    recordUntilQuiet(capture, {
        maxSeconds: number('max', 6, 0.5, 90),
        quietFor: number('quietFor', 0.4, 0.05, 10),
        silenceDb: number('silenceDb', null, -110, 0),
        marginDb: number('margin', 10, 0, 40),
        signal: abort.signal,
    }).then(({ pcm, ...info }) => {
        if (!res.writableEnded) res.end(JSON.stringify({ ok: true, ...info, pcm: pcm.toString('base64') }));
    });
}
