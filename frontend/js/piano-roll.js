const NS = 'http://www.w3.org/2000/svg';
const pitches = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export function noteName(note) { return `${pitches[note % 12]}${Math.floor(note / 12) - 1}`; }

export class PianoRoll {
    constructor() {
        this.section = document.getElementById('piano-roll-section');
        this.channel = document.getElementById('piano-roll-channel');
        this.clip = document.getElementById('piano-roll-clip');
        if (!this.section) return;
        for (let n = 1; n <= 16; n++) this.channel.add(new Option(`Ch ${n}`, String(n)));
        this.channel.addEventListener('change', () => { this.selectedClip = null; this.update(this.state); });
        this.clip.addEventListener('change', () => { this.selectedClip = null; this.render(); });
        this.section.addEventListener('toggle', () => this.render());
    }

    update(state) {
        this.state = state;
        this.positions = state?.playing === false ? [] : state?.clipProgress || [];
        if (!this.section || !state) return;
        if (this.selectedClip && !state.tracks?.[this.selectedClip.track]?.clips?.[this.selectedClip.slot]) this.selectedClip = null;
        const requested = this.selectedClip;
        if (requested) {
            const track = state.tracks?.[requested.track];
            const first = track?.clips?.[requested.slot]?.events?.[0];
            const channel = track?.channelAssigned ? track.channel : first?.channel;
            if (channel) this.channel.value = String(channel);
        }
        const selected = requested ? `${requested.track}:${requested.slot}` : this.clip.value;
        this.clips = [];
        state.tracks?.forEach((track, t) => track.clips?.forEach((clip, s) => {
            const notes = (clip.events || []).filter(n => n.channel === Number(this.channel.value));
            if (notes.length || (requested?.track === t && requested?.slot === s)) this.clips.push({ key: `${t}:${s}`, label: `Track ${t + 1} · Clip ${s + 1}`, length: clip.length, notes });
        }));
        this.clip.replaceChildren();
        for (const clip of this.clips) this.clip.add(new Option(clip.label, clip.key));
        if (this.clips.some(c => c.key === selected)) this.clip.value = selected;
        this.clip.disabled = !this.clips.length;
        this.render();
    }

    selectClip(track, slot) {
        this.selectedClip = { track, slot };
        if (this.state) this.update(this.state);
    }

    render() {
        if (!this.section?.open) return;
        this.playhead = null;
        this.noteRects = [];
        const view = document.getElementById('piano-roll-view');
        const status = document.getElementById('piano-roll-status');
        view.replaceChildren();
        const clip = this.clips?.find(c => c.key === this.clip.value);
        status.textContent = clip ? `${clip.notes.length} notes · ${clip.length} beats · Read only` : 'No recorded notes on this channel.';
        const position = document.getElementById('piano-roll-position');
        if (position) position.textContent = 'Stopped';
        if (!clip) return;
        const notes = clip.notes.filter(n => Number.isFinite(n.note) && Number.isFinite(n.start) && Number.isFinite(n.dur));
        if (!notes.length) return;
        const low = Math.max(0, Math.min(...notes.map(n => n.note)) - 2);
        const high = Math.min(127, Math.max(...notes.map(n => n.note)) + 2);
        const beats = Math.max(1, clip.length, ...notes.map(n => n.start + n.dur));
        const width = 960, left = 52, row = 18, top = 26, height = top + (high - low + 1) * row;
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', `${clip.label}, MIDI channel ${this.channel.value}, ${notes.length} notes`);
        const add = (tag, attrs, text) => {
            const el = document.createElementNS(NS, tag);
            for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
            if (text) el.textContent = text;
            svg.appendChild(el); return el;
        };
        const x = beat => left + beat / beats * (width - left);
        for (let pitch = high; pitch >= low; pitch--) {
            const y = top + (high - pitch) * row;
            add('rect', { x: 0, y, width, height: row, fill: [1, 3, 6, 8, 10].includes(pitch % 12) ? '#131b22' : '#202b34' });
            add('text', { x: 5, y: y + 13, fill: '#aab9c7', 'font-size': 11 }, noteName(pitch));
        }
        const step = Math.max(1, Math.ceil(beats / 64));
        for (let beat = 0; beat <= beats; beat += step) {
            add('line', { x1: x(beat), x2: x(beat), y1: top, y2: height, stroke: '#3a4853' });
            add('text', { x: x(beat) + 3, y: 17, fill: '#aab9c7', 'font-size': 11 }, String(beat + 1));
        }
        for (const note of notes) {
            const rect = add('rect', { x: x(Math.max(0, note.start)), y: top + (high - note.note) * row + 2, width: Math.max(2, note.dur / beats * (width - left)), height: row - 4, rx: 3, fill: '#a6d477', opacity: 0.45 + (note.velocity || 80) / 127 * 0.55 });
            const title = document.createElementNS(NS, 'title');
            title.textContent = `${noteName(note.note)} · Beat ${note.start + 1} · ${note.dur} beats · Velocity ${note.velocity}`;
            rect.appendChild(title);
            this.noteRects.push({ rect, note });
        }
        this.playhead = add('line', { x1: left, x2: left, y1: 0, y2: height, stroke: '#ffb967', 'stroke-width': 2, 'pointer-events': 'none', visibility: 'hidden' });
        this.beatToX = x;
        view.appendChild(svg);
        this.updateProgress(this.positions || []);
    }

    updateProgress(positions) {
        this.positions = positions;
        if (!this.section?.open || !this.playhead) return;
        const clip = this.clips?.find(c => c.key === this.clip.value);
        const progress = positions.find(p => `${p.trackIdx}:${p.slot}` === clip?.key);
        const active = progress && Number.isFinite(progress.progress);
        const beat = active ? Math.max(0, Math.min(1, progress.progress)) * clip.length : 0;
        this.playhead.setAttribute('visibility', active ? 'visible' : 'hidden');
        if (active) {
            this.playhead.setAttribute('x1', this.beatToX(beat));
            this.playhead.setAttribute('x2', this.beatToX(beat));
        }
        for (const { rect, note } of this.noteRects) {
            const sounding = active && beat >= note.start && beat < note.start + note.dur;
            rect.setAttribute('fill', sounding ? '#ffcf80' : '#a6d477');
            rect.setAttribute('stroke', sounding ? '#fff1d2' : 'none');
        }
        const position = document.getElementById('piano-roll-position');
        if (position) position.textContent = active ? `${beat.toFixed(2)} / ${clip.length} beats` : 'Stopped';
    }
}
