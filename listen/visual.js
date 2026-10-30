// Psychedelic visualization that follows the sound. It draws around a hole in the middle (the play
// button): a kaleidoscope of the spectrum, a ring of the waveform, particles thrown out on every beat,
// and a feedback tunnel that zooms and spins faster as the music gets louder.

// Average of the FFT bins in [from, to) as 0..1.
export function bandEnergy(data, from, to) {
    const end = Math.min(to, data.length);
    if (end <= from) return 0;
    let sum = 0;
    for (let i = from; i < end; i++) sum += data[i];
    return sum / ((end - from) * 255);
}

// Rises quickly, falls slowly: what the eye follows.
export function smooth(previous, next, attack = 0.6, decay = 0.12) {
    return next > previous ? previous + (next - previous) * attack : previous + (next - previous) * decay;
}

// 0..1 from an RMS amplitude: -55 dBFS or quieter is empty, full scale is full.
export function levelFromRms(rms) {
    const db = 20 * Math.log10(Math.max(rms, 1e-5));
    return Math.max(0, Math.min(1, (db + 55) / 55));
}

// A hit when the bass jumps clearly above its recent average.
export class BeatDetector {
    constructor() { this.average = 0; this.cooldown = 0; }
    update(energy, elapsedMs) {
        this.cooldown = Math.max(0, this.cooldown - elapsedMs);
        const hit = this.cooldown === 0 && energy > 0.22 && energy > this.average * 1.35;
        this.average += (energy - this.average) * Math.min(1, elapsedMs / 400);
        if (hit) this.cooldown = 160;
        return hit;
    }
}

