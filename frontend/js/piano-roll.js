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
        if (this.drag) return; // a state broadcast must not redraw under the user's pointer
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
            if (notes.length || (requested?.track === t && requested?.slot === s)) this.clips.push({ key: `${t}:${s}`, track: t, slot: s, label: `Track ${t + 1} · Clip ${s + 1}`, length: clip.length, notes, all: clip.events || [] });
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
        status.textContent = clip ? `${clip.notes.length} notes · ${clip.length} beats · Click to add, drag to move, drag the right edge to resize, double-click or Delete to remove` : 'No recorded notes on this channel.';
        const position = document.getElementById('piano-roll-position');
        if (position) position.textContent = 'Stopped';
        if (!clip) return;
        const notes = clip.notes.filter(n => Number.isFinite(n.note) && Number.isFinite(n.start) && Number.isFinite(n.dur));
        // Room above and below the notes (at least two octaves) so new notes can be placed.
        const pitchesInUse = notes.length ? notes.map(n => n.note) : [60];
        let low = Math.max(0, Math.min(...pitchesInUse) - 4);
        let high = Math.min(127, Math.max(...pitchesInUse) + 4);
        if (high - low < 24) {
            const extra = 24 - (high - low);
            low = Math.max(0, low - Math.ceil(extra / 2));
            high = Math.min(127, high + Math.floor(extra / 2));
        }
        const beats = Math.max(1, clip.length);
        const width = 960, left = 52, row = 18, top = 26, height = top + (high - low + 1) * row;
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('tabindex', '0');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('aria-label', `${clip.label}, MIDI channel ${this.channel.value}, ${notes.length} notes, editable`);
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
        const geometry = { left, width, row, top, high, low, beats, height };
        for (const note of notes) {
            const rect = add('rect', { x: 0, y: 0, width: 1, height: row - 4, rx: 3, fill: '#a6d477', 'data-note': '1', style: 'cursor: grab; touch-action: none' });
            const title = document.createElementNS(NS, 'title');
            rect.appendChild(title);
            const entry = { rect, note, title };
            this.paintNote(entry, geometry);
            this.noteRects.push(entry);
            rect.addEventListener('pointerdown', e => this.beginDrag(e, entry, clip, geometry, svg));
            rect.addEventListener('dblclick', e => { e.stopPropagation(); this.removeNote(clip, note); });
        }
        svg.addEventListener('click', e => {
            if (e.target.dataset?.note) return;
            this.addNote(e, clip, geometry, svg);
        });
        svg.addEventListener('keydown', e => {
            if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected && clip.notes.includes(this.selected)) {
                e.preventDefault();
                this.removeNote(clip, this.selected);
            }
        });
        this.playhead = add('line', { x1: left, x2: left, y1: 0, y2: height, stroke: '#ffb967', 'stroke-width': 2, 'pointer-events': 'none', visibility: 'hidden' });
        this.beatToX = x;
        view.appendChild(svg);
        this.updateProgress(this.positions || []);
    }

    snapStep() {
        const grid = this.state?.quantizeGrid;
        return grid > 0 ? grid : 0.25;
    }

    // Pointer position in beats and pitch, from the svg's own coordinate system.
    pointerPosition(e, g, svg) {
        const point = svg.createSVGPoint();
        point.x = e.clientX; point.y = e.clientY;
        const p = point.matrixTransform(svg.getScreenCTM().inverse());
        return {
            beat: (p.x - g.left) / (g.width - g.left) * g.beats,
            pitch: g.high - Math.floor((p.y - g.top) / g.row),
            px: p.x,
        };
    }

    paintNote({ rect, note, title }, g) {
        const wide = (g.width - g.left) / g.beats;
        rect.setAttribute('x', g.left + Math.max(0, note.start) * wide);
        rect.setAttribute('y', g.top + (g.high - note.note) * g.row + 2);
        rect.setAttribute('width', Math.max(2, note.dur * wide));
        rect.setAttribute('opacity', 0.45 + (note.velocity || 80) / 127 * 0.55);
        rect.setAttribute('stroke', this.selected === note ? '#ffffff' : 'none');
        title.textContent = `${noteName(note.note)} · Beat ${note.start + 1} · ${note.dur} beats · Velocity ${note.velocity}`;
    }

    beginDrag(e, entry, clip, g, svg) {
        if (e.button !== 0) return;
        e.preventDefault();
        const note = entry.note;
        const here = this.pointerPosition(e, g, svg);
        const wide = (g.width - g.left) / g.beats;
        const edge = g.left + (note.start + note.dur) * wide;
        const mode = here.px > edge - 8 && note.dur * wide > 16 ? 'resize' : 'move';
        this.selected = note;
        svg.focus({ preventScroll: true });
        entry.rect.setPointerCapture(e.pointerId);
        this.drag = { mode, entry, original: { start: note.start, dur: note.dur, note: note.note }, grab: here.beat - note.start, moved: false };
        const step = this.snapStep();
        const snap = beat => Math.round(beat / step) * step;
        const move = ev => {
            const at = this.pointerPosition(ev, g, svg);
            if (this.drag.mode === 'resize') {
                note.dur = Math.max(step, Math.min(snap(at.beat - note.start), clip.length - note.start));
            } else {
                note.start = Math.max(0, Math.min(snap(at.beat - this.drag.grab), clip.length - step));
                note.note = Math.max(0, Math.min(127, at.pitch));
            }
            this.drag.moved = true;
            this.paintNote(entry, g);
        };
        const finish = ev => {
            entry.rect.removeEventListener('pointermove', move);
            entry.rect.removeEventListener('pointerup', finish);
            entry.rect.removeEventListener('pointercancel', finish);
            const { moved } = this.drag;
            this.drag = null;
            if (moved) this.commit(clip);
            else this.paintNote(entry, g);
            if (this.state) this.update(this.state);
        };
        entry.rect.addEventListener('pointermove', move);
        entry.rect.addEventListener('pointerup', finish);
        entry.rect.addEventListener('pointercancel', finish);
        this.paintNote(entry, g);
    }

    addNote(e, clip, g, svg) {
        const at = this.pointerPosition(e, g, svg);
        if (at.beat < 0 || at.beat >= clip.length || at.pitch < 0 || at.pitch > 127) return;
        const step = this.snapStep();
        const start = Math.min(Math.floor(at.beat / step) * step, clip.length - step);
        const note = { channel: Number(this.channel.value), note: at.pitch, start, dur: Math.min(Math.max(step, 0.5), clip.length - start), velocity: 100 };
        clip.all.push(note);
        clip.notes.push(note);
        this.selected = note;
        this.commit(clip);
        this.render();
    }

    removeNote(clip, note) {
        clip.all.splice(clip.all.indexOf(note), 1);
        clip.notes.splice(clip.notes.indexOf(note), 1);
        if (this.selected === note) this.selected = null;
        this.commit(clip);
        this.render();
    }

    // Writes the whole clip (every channel) back to the router.
    commit(clip) {
        this.onEdit?.({
            type: 'daw-edit-clip',
            trackIdx: clip.track,
            slot: clip.slot,
            notes: clip.all.map(n => ({ note: n.note, start: n.start, dur: n.dur, velocity: n.velocity, channel: n.channel })),
        });
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
            rect.setAttribute('stroke', sounding ? '#fff1d2' : this.selected === note ? '#ffffff' : 'none');
        }
        const position = document.getElementById('piano-roll-position');
        if (position) position.textContent = active ? `${beat.toFixed(2)} / ${clip.length} beats` : 'Stopped';
    }
}
