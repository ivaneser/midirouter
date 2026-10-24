// Graphical controls built from groups of related CCs: an XY pad for filter
// cutoff/resonance and an ADSR graph for envelopes. Detection is by control name,
// so every device map benefits without extra configuration.

const NS = 'http://www.w3.org/2000/svg';

const find = (controls, pattern, exclude) => controls.find(c =>
    pattern.test(c.name || '') && !(exclude && exclude.test(c.name || '')));

/** Pick the controls a section can draw graphically; `rest` stays as knobs. */
export function planWidgets(controls) {
    const used = new Set();
    const widgets = [];
    const x = find(controls, /cut-?off|frequency|freq\b/i, /sweep|env|amount|depth/i);
    const y = find(controls, /resonance|\bres\b|\bq\b/i);
    if (x && y && x !== y) {
        widgets.push({ kind: 'xy', x, y });
        used.add(x); used.add(y);
    }
    const a = find(controls, /attack|\brise\b/i);
    const d = find(controls, /decay|\bfall\b/i);
    const s = find(controls, /sustain/i);
    const r = find(controls, /release/i);
    const stages = [a, d, s, r].filter(Boolean);
    if (stages.length >= 2) {
        widgets.push({ kind: 'adsr', a, d, s, r });
        stages.forEach(c => used.add(c));
    }
    return { widgets, rest: controls.filter(c => !used.has(c)) };
}

const clamp01 = v => Math.max(0, Math.min(1, v));
const toFraction = (value, def) => {
    const min = Number(def.min ?? 0), max = Number(def.max ?? 127);
    return max > min ? clamp01((value - min) / (max - min)) : 0;
};
const toValue = (fraction, def) => {
    const min = Number(def.min ?? 0), max = Number(def.max ?? 127);
    return Math.round(min + clamp01(fraction) * (max - min));
};

// ADSR geometry in a 200x110 viewBox. Each stage owns a fixed slot so a handle
// can only move inside its own slot and the shape never overlaps itself.
export const ADSR_GEOMETRY = { left: 10, slot: 45, top: 10, bottom: 100, holdEnd: 145 };

/** Points of the envelope outline for stage fractions in 0..1. */
export function adsrPoints({ a, d, s, r }) {
    const g = ADSR_GEOMETRY;
    const sy = g.bottom - s * (g.bottom - g.top);
    return {
        start: [g.left, g.bottom],
        peak: [g.left + a * g.slot, g.top],
        sustain: [g.left + g.slot + d * g.slot, sy],
        hold: [g.holdEnd, sy],
        end: [g.holdEnd + r * g.slot, g.bottom],
    };
}

function svg(tag, attrs = {}) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
}

function makeFrame(title, readoutText) {
    const wrap = document.createElement('div');
    wrap.className = 'synth-widget';
    const head = document.createElement('div');
    head.className = 'synth-widget-head';
    const name = document.createElement('span');
    name.textContent = title;
    const readout = document.createElement('output');
    head.appendChild(name);
    head.appendChild(readout);
    readout.textContent = readoutText;
    wrap.appendChild(head);
    return { wrap, readout };
}

/** Make `surface` draggable; `onMove(fx, fy)` gets 0..1 fractions (y up). */
function dragSurface(surface, element, onMove) {
    let id = null;
    const move = event => {
        const box = element.getBoundingClientRect();
        if (!box.width || !box.height) return;
        onMove(clamp01((event.clientX - box.left) / box.width), clamp01(1 - (event.clientY - box.top) / box.height));
    };
    surface.addEventListener('pointerdown', event => {
        if (event.button !== 0 || id !== null) return;
        event.preventDefault();
        id = event.pointerId;
        surface.setPointerCapture(id);
        move(event);
    });
    surface.addEventListener('pointermove', event => { if (event.pointerId === id) move(event); });
    const end = event => {
        if (event.pointerId !== id) return;
        if (surface.hasPointerCapture(id)) surface.releasePointerCapture(id);
        id = null;
    };
    surface.addEventListener('pointerup', end);
    surface.addEventListener('pointercancel', end);
    surface.addEventListener('lostpointercapture', () => { id = null; });
}

function initial(def, saved) {
    const v = Number(saved ?? def.default ?? def.min ?? 0);
    return Number.isFinite(v) ? v : 0;
}

