// Graphical controls for NRPN parameters, in the parameter's own units (seconds, -1..1, Hz ...):
// triangle envelopes (attack moves the apex, release the end), an LFO plot (frequency, bias, phase, shape),
// and a pad with dots (mixer: pan across, level up; filter: two parameters). Detection is by control name,
// so only maps that name their controls like the PreenFM2 get them.
//
// `io` is { get(def) -> value in the parameter's units or undefined, set(def, value) } supplied by the
// device manager, which owns sending NRPN and remembering values.

const NS = 'http://www.w3.org/2000/svg';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clamp01 = v => clamp(v, 0, 1);

function svg(tag, attrs = {}) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
}

function html(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

/** The parameter's range and step, from the control definition's NRPN fields. */
function span(def) {
    const min = Number(def.nrpnMin), max = Number(def.nrpnMax), scale = Number(def.nrpnScale) || 0;
    return { min, max, step: scale ? 1 / scale : 1 };
}
const snap = (def, value) => {
    const { min, max, step } = span(def);
    return Number((Math.round((clamp(value, min, max) - min) / step) * step + min).toFixed(4));
};
const fmt = (def, value) => {
    const { step } = span(def);
    return value.toFixed(step < 1 ? 2 : 0);
};
// A parameter nothing has set yet shows at its minimum, or at the middle when it runs below zero (pan, bias).
const read = (io, def) => {
    const value = io.get(def);
    const { min } = span(def);
    return Number.isFinite(value) ? value : min < 0 ? 0 : min;
};

/** Pointer drag on `target` that reports the pointer as 0..1 fractions of `box` (y up); `begin` may refuse. */
function drag(target, box, wrap, { begin, move, end }) {
    let id = null;
    const fractions = event => {
        const rect = box.getBoundingClientRect();
        return rect.width && rect.height
            ? [clamp01((event.clientX - rect.left) / rect.width), clamp01(1 - (event.clientY - rect.top) / rect.height)]
            : null;
    };
    target.addEventListener('pointerdown', event => {
        if (event.button !== 0 || id !== null) return;
        const f = fractions(event);
        if (!f || begin(f, event) === false) return;
        event.preventDefault();
        id = event.pointerId;
        wrap.dataset.dragging = '1';
        target.setPointerCapture(id);
        move(f, event);
    });
    target.addEventListener('pointermove', event => {
        if (event.pointerId !== id) return;
        const f = fractions(event);
        if (f) move(f, event);
    });
    const stop = event => {
        if (event.pointerId !== id) return;
        if (target.hasPointerCapture(id)) target.releasePointerCapture(id);
        id = null;
        delete wrap.dataset.dragging;
        end?.();
    };
    target.addEventListener('pointerup', stop);
    target.addEventListener('pointercancel', stop);
    target.addEventListener('lostpointercapture', () => { id = null; delete wrap.dataset.dragging; });
}

/** Wrapper that listens for `widget-sync` (new values from outside, nothing is sent) unless a drag is under way. */
function makeWrap(title, defs, redraw) {
    const wrap = html('div', 'synth-widget nrpn-widget');
    // "cc:nrpn" pairs let the device manager find this widget when one of its parameters changes remotely.
    wrap.dataset.pairs = defs.map(def => `${def.cc}:${def.nrpn}`).join(' ');
    const head = html('div', 'synth-widget-head');
    head.appendChild(html('span', '', title));
    wrap.appendChild(head);
    wrap.addEventListener('widget-sync', () => { if (!wrap.dataset.dragging) redraw(); });
    return { wrap, head };
}

/** Pick the controls a module can draw with these widgets. `keep` are named alike but stay knobs. */
export function planNrpnWidgets(controls) {
    const byName = new Map(controls.filter(c => c.nrpn !== undefined).map(c => [c.name, c]));
    const widgets = [], used = new Set();
    const take = (...names) => {
        const found = names.map(name => byName.get(name));
        return found.every(Boolean) ? found : null;
    };
    const mark = list => list.forEach(c => used.add(c));

    const envelopes = [];
    for (let n = 1; n <= 6; n++) {
        const pair = take(`Op ${n} Env Attack`, `Op ${n} Env Release`);
        if (pair) { envelopes.push({ n, attack: pair[0], release: pair[1] }); mark(pair); }
    }
    if (envelopes.length) widgets.push({ kind: 'env-triangles', items: envelopes });
    // "Carrier Env Attack (all)" and its release set every carrier at once: they stay knobs next to the graphs.
    const keep = envelopes.length ? controls.filter(c => /^Carrier Env/i.test(c.name || '')) : [];

    const dots = [];
    for (let n = 1; n <= 4; n++) {
        const pair = take(`Mix ${n}`, `Pan ${n}`);
        if (pair) { dots.push({ label: String(n), color: DOT_COLORS[n - 1], x: pair[1], y: pair[0] }); mark(pair); }
    }
    if (dots.length) widgets.push({ kind: 'dot-field', title: 'Mixer · pan across, level up', xLabels: ['L', 'R'], yLabel: 'Mix', dots, center: true });

    const filter = take('Filter Param 1', 'Filter Param 2');
    if (filter) {
        widgets.push({ kind: 'dot-field', title: 'Filter · Param 1 across, Param 2 up', xLabels: ['Param 1', ''], yLabel: 'Param 2', dots: [{ label: '', color: DOT_COLORS[0], x: filter[0], y: filter[1] }] });
        mark(filter);
    }

    const lfos = [];
    for (let n = 1; n <= 3; n++) {
        const set = take(`LFO ${n} Frequency`, `LFO ${n} Phase`, `LFO ${n} Bias`, `LFO ${n} Shape`);
        if (set) { lfos.push({ n, freq: set[0], phase: set[1], bias: set[2], shape: set[3] }); mark(set); }
    }
    if (lfos.length) widgets.push({ kind: 'lfo-plots', items: lfos });

    return { widgets, used, keep };
}

const DOT_COLORS = ['#4cc9f0', '#f72585', '#ffd60a', '#80ed99'];

/** Triangles: attack moves the apex sideways, release the far end. One small graph per operator. */
export function createEnvelopeTriangles(plan, io) {
    const defs = plan.items.flatMap(item => [item.attack, item.release]);
    const redraws = [];
    const { wrap } = makeWrap('Operator envelopes · drag the apex for attack, the end for release', defs, () => redraws.forEach(fn => fn()));
    const grid = html('div', 'nrpn-env-grid');
    wrap.appendChild(grid);

    const W = 200, H = 84, left = 8, mid = 100, right = 192, top = 8, bottom = 70;
    // Times are bent so short values get more room: value = max * fraction^3.
    const toValue = (def, f) => snap(def, span(def).max * f * f * f);
    const toFraction = (def, v) => Math.cbrt(clamp01(v / span(def).max));

    for (const item of plan.items) {
        const cell = html('div', 'nrpn-env-cell');
        const graph = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'synth-adsr nrpn-env', role: 'application',
            'aria-label': `Operator ${item.n} envelope: attack and release` });
        const fill = svg('polygon', { class: 'synth-adsr-fill' });
        const line = svg('polyline', { class: 'synth-adsr-line' });
        const apex = svg('circle', { r: 6, class: 'synth-dot' });
        const tail = svg('circle', { r: 6, class: 'synth-dot' });
        const label = svg('text', { x: 6, y: 80, class: 'nrpn-env-label' });
        label.textContent = `Op ${item.n}`;
        graph.append(fill, line, apex, tail, label);
        const readout = html('output', 'nrpn-env-readout');
        cell.append(graph, readout);
        grid.appendChild(cell);

        const state = { a: 0, r: 0 };
        const draw = () => {
            const ax = left + toFraction(item.attack, state.a) * (mid - left);
            const rx = mid + toFraction(item.release, state.r) * (right - mid);
            const points = [[left, bottom], [ax, top], [rx, bottom]];
            line.setAttribute('points', points.map(p => p.join(',')).join(' '));
            fill.setAttribute('points', points.map(p => p.join(',')).join(' '));
            apex.setAttribute('cx', ax); apex.setAttribute('cy', top);
            tail.setAttribute('cx', rx); tail.setAttribute('cy', bottom);
            readout.textContent = `A ${fmt(item.attack, state.a)} · R ${fmt(item.release, state.r)}`;
        };
        const load = () => { state.a = read(io, item.attack); state.r = read(io, item.release); draw(); };
        redraws.push(load);
        const setValue = (key, def, value) => {
            if (value === state[key]) return;
            state[key] = value;
            io.set(def, value);
            draw();
        };
        let grabbed = null;
        drag(graph, graph, wrap, {
            begin: (f, event) => {
                const rect = graph.getBoundingClientRect();
                const ux = f[0] * W, uy = (1 - f[1]) * H;
                const ax = left + toFraction(item.attack, state.a) * (mid - left);
                const rx = mid + toFraction(item.release, state.r) * (right - mid);
                grabbed = Math.hypot(ux - ax, uy - top) <= Math.hypot(ux - rx, uy - bottom) ? 'a' : 'r';
                return rect.width > 0;
            },
            move: f => {
                const ux = f[0] * W;
                if (grabbed === 'a') setValue('a', item.attack, toValue(item.attack, clamp01((ux - left) / (mid - left))));
                else setValue('r', item.release, toValue(item.release, clamp01((ux - mid) / (right - mid))));
            },
        });
        graph.tabIndex = 0;
        graph.addEventListener('keydown', event => {
            const key = { ArrowRight: ['a', 1], ArrowLeft: ['a', -1], ArrowUp: ['r', 1], ArrowDown: ['r', -1] }[event.key];
            if (!key) return;
            event.preventDefault();
            const def = key[0] === 'a' ? item.attack : item.release;
            const f = toFraction(def, state[key[0]]) + key[1] * (event.shiftKey ? 0.01 : 0.05);
            setValue(key[0], def, toValue(def, clamp01(f)));
        });
    }
    redraws.forEach(fn => fn());
    return wrap;
}