// canvas: full-window canvas. getAnalyser: () => AnalyserNode | null (the picture idles when there is none).
// getStereo: () => [left, right] analysers, or null; the two mirrored halves of the kaleidoscope then follow the
// left and right channels.
// getHole: () => radius in CSS px of the circle in the middle that stays free. onFrame({ level, hue, pulse }).
export function startVisual(canvas, { getAnalyser, getStereo = () => null, getHole = () => 90, onFrame = () => {} }) {
    const ctx = canvas.getContext('2d');
    let width = 0, height = 0, dpr = 1;
    const resize = () => {
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        width = window.innerWidth;
        height = window.innerHeight;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#05010f';
        ctx.fillRect(0, 0, width, height);
    };
    resize();
    window.addEventListener('resize', resize);

    const beats = new BeatDetector();
    const particles = [];
    let freq = null, wave = null, node = null, freqLeft = null, freqRight = null, sides = null;
    let hue = 280, bass = 0, mid = 0, treble = 0, level = 0, pulse = 0, rotation = 0, time = 0, last = performance.now(), running = true;

    function frame(now) {
        if (!running) return;
        requestAnimationFrame(frame);
        const elapsed = Math.min(50, now - last);
        last = now;
        time += elapsed;
        const analyser = getAnalyser();
        if (analyser !== node) {
            node = analyser;
            freq = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
            wave = analyser ? new Uint8Array(analyser.fftSize) : null;
        }
        const stereo = getStereo();
        if (stereo !== sides) {
            sides = stereo;
            freqLeft = stereo ? new Uint8Array(stereo[0].frequencyBinCount) : null;
            freqRight = stereo ? new Uint8Array(stereo[1].frequencyBinCount) : null;
        }
        if (stereo) { stereo[0].getByteFrequencyData(freqLeft); stereo[1].getByteFrequencyData(freqRight); }
        let rms = 0;
        if (analyser) {
            analyser.getByteFrequencyData(freq);
            analyser.getByteTimeDomainData(wave);
            let sum = 0;
            for (let i = 0; i < wave.length; i++) { const v = (wave[i] - 128) / 128; sum += v * v; }
            rms = Math.sqrt(sum / wave.length);
        }
        bass = smooth(bass, freq ? bandEnergy(freq, 1, 8) : 0);
        mid = smooth(mid, freq ? bandEnergy(freq, 8, 64) : 0);
        treble = smooth(treble, freq ? bandEnergy(freq, 64, 300) : 0);
        level = smooth(level, levelFromRms(rms), 0.5, 0.08);
        if (freq && beats.update(bass, elapsed)) {
            pulse = 1;
            const holeRadius = getHole();
            for (let i = 0; i < 16 && particles.length < 400; i++) {
                particles.push({ angle: Math.random() * Math.PI * 2, radius: holeRadius, speed: 1.5 + Math.random() * 3 + bass * 4, life: 1, hueShift: Math.random() * 80 });
            }
        }
        pulse *= 0.92;
        hue = (hue + elapsed * (0.02 + treble * 0.18)) % 360;
        rotation += elapsed * (0.00015 + mid * 0.0006);

        const cx = width / 2, cy = height / 2;
        const frameScale = elapsed / 16;

        // Feedback tunnel: the previous picture, zoomed and turned a little, then faded.
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.9;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((0.0015 + mid * 0.004) * frameScale);
        const zoom = 1 + (0.003 + bass * 0.012) * frameScale;
        ctx.scale(zoom, zoom);
        ctx.drawImage(canvas, -cx, -cy, width, height);
        ctx.restore();
        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgba(5, 1, 15, ${0.14 + 0.08 * (1 - level)})`;
        ctx.fillRect(0, 0, width, height);

        const holeRadius = getHole();
        const reach = Math.max(40, Math.min(width, height) * 0.5 - holeRadius - 6);
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';

        // Kaleidoscope: mirrored spectrum spokes around the middle.
        const small = width < 640;
        const segments = small ? 6 : 8;
        const bars = small ? 36 : 56;
        const breath = 0.06 + 0.04 * Math.sin(time / 900);   // keeps a quiet shape alive in silence
        for (let k = 0; k < segments; k++) {
            for (const mirror of [1, -1]) {
                const data = (mirror > 0 ? freqLeft : freqRight) || freq;   // each half follows its own channel
                for (let i = 0; i < bars; i++) {
                    const bin = data ? 1 + Math.floor(Math.pow(i / bars, 1.7) * 300) : 0;
                    const amplitude = Math.min(1, (data ? data[bin] / 255 : 0) + breath);
                    const angle = rotation * 6 + (k / segments) * Math.PI * 2 + mirror * (i / bars) * (Math.PI / segments);
                    const from = holeRadius + 6;
                    const to = from + amplitude * reach * (0.35 + pulse * 0.45);
                    ctx.strokeStyle = `hsl(${(hue + i * 3.2 + k * 22) % 360} 100% ${42 + amplitude * 14}% / .85)`;
                    ctx.lineWidth = 1 + amplitude * 2;
                    ctx.beginPath();
                    ctx.moveTo(cx + Math.cos(angle) * from, cy + Math.sin(angle) * from);
                    ctx.lineTo(cx + Math.cos(angle) * to, cy + Math.sin(angle) * to);
                    ctx.stroke();
                }
            }
        }

        // Waveform ring hugging the button.
        if (wave) {
            ctx.strokeStyle = `hsl(${(hue + 180) % 360} 100% 62%)`;
            ctx.lineWidth = 2 + pulse * 4;
            ctx.beginPath();
            const step = 4;
            for (let i = 0; i <= wave.length; i += step) {
                const v = (wave[i % wave.length] - 128) / 128;
                const angle = (i / wave.length) * Math.PI * 2 + rotation * 3;
                const r = holeRadius + 14 + v * (16 + 70 * level);
                const x = cx + Math.cos(angle) * r, y = cy + Math.sin(angle) * r;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.stroke();
        }

        // Particles thrown out on each beat.
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.radius += p.speed * frameScale;
            p.life -= 0.012 * frameScale;
            if (p.life <= 0) { particles.splice(i, 1); continue; }
            ctx.fillStyle = `hsla(${(hue + p.hueShift) % 360} 100% 65% / ${p.life})`;
            ctx.beginPath();
            ctx.arc(cx + Math.cos(p.angle) * p.radius, cy + Math.sin(p.angle) * p.radius, 1.5 + p.life * 5, 0, Math.PI * 2);
            ctx.fill();
        }

        onFrame({ level, hue, pulse });
    }
    requestAnimationFrame(frame);

    return { stop() { running = false; window.removeEventListener('resize', resize); }, resize };
}