/** Cutoff on X, resonance on Y, with a dot at the current position. */
export function createXYPad(plan, send, saved = () => undefined) {
    const { x: xDef, y: yDef } = plan;
    const { wrap, readout } = makeFrame(`${xDef.name} / ${yDef.name}`, '');
    const state = { x: initial(xDef, saved(xDef)), y: initial(yDef, saved(yDef)) };
    const pad = svg('svg', { viewBox: '0 0 200 140', class: 'synth-xy', role: 'application', tabindex: '0',
        'aria-label': `${xDef.name} (horizontal) and ${yDef.name} (vertical)` });
    for (let i = 1; i < 4; i++) {
        pad.appendChild(svg('line', { x1: i * 50, y1: 0, x2: i * 50, y2: 140, class: 'synth-grid' }));
        pad.appendChild(svg('line', { x1: 0, y1: i * 35, x2: 200, y2: i * 35, class: 'synth-grid' }));
    }
    const hLine = svg('line', { class: 'synth-cross' });
    const vLine = svg('line', { class: 'synth-cross' });
    const dot = svg('circle', { r: 7, class: 'synth-dot' });
    pad.appendChild(hLine);
    pad.appendChild(vLine);
    pad.appendChild(dot);
    wrap.appendChild(pad);

    const draw = () => {
        const px = toFraction(state.x, xDef) * 200;
        const py = (1 - toFraction(state.y, yDef)) * 140;
        dot.setAttribute('cx', px); dot.setAttribute('cy', py);
        hLine.setAttribute('x1', 0); hLine.setAttribute('x2', 200); hLine.setAttribute('y1', py); hLine.setAttribute('y2', py);
        vLine.setAttribute('y1', 0); vLine.setAttribute('y2', 140); vLine.setAttribute('x1', px); vLine.setAttribute('x2', px);
        readout.textContent = `${state.x} / ${state.y}`;
    };
    const set = (xv, yv) => {
        if (xv !== state.x) { state.x = xv; send(xDef, xv); }
        if (yv !== state.y) { state.y = yv; send(yDef, yv); }
        draw();
    };
    dragSurface(pad, pad, (fx, fy) => set(toValue(fx, xDef), toValue(fy, yDef)));
    pad.addEventListener('keydown', event => {
        const step = event.shiftKey ? 1 : 8;
        const move = { ArrowRight: [step, 0], ArrowLeft: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[event.key];
        if (!move) return;
        event.preventDefault();
        const lim = (v, def) => Math.max(Number(def.min ?? 0), Math.min(Number(def.max ?? 127), v));
        set(lim(state.x + move[0], xDef), lim(state.y + move[1], yDef));
    });
    draw();
    return wrap;
}

/** Standard ADSR graph; missing stages are drawn at a fixed default. */
export function createAdsrGraph(plan, send, saved = () => undefined) {
    const defs = { a: plan.a, d: plan.d, s: plan.s, r: plan.r };
    const fixed = { a: 0.15, d: 0.3, s: 0.6, r: 0.3 };
    const title = ['A', 'D', 'S', 'R'].filter((_, i) => Object.values(defs)[i]).join('·');
    const { wrap, readout } = makeFrame(`Envelope ${title}`, '');
    const state = {};
    for (const k of Object.keys(defs)) state[k] = defs[k] ? toFraction(initial(defs[k], saved(defs[k])), defs[k]) : fixed[k];

    const g = ADSR_GEOMETRY;
    const graph = svg('svg', { viewBox: '0 0 200 110', class: 'synth-adsr', role: 'application', tabindex: '0',
        'aria-label': `Envelope ${title}` });
    const fill = svg('polygon', { class: 'synth-adsr-fill' });
    const line = svg('polyline', { class: 'synth-adsr-line' });
    graph.appendChild(fill);
    graph.appendChild(line);
    const handles = {};
    const handle = (key) => {
        const h = svg('circle', { r: 6, class: 'synth-dot' + (defs[key] ? '' : ' fixed') });
        handles[key] = h;
        graph.appendChild(h);
    };
    ['a', 'd', 'r'].forEach(handle);

    const draw = () => {
        const p = adsrPoints(state);
        const list = [p.start, p.peak, p.sustain, p.hold, p.end];
        line.setAttribute('points', list.map(q => q.join(',')).join(' '));
        fill.setAttribute('points', list.concat([[p.end[0], g.bottom]]).map(q => q.join(',')).join(' '));
        handles.a.setAttribute('cx', p.peak[0]); handles.a.setAttribute('cy', p.peak[1]);
        handles.d.setAttribute('cx', p.sustain[0]); handles.d.setAttribute('cy', p.sustain[1]);
        handles.r.setAttribute('cx', p.end[0]); handles.r.setAttribute('cy', p.end[1]);
        readout.textContent = ['a', 'd', 's', 'r'].filter(k => defs[k])
            .map(k => `${k.toUpperCase()} ${toValue(state[k], defs[k])}`).join('  ');
    };
    const setStage = (key, fraction) => {
        if (!defs[key]) return;
        const before = toValue(state[key], defs[key]);
        const value = toValue(fraction, defs[key]);
        state[key] = toFraction(value, defs[key]);
        if (value !== before) send(defs[key], value);
    };

    // The nearest handle (in its own slot) is grabbed on pointer-down.
    let active = null;
    const drag = (fx, fy) => {
        if (!active) return;
        const xUnits = fx * 200;
        if (active === 'a') setStage('a', (xUnits - g.left) / g.slot);
        if (active === 'd') {
            setStage('d', (xUnits - g.left - g.slot) / g.slot);
            setStage('s', (g.bottom - (1 - fy) * 110) / (g.bottom - g.top));
        }
        if (active === 'r') setStage('r', (xUnits - g.holdEnd) / g.slot);
        draw();
    };
    graph.addEventListener('pointerdown', event => {
        const box = graph.getBoundingClientRect();
        if (event.button !== 0 || !box.width) return;
        const ux = (event.clientX - box.left) / box.width * 200;
        const p = adsrPoints(state);
        const pick = [['a', p.peak], ['d', p.sustain], ['r', p.end]].filter(([k]) => defs[k] || (k === 'd' && defs.s))
            .map(([k, pt]) => [k, Math.abs(pt[0] - ux)]).sort((m, n) => m[1] - n[1])[0];
        active = pick ? pick[0] : null;
    }, true);
    dragSurface(graph, graph, drag);
    graph.addEventListener('pointerup', () => { active = null; });
    graph.addEventListener('pointercancel', () => { active = null; });
    graph.addEventListener('keydown', event => {
        const step = (event.shiftKey ? 1 : 8) / 127;
        const k = { ArrowRight: ['a', step], ArrowLeft: ['a', -step], ArrowUp: ['s', step], ArrowDown: ['s', -step] }[event.key];
        if (!k) return;
        event.preventDefault();
        setStage(k[0], state[k[0]] + k[1]);
        draw();
    });
    wrap.appendChild(graph);
    draw();
    return wrap;
}