/** One field with a dot per pair of parameters: x and y are each dot's two parameters (mixer: pan, level). */
export function createDotField(plan, io) {
    const defs = plan.dots.flatMap(dot => [dot.x, dot.y]);
    let draw = () => {};
    const { wrap } = makeWrap(plan.title, defs, () => draw());
    const W = 220, H = 150, pad = 14;
    const graph = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'synth-xy nrpn-field', role: 'application', tabindex: '0',
        'aria-label': plan.title });
    for (let i = 1; i < 4; i++) {
        graph.appendChild(svg('line', { x1: pad + i * (W - 2 * pad) / 4, y1: pad, x2: pad + i * (W - 2 * pad) / 4, y2: H - pad, class: 'synth-grid' }));
        graph.appendChild(svg('line', { x1: pad, y1: pad + i * (H - 2 * pad) / 4, x2: W - pad, y2: pad + i * (H - 2 * pad) / 4, class: 'synth-grid' }));
    }
    if (plan.center) graph.appendChild(svg('line', { x1: W / 2, y1: pad, x2: W / 2, y2: H - pad, class: 'synth-cross' }));
    const mark = (x, y, text, anchor) => {
        const label = svg('text', { x, y, class: 'nrpn-field-label', 'text-anchor': anchor });
        label.textContent = text;
        graph.appendChild(label);
    };
    mark(pad, H - 2, plan.xLabels[0], 'start');
    mark(W - pad, H - 2, plan.xLabels[1], 'end');
    mark(2, pad + 4, plan.yLabel, 'start');

    const dots = plan.dots.map(dot => {
        const circle = svg('circle', { r: 10, class: 'nrpn-dot', fill: dot.color });
        const text = svg('text', { class: 'nrpn-dot-label', 'text-anchor': 'middle' });
        text.textContent = dot.label;
        graph.append(circle, text);
        return { ...dot, circle, text, vx: 0, vy: 0 };
    });
    const px = (def, v) => pad + clamp01((v - span(def).min) / (span(def).max - span(def).min)) * (W - 2 * pad);
    const py = (def, v) => H - pad - clamp01((v - span(def).min) / (span(def).max - span(def).min)) * (H - 2 * pad);
    wrap.appendChild(graph);
    const legend = html('div', 'nrpn-legend');
    const legendItems = dots.map(dot => {
        const item = html('span', 'nrpn-legend-item');
        item.style.setProperty('--dot', dot.color);
        legend.appendChild(item);
        return item;
    });
    wrap.appendChild(legend);

    draw = () => {
        dots.forEach((dot, i) => {
            dot.vx = read(io, dot.x); dot.vy = read(io, dot.y);
            const cx = px(dot.x, dot.vx), cy = py(dot.y, dot.vy);
            dot.circle.setAttribute('cx', cx); dot.circle.setAttribute('cy', cy);
            dot.text.setAttribute('x', cx); dot.text.setAttribute('y', cy + 3.5);
            const name = dot.label ? `${dot.label} · ` : '';
            legendItems[i].textContent = `${name}${fmt(dot.x, dot.vx)} / ${fmt(dot.y, dot.vy)}`;
        });
    };
    const refresh = dot => {
        const cx = px(dot.x, dot.vx), cy = py(dot.y, dot.vy);
        dot.circle.setAttribute('cx', cx); dot.circle.setAttribute('cy', cy);
        dot.text.setAttribute('x', cx); dot.text.setAttribute('y', cy + 3.5);
        legendItems[dots.indexOf(dot)].textContent = `${dot.label ? `${dot.label} · ` : ''}${fmt(dot.x, dot.vx)} / ${fmt(dot.y, dot.vy)}`;
    };
    let held = null;
    const setDot = (dot, vx, vy) => {
        if (vx !== dot.vx) { dot.vx = vx; io.set(dot.x, vx); }
        if (vy !== dot.vy) { dot.vy = vy; io.set(dot.y, vy); }
        refresh(dot);
    };
    const valueAt = (def, fraction) => snap(def, span(def).min + clamp01(fraction) * (span(def).max - span(def).min));
    drag(graph, graph, wrap, {
        begin: f => {
            const ux = f[0] * W, uy = (1 - f[1]) * H;
            held = dots.reduce((best, dot) => {
                const d = Math.hypot(ux - px(dot.x, dot.vx), uy - py(dot.y, dot.vy));
                return !best || d <= best.d ? { dot, d } : best;   // a later dot wins a tie, so stacked dots can be separated
            }, null)?.dot;
            return !!held;
        },
        move: f => {
            const ux = f[0] * W, uy = (1 - f[1]) * H;
            setDot(held, valueAt(held.x, (ux - pad) / (W - 2 * pad)), valueAt(held.y, 1 - (uy - pad) / (H - 2 * pad)));
        },
    });
    graph.addEventListener('keydown', event => {
        const dot = held || dots[0];
        const move = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key];
        if (!move || !dot) return;
        event.preventDefault();
        const bump = (def, dir) => snap(def, dot[def === dot.x ? 'vx' : 'vy'] + dir * (span(def).max - span(def).min) * (event.shiftKey ? 0.01 : 0.05));
        setDot(dot, move[0] ? bump(dot.x, move[0]) : dot.vx, move[1] ? bump(dot.y, move[1]) : dot.vy);
    });
    draw();
    return wrap;
}

const SHAPE_NAMES = ['Sine', 'Saw', 'Triangle', 'Square', 'Random'];
const SHAPE_GLYPHS = ['∿', '◿', '△', '⊓', '⁝'];

// One LFO sample for a phase in cycles; Random is a fixed pseudo-random staircase so the plot does not flicker.
function lfoSample(shape, cycles) {
    const t = cycles - Math.floor(cycles);
    switch (shape) {
        case 0: return Math.sin(2 * Math.PI * t);
        case 1: return 2 * t - 1;
        case 2: return t < 0.5 ? 4 * t - 1 : 3 - 4 * t;
        case 3: return t < 0.5 ? 1 : -1;
        default: {
            const k = Math.floor(cycles * 4);
            return ((Math.sin(k * 127.1 + 311.7) * 43758.5453) % 1 + 1) % 1 * 2 - 1;
        }
    }
}

/** LFO plots: drag in the plot (across = frequency, up/down = bias), the strip below sets phase, buttons set shape. */
export function createLfoPlots(plan, io) {
    const defs = plan.items.flatMap(item => [item.freq, item.phase, item.bias, item.shape]);
    const redraws = [];
    const { wrap } = makeWrap('LFOs · drag the plot for frequency and bias, the strip for phase', defs, () => redraws.forEach(fn => fn()));
    const grid = html('div', 'nrpn-lfo-grid');
    wrap.appendChild(grid);

    const W = 220, left = 8, right = 212, top = 8, bottom = 74, stripY = 90, H = 104;
    const FREE_MAX = 99.9;   // above this the LFO follows the MIDI clock, which the plot does not model
    const freqToFraction = f => Math.cbrt(clamp01(f / FREE_MAX));
    const freqFromFraction = x => x * x * x * FREE_MAX;

    for (const item of plan.items) {
        const cell = html('div', 'nrpn-lfo-cell');
        const graph = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'synth-xy nrpn-lfo', role: 'application', tabindex: '0',
            'aria-label': `LFO ${item.n}: frequency across, bias up and down` });
        const midY = (top + bottom) / 2;
        const frame = svg('rect', { x: left, y: top, width: right - left, height: bottom - top, class: 'nrpn-lfo-frame' });
        const zero = svg('line', { x1: left, y1: midY, x2: right, y2: midY, class: 'synth-cross' });
        const curve = svg('polyline', { class: 'synth-adsr-line' });
        const dot = svg('circle', { r: 6, class: 'synth-dot' });
        const track = svg('line', { x1: left, y1: stripY, x2: right, y2: stripY, class: 'nrpn-lfo-track' });
        const marker = svg('circle', { r: 6, cy: stripY, class: 'synth-dot' });
        const title = svg('text', { x: left + 2, y: top + 9, class: 'nrpn-env-label' });
        title.textContent = `LFO ${item.n}`;
        graph.append(frame, zero, curve, dot, track, marker, title);
        const buttons = html('div', 'nrpn-lfo-shapes');
        const shapeButtons = SHAPE_NAMES.map((name, shape) => {
            const button = html('button', 'nrpn-lfo-shape', SHAPE_GLYPHS[shape]);
            button.type = 'button';
            button.title = name;
            button.setAttribute('aria-label', `LFO ${item.n} shape ${name}`);
            button.addEventListener('click', () => {
                state.shape = shape;
                io.set(item.shape, shape);
                draw();
            });
            buttons.appendChild(button);
            return button;
        });
        const readout = html('output', 'nrpn-env-readout');
        cell.append(graph, buttons, readout);
        grid.appendChild(cell);

        const state = { freq: 0, phase: 0, bias: 0, shape: 0 };
        const draw = () => {
            const xf = freqToFraction(state.freq);
            const cycles = 0.5 + xf * 7;
            const amp = (bottom - top) / 2 * 0.92;
            const points = [];
            for (let i = 0; i <= 160; i++) {
                const u = i / 160;
                // The plot shows the wave around its bias line; it is a picture, not the exact output level.
                const v = clamp(state.bias + lfoSample(state.shape, u * cycles + state.phase) * (1 - Math.abs(state.bias)), -1, 1);
                points.push(`${(left + u * (right - left)).toFixed(1)},${(midY - v * amp).toFixed(1)}`);
            }
            curve.setAttribute('points', points.join(' '));
            dot.setAttribute('cx', left + xf * (right - left));
            dot.setAttribute('cy', midY - clamp(state.bias, -1, 1) * (bottom - top) / 2);
            marker.setAttribute('cx', left + state.phase * (right - left));
            shapeButtons.forEach((button, shape) => button.setAttribute('aria-pressed', String(shape === state.shape)));
            const hz = state.freq > FREE_MAX ? 'sync' : `${state.freq.toFixed(2)} Hz`;
            readout.textContent = `${hz} · φ ${state.phase.toFixed(2)} · bias ${state.bias >= 0 ? '+' : ''}${state.bias.toFixed(2)}`;
        };
        const load = () => {
            state.freq = read(io, item.freq); state.phase = read(io, item.phase);
            state.bias = read(io, item.bias); state.shape = clamp(Math.round(read(io, item.shape)), 0, 4);
            draw();
        };
        redraws.push(load);
        const change = (key, def, value) => {
            if (value === state[key]) return;
            state[key] = value;
            io.set(def, value);
            draw();
        };
        let strip = false;
        drag(graph, graph, wrap, {
            begin: f => { strip = (1 - f[1]) * H > (bottom + stripY) / 2; return true; },
            move: f => {
                if (strip) { change('phase', item.phase, snap(item.phase, clamp01((f[0] * W - left) / (right - left)))); return; }
                const xf = clamp01((f[0] * W - left) / (right - left));
                change('freq', item.freq, snap(item.freq, freqFromFraction(xf)));
                const yf = clamp01(((1 - f[1]) * H - top) / (bottom - top));
                change('bias', item.bias, snap(item.bias, 1 - 2 * yf));
            },
        });
        graph.addEventListener('keydown', event => {
            const move = { ArrowRight: ['freq', 1], ArrowLeft: ['freq', -1], ArrowUp: ['bias', 1], ArrowDown: ['bias', -1] }[event.key];
            if (!move) return;
            event.preventDefault();
            const big = event.shiftKey ? 0.01 : 0.05;
            if (move[0] === 'freq') change('freq', item.freq, snap(item.freq, freqFromFraction(clamp01(freqToFraction(state.freq) + move[1] * big))));
            else change('bias', item.bias, snap(item.bias, state.bias + move[1] * big * 2));
        });
    }
    redraws.forEach(fn => fn());
    return wrap;
}

/** Build the widget a plan describes. */
export function createNrpnWidget(plan, io) {
    if (plan.kind === 'env-triangles') return createEnvelopeTriangles(plan, io);
    if (plan.kind === 'lfo-plots') return createLfoPlots(plan, io);
    return createDotField(plan, io);
}
