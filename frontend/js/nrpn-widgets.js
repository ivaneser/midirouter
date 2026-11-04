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

/** The parameter's range and step, from the control definition's NRPN fields (a CC-only control: its CC range). */
function span(def) {
    const min = Number(def.nrpnMin ?? def.min ?? 0), max = Number(def.nrpnMax ?? def.max ?? 127), scale = Number(def.nrpnScale) || 0;
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
    wrap.dataset.pairs = defs.map(def => `${def.cc ?? ''}:${def.nrpn ?? ''}`).join(' ');
    let head = null;
    if (title) {
        head = html('div', 'synth-widget-head');
        head.appendChild(html('span', '', title));
        wrap.appendChild(head);
    }
    wrap.addEventListener('widget-sync', () => { if (!wrap.dataset.dragging) redraw(); });
    return { wrap, head };
}

/** Pick the controls a module can draw with these widgets. `algorithms` is the device's algorithm list, for the picker. */
export function planNrpnWidgets(controls, algorithms, nrpnParams = [], algorithmDef = null) {
    const byName = new Map(controls.map(c => [c.name, c]));
    const widgets = [], used = new Set();
    const take = (...names) => {
        const found = names.map(name => byName.get(name));
        return found.every(c => c && c.nrpn !== undefined) ? found : null;
    };
    const mark = list => list.forEach(c => used.add(c));

    const algorithm = take('Algorithm');
    if (algorithm && algorithms?.length) { widgets.push({ kind: 'algorithms', def: algorithm[0], algorithms }); mark(algorithm); }

    // One triangle per operator, with its frequency as the dot in the middle.
    const operators = [];
    for (let n = 1; n <= 6; n++) {
        const pair = take(`Op ${n} Env Attack`, `Op ${n} Env Release`);
        if (!pair) continue;
        const freq = take(`Op ${n} Frequency`);
        operators.push({ n, label: `Op ${n}`, attack: pair[0], release: pair[1], freq: freq?.[0] });
        mark(pair); if (freq) mark(freq);
    }
    if (operators.length) widgets.push({ kind: 'env-triangles', role: 'operators', title: 'Operators · apex = attack, end = release, middle dot = frequency', items: operators,
        // With these the names of the operators that are carriers in the current algorithm are filled in.
        ...(algorithmDef && algorithms?.length ? { algorithmDef, algorithms } : {}) });

    // The carriers' shared envelope has no NRPN: it is two CCs.
    const carrier = ['Carrier Env Attack (all)', 'Carrier Env Release (all)'].map(name => byName.get(name));
    if (carrier.every(Boolean)) {
        widgets.push({ kind: 'env-triangles', role: 'carriers', title: 'Carriers · apex = attack, end = release', items: [{ label: 'All carriers', attack: carrier[0], release: carrier[1] }] });
        mark(carrier);
    }

    // The modulation matrix: the knobs are the rows' multipliers, source and destinations are NRPN-only choices.
    const choice = new Map(nrpnParams.map(c => [c.name, c]));
    const rows = [];
    for (let n = 1; n <= 4; n++) {
        const amount = take(`Matrix Row ${n} Amount`)?.[0];
        const source = choice.get(`Matrix ${n} Source`), dest1 = choice.get(`Matrix ${n} Destination 1`), dest2 = choice.get(`Matrix ${n} Destination 2`);
        if (amount && source && dest1) rows.push({ n, amount, source, dest1, dest2 });
    }
    if (rows.length) { widgets.push({ kind: 'matrix', rows }); rows.forEach(row => mark([row.amount])); }

    // Arpeggiator: the clock / tempo / octaves / latch row, then the direction and pattern pickers.
    const clock = take('Arp Clock')?.[0], octave = take('Arp Octave')?.[0], bpm = choice.get('Arp BPM'), latch = choice.get('Arp Latch');
    if (clock) {
        widgets.push({ kind: 'arp-main', clock, bpm, octave, latch });
        mark([clock, octave].filter(Boolean));
    }
    const direction = take('Arp Direction');
    if (direction) { widgets.push({ kind: 'arp-directions', def: direction[0] }); mark(direction); }

    const division = take('Arp Division');
    if (division) { widgets.push({ kind: 'note-values', def: division[0], label: 'Division' }); mark(division); }
    const duration = take('Arp Duration');
    if (duration) {
        widgets.push({ kind: 'note-values', def: duration[0], label: 'Duration' });
        mark(duration);
    }

    const arp = take('Arp Pattern');
    if (arp) { widgets.push({ kind: 'arp-patterns', def: arp[0] }); mark(arp); }

    const dots = [];
    for (let n = 1; n <= 4; n++) {
        const pair = take(`Mix ${n}`, `Pan ${n}`);
        if (pair) { dots.push({ label: String(n), color: DOT_COLORS[n - 1], x: pair[1], y: pair[0] }); mark(pair); }
    }
    if (dots.length) widgets.push({ kind: 'dot-field', title: 'Mixer: pan across, level up', dots, center: true });

    const filter = take('Filter Param 1', 'Filter Param 2');
    if (filter) {
        const gain = take('Filter Gain'), type = take('Filter Type');
        widgets.push({ kind: 'filter',
            pad: { kind: 'dot-field', title: 'Filter: first parameter across, second up', dots: [{ label: '', color: DOT_COLORS[0], x: filter[0], y: filter[1] }] },
            gain: gain?.[0], type: type?.[0] });
        mark(filter); if (gain) mark(gain); if (type) mark(type);
    }

    const lfos = [];
    for (let n = 1; n <= 3; n++) {
        const set = take(`LFO ${n} Frequency`, `LFO ${n} Phase`, `LFO ${n} Bias`, `LFO ${n} Shape`);
        if (set) { lfos.push({ n, freq: set[0], phase: set[1], bias: set[2], shape: set[3] }); mark(set); }
    }
    if (lfos.length) widgets.push({ kind: 'lfo-plots', items: lfos });

    return { widgets, used };
}

const DOT_COLORS = ['#4cc9f0', '#f72585', '#ffd60a', '#80ed99'];

// Dragging an operator's frequency dot: on the middle line the value is pulled to whole ratios, and the further
// the pointer is above or below it, the weaker the pull and the finer the sideways movement. The pull fades out
// gradually: a flat zone right at the line, then a smooth fall to nothing.
export const FREQ_LOCK_RANGE = 6;     // distance from the middle line (graph units) within which values lock to whole ratios
export const FREQ_PULL_RANGE = 60;    // distance at which the pull is gone
export function freqPull(offset) {
    const t = clamp01((Math.abs(offset) - FREQ_LOCK_RANGE) / (FREQ_PULL_RANGE - FREQ_LOCK_RANGE));
    return 1 - t * t * (3 - 2 * t);
}
export const freqFineness = pull => 0.1 + 0.9 * pull;   // sideways movement scale: 1 on the line, 0.1 far from it
// A value d away from the nearest whole ratio is brought to d * (2|d|)^(4 * pull): nothing moves at pull 0, the
// values collapse onto the whole ratios as the pull nears 1, and halfway between two ratios the value is untouched,
// so the result is continuous and never jumps.
export function pullToIntegers(value, pull) {
    const whole = Math.round(value), distance = value - whole;
    if (pull >= 0.985) return whole;
    return whole + distance * Math.pow(2 * Math.abs(distance), 4 * pull);
}

/** Triangles: attack moves the apex sideways, release the far end, frequency (when there is one) the middle dot. */
export function createEnvelopeTriangles(plan, io) {
    const defs = plan.items.flatMap(item => [item.attack, item.release, item.freq].filter(Boolean));
    if (plan.algorithmDef) defs.push(plan.algorithmDef);   // an algorithm change from outside redraws the names too
    const redraws = [];
    const names = [];
    const { wrap } = makeWrap('', defs, () => redraws.forEach(fn => fn()));
    const grid = html('div', 'nrpn-env-grid');
    if (plan.role) grid.dataset.role = plan.role;
    wrap.appendChild(grid);

    const W = 200, H = 96, left = 8, mid = 100, right = 192, top = 8, bottom = 78, midY = (top + bottom) / 2;
    // Times are bent so short values get more room: value = max * fraction^3; frequencies: value = max * fraction^2.
    const timeValue = (def, f) => snap(def, span(def).max * f * f * f);
    const timeFraction = (def, v) => Math.cbrt(clamp01(v / span(def).max));
    const freqValue = (def, f) => snap(def, span(def).max * f * f);
    const freqFraction = (def, v) => Math.sqrt(clamp01(v / span(def).max));

    for (const item of plan.items) {
        const cell = html('div', 'nrpn-env-cell');
        if (item.n !== undefined) cell.dataset.op = String(item.n);
        const graph = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'synth-adsr nrpn-env', role: 'application', tabindex: '0',
            'aria-label': `${item.label} envelope: attack and release${item.freq ? ', frequency' : ''}` });
        const fill = svg('polygon', { class: 'synth-adsr-fill' });
        const line = svg('polyline', { class: 'synth-adsr-line' });
        const wave = svg('polyline', { class: 'nrpn-env-wave' });
        const apex = svg('circle', { r: 6, class: 'synth-dot' });
        const tail = svg('circle', { r: 6, class: 'synth-dot' });
        const pitch = svg('circle', { r: 6, class: 'synth-dot nrpn-freq-dot' });
        graph.append(fill, line);
        if (item.freq) graph.appendChild(wave);
        graph.append(apex, tail);
        if (item.freq) graph.appendChild(pitch);
        const readout = html('output', 'nrpn-env-readout');
        const name = html('div', 'nrpn-name', item.label);
        cell.append(graph, name, readout);
        names.push([item, name]);
        grid.appendChild(cell);

        const state = { a: 0, r: 0, f: 0 };
        const geometry = () => {
            const ax = left + timeFraction(item.attack, state.a) * (mid - left);
            // The release runs from the apex to the end of the graph, so a release of 0 ends right under the apex.
            const rx = ax + timeFraction(item.release, state.r) * (right - ax);
            const fx = item.freq ? left + freqFraction(item.freq, state.f) * (right - left) : 0;
            return { ax, rx, fx };
        };
        const draw = () => {
            const { ax, rx, fx } = geometry();
            const points = [[left, bottom], [ax, top], [rx, bottom]];
            line.setAttribute('points', points.map(q => q.join(',')).join(' '));
            fill.setAttribute('points', points.map(q => q.join(',')).join(' '));
            apex.setAttribute('cx', ax); apex.setAttribute('cy', top);
            tail.setAttribute('cx', rx); tail.setAttribute('cy', bottom);
            let text = `A ${fmt(item.attack, state.a)} · R ${fmt(item.release, state.r)}`;
            if (item.freq) {
                pitch.setAttribute('cx', fx); pitch.setAttribute('cy', midY);
                // A sine with as many cycles as the frequency ratio (kept visible between 0.5 and 16).
                const cycles = clamp(state.f, 0.5, 16);
                const samples = [];
                for (let i = 0; i <= 240; i++) {
                    const u = i / 240;
                    samples.push(`${(left + u * (right - left)).toFixed(1)},${(midY - Math.sin(2 * Math.PI * u * cycles) * 7).toFixed(1)}`);
                }
                wave.setAttribute('points', samples.join(' '));
                text += ` · F ${fmt(item.freq, state.f)}`;
            }
            readout.textContent = text;
        };
        const load = () => {
            state.a = read(io, item.attack); state.r = read(io, item.release);
            if (item.freq) state.f = read(io, item.freq);
            draw();
        };
        redraws.push(load);
        const setValue = (key, def, value) => {
            if (value === state[key]) return;
            state[key] = value;
            io.set(def, value);
            draw();
        };
        let grabbed = null, rawFreq = 0, lastUx = 0;
        drag(graph, graph, wrap, {
            begin: f => {
                const ux = f[0] * W, uy = (1 - f[1]) * H;
                const { ax, rx, fx } = geometry();
                const near = [['a', ax, top], ['r', rx, bottom], ...(item.freq ? [['f', fx, midY]] : [])]
                    .map(([key, x, y]) => [key, Math.hypot(ux - x, uy - y)]).sort((m, n) => m[1] - n[1]);
                grabbed = near[0][0];
                if (grabbed === 'f') { rawFreq = freqFraction(item.freq, state.f); lastUx = ux; }
                return true;
            },
            move: f => {
                const ux = f[0] * W;
                if (grabbed === 'a') setValue('a', item.attack, timeValue(item.attack, clamp01((ux - left) / (mid - left))));
                else if (grabbed === 'r') setValue('r', item.release, timeValue(item.release, clamp01((ux - geometry().ax) / (right - geometry().ax))));
                else {
                    // Relative movement, scaled by how close the pointer is to the middle line, then pulled to whole ratios.
                    const pull = freqPull((1 - f[1]) * H - midY);
                    rawFreq = clamp01(rawFreq + (ux - lastUx) / (right - left) * freqFineness(pull));
                    lastUx = ux;
                    setValue('f', item.freq, snap(item.freq, pullToIntegers(freqValue(item.freq, rawFreq), pull)));
                }
            },
        });
        graph.addEventListener('keydown', event => {
            const key = { ArrowRight: ['a', 1], ArrowLeft: ['a', -1], ArrowUp: ['r', 1], ArrowDown: ['r', -1] }[event.key];
            if (!key) return;
            event.preventDefault();
            const def = key[0] === 'a' ? item.attack : item.release;
            const f = timeFraction(def, state[key[0]]) + key[1] * (event.shiftKey ? 0.01 : 0.05);
            setValue(key[0], def, timeValue(def, clamp01(f)));
        });
    }
    // A carrier is heard: its name is filled in. Which operators those are depends on the current algorithm.
    const markCarriers = () => {
        const algorithm = plan.algorithmDef ? plan.algorithms[clamp(Math.round(read(io, plan.algorithmDef)), 0, plan.algorithms.length - 1)] : null;
        for (const [item, name] of names) {
            const carrier = !!algorithm && item.n !== undefined && algorithm.carriers.includes(item.n);
            name.classList.toggle('carrier', carrier);
            name.title = carrier ? `${item.label} is a carrier in this algorithm` : '';
        }
        // Carriers move to the Carriers group (before its shared "All carriers" graph), modulators stay in this one.
        const carriers = wrap.closest?.('.synth-controls')?.querySelector('.nrpn-env-grid[data-role="carriers"]');
        if (carriers && algorithm) {
            const shared = carriers.querySelector(':scope > .nrpn-env-cell:not([data-op])');
            for (const [item, name] of names) {
                const cell = name.closest('.nrpn-env-cell');
                if (!cell) continue;
                if (item.n !== undefined && algorithm.carriers.includes(item.n)) { if (cell.parentElement !== carriers) carriers.insertBefore(cell, shared); }
                else if (cell.parentElement !== grid) grid.appendChild(cell);
            }
            // Keep each group in operator order.
            const order = cell => Number(cell.dataset.op ?? 99);
            for (const box of [grid, carriers]) [...box.children].filter(c => order(c) !== 99).sort((a, b) => order(a) - order(b)).forEach(c => box.insertBefore(c, box === carriers ? shared : null));
        }
        // Operators beyond the algorithm's count and modulation indexes it does not use do nothing: switch them off.
        for (const [item, name] of names) {
            const idle = !!algorithm && item.n !== undefined && item.n > algorithm.operators;
            name.closest('.nrpn-env-cell')?.classList.toggle('nrpn-idle', idle);
        }
        const panel = wrap.closest?.('.synth-controls');
        if (panel && algorithm) {
            const used = new Set(algorithm.modulation.map(m => m.im));
            for (let im = 1; im <= 6; im++) {
                for (const input of panel.querySelectorAll(`input[data-nrpn="${2 * im + 2}"]`)) {
                    const box = input.parentElement;
                    box?.classList.toggle('nrpn-idle', !used.has(im));
                }
            }
            // The mixer has a level and a pan per carrier: show only as many as the algorithm has.
            for (let n = 1; n <= 6; n++) {
                for (const nrpn of [16 + 2 * (n - 1), 17 + 2 * (n - 1)]) {
                    for (const input of panel.querySelectorAll(`input[data-nrpn="${nrpn}"]`)) {
                        input.parentElement?.classList.toggle('nrpn-gone', n > algorithm.carriers.length);
                    }
                }
            }
        }
    };
    if (plan.algorithmDef) {
        redraws.push(markCarriers);
        // Picking an algorithm in its own widget does not reach the other graphs by itself: follow its changes.
        io.onChange?.(def => {
            if (def.nrpn !== plan.algorithmDef.nrpn) return;
            if (wrap.isConnected) markCarriers();
        });
    }
    redraws.forEach(fn => fn());
    if (plan.algorithmDef) setTimeout(markCarriers, 0);   // once the panel is built the modulation index knobs can be found
    return wrap;
}

// Rows for the algorithm picture: operators that modulate nothing else sit on the bottom row (the carriers
// are heard), and a modulator sits one row above the highest operator it feeds.
function algorithmLayout(algorithm) {
    const level = new Map();
    const levelOf = op => {
        if (level.has(op)) return level.get(op);
        level.set(op, 0);
        const targets = algorithm.modulation.filter(m => m.from === op).map(m => m.to);
        const value = targets.length ? 1 + Math.max(...targets.map(levelOf)) : 0;
        level.set(op, value);
        return value;
    };
    for (let op = 1; op <= algorithm.operators; op++) levelOf(op);
    const rows = Math.max(...level.values()) + 1;
    const position = new Map();
    for (let row = 0; row < rows; row++) {
        const ops = [...level].filter(([, l]) => l === row).map(([op]) => op).sort((a, b) => a - b);
        ops.forEach((op, i) => position.set(op, [(i + 1) / (ops.length + 1), row]));
    }
    return { position, rows };
}

/** All algorithms as small pictures of the operator wiring; click one to select it. */
export function createAlgorithmPicker(plan, io) {
    let redraw = () => {};
    const { wrap } = makeWrap('', [plan.def], () => redraw());
    const grid = html('div', 'nrpn-algo-grid');
    wrap.appendChild(grid);
    const W = 72, H = 64;
    const buttons = plan.algorithms.map((algorithm, index) => {
        const button = html('button', 'nrpn-algo');
        button.type = 'button';
        button.setAttribute('role', 'radio');
        button.title = `Algorithm ${algorithm.algorithm}`;
        button.setAttribute('aria-label', `Algorithm ${algorithm.algorithm}`);
        const picture = svg('svg', { viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true', class: 'nrpn-algo-picture' });
        const { position, rows } = algorithmLayout(algorithm);
        // Boxes shrink when many operators share a row (27: six carriers side by side).
        const widest = Math.max(...[...position.values()].map(([, row]) => [...position.values()].filter(([, r]) => r === row).length));
        const box = clamp((W - 8) / widest - 2.5, 9, 14);
        const at = op => {
            const [fx, row] = position.get(op);
            return [4 + box / 2 + fx * (W - 8 - box) + (0.5 - fx) * 0, rows === 1 ? H / 2 : H - 10 - row * ((H - 26) / (rows - 1))];
        };
        for (const link of algorithm.modulation) {
            const [x1, y1] = at(link.from), [x2, y2] = at(link.to);
            // The arrow head is a small triangle at the target end, so no shared marker definition is needed.
            const sx = x1, sy = y1 + box / 2, tx = x2, ty = y2 - box / 2 - 1;
            const length = Math.hypot(tx - sx, ty - sy) || 1, ux = (tx - sx) / length, uy = (ty - sy) / length;
            picture.appendChild(svg('line', { x1: sx, y1: sy, x2: tx - ux * 3, y2: ty - uy * 3, class: 'nrpn-algo-link' }));
            picture.appendChild(svg('polygon', { class: 'nrpn-algo-head',
                points: `${tx},${ty} ${tx - ux * 4.5 - uy * 2.2},${ty - uy * 4.5 + ux * 2.2} ${tx - ux * 4.5 + uy * 2.2},${ty - uy * 4.5 - ux * 2.2}` }));
        }
        for (let op = 1; op <= algorithm.operators; op++) {
            const [x, y] = at(op);
            const carrier = algorithm.carriers.includes(op);
            picture.appendChild(svg('rect', { x: x - box / 2, y: y - box / 2, width: box, height: box, rx: 2, class: carrier ? 'nrpn-algo-op carrier' : 'nrpn-algo-op' }));
            const text = svg('text', { x, y: y + 3.5, 'text-anchor': 'middle', class: carrier ? 'nrpn-algo-num carrier' : 'nrpn-algo-num' });
            text.textContent = String(op);
            picture.appendChild(text);
        }
        const number = html('span', 'nrpn-algo-number', String(algorithm.algorithm));
        button.append(picture, number);
        button.addEventListener('click', () => {
            io.set(plan.def, index);
            redraw();
        });
        grid.appendChild(button);
        return button;
    });
    redraw = () => {
        const current = Math.round(read(io, plan.def));
        buttons.forEach((button, index) => button.setAttribute('aria-checked', String(index === current)));
    };
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', 'Algorithm');
    redraw();
    return wrap;
}

/** One field with a dot per pair of parameters: x and y are each dot's two parameters (mixer: pan, level). */
export function createDotField(plan, io) {
    const defs = plan.dots.flatMap(dot => [dot.x, dot.y]);
    let draw = () => {};
    const { wrap } = makeWrap('', defs, () => draw());
    const W = 220, H = 150, pad = 14;
    const graph = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'synth-xy nrpn-field', role: 'application', tabindex: '0',
        'aria-label': plan.title });
    for (let i = 1; i < 4; i++) {
        graph.appendChild(svg('line', { x1: pad + i * (W - 2 * pad) / 4, y1: pad, x2: pad + i * (W - 2 * pad) / 4, y2: H - pad, class: 'synth-grid' }));
        graph.appendChild(svg('line', { x1: pad, y1: pad + i * (H - 2 * pad) / 4, x2: W - pad, y2: pad + i * (H - 2 * pad) / 4, class: 'synth-grid' }));
    }
    if (plan.center) graph.appendChild(svg('line', { x1: W / 2, y1: pad, x2: W / 2, y2: H - pad, class: 'synth-cross' }));
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

// The 22 built-in arpeggiator rhythms as 16-step bit masks (bit 0 = first step), from the PreenFM2 firmware
// (src/synth/Timbre.cpp, lut_res_arpeggiator_patterns). The four user patterns are stored on the synth.
const ARP_PATTERNS = [21845, 62965, 46517, 54741, 43861, 22869, 38293, 2313, 37449, 21065, 18761,
    54553, 27499, 23387, 30583, 28087, 22359, 28527, 30431, 43281, 28609, 53505];

/** Arpeggiator rhythms as small step icons (a bar per played step); click one to select it. */
export function createArpPatternPicker(plan, io) {
    let redraw = () => {};
    const { wrap } = makeWrap('', [plan.def], () => redraw());
    const grid = html('div', 'nrpn-arp-grid');
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', 'Arpeggiator pattern');
    wrap.appendChild(grid);
    const total = span(plan.def).max + 1;
    const buttons = Array.from({ length: total }, (_, index) => {
        const button = html('button', 'nrpn-arp');
        button.type = 'button';
        button.setAttribute('role', 'radio');
        const user = index >= ARP_PATTERNS.length;
        const name = user ? `User ${index - ARP_PATTERNS.length + 1}` : String(index + 1);
        button.title = user ? `${name} (stored on the synth)` : `Pattern ${name}`;
        button.setAttribute('aria-label', `Arpeggiator pattern ${name}`);
        const icon = svg('svg', { viewBox: '0 0 64 20', class: 'nrpn-arp-icon', 'aria-hidden': 'true' });
        for (let step = 0; step < 16; step++) {
            const x = 1 + step * 4;
            if (user) icon.appendChild(svg('rect', { x, y: 9, width: 3, height: 2, class: 'nrpn-arp-off' }));
            else if (ARP_PATTERNS[index] >> step & 1) icon.appendChild(svg('rect', { x, y: 2, width: 3, height: 16, rx: 1, class: step % 4 === 0 ? 'nrpn-arp-on beat' : 'nrpn-arp-on' }));
            else icon.appendChild(svg('rect', { x, y: 9, width: 3, height: 2, class: 'nrpn-arp-off' }));
        }
        button.append(icon, html('span', 'nrpn-algo-number', name));
        button.addEventListener('click', () => { io.set(plan.def, index); redraw(); });
        grid.appendChild(button);
        return button;
    });
    redraw = () => {
        const current = Math.round(read(io, plan.def));
        buttons.forEach((button, index) => button.setAttribute('aria-checked', String(index === current)));
    };
    redraw();
    return wrap;
}

// The arpeggiator's note lengths by value (a whole note = 1/1), longest first. 3/x are dotted, x/3 and 1/6, 1/12... triplets.
const NOTE_VALUES = ['2/1', '3/2', '1/1', '3/4', '2/3', '1/2', '3/8', '1/3', '1/4', '1/6', '1/8', '1/12', '1/16', '1/24', '1/32', '1/48', '1/96'].map(text => {
    const [top, bottom] = text.split('/').map(Number);
    const length = top / bottom;
    const triplet = bottom % 3 === 0 && top !== 3 || text === '2/3';
    const dotted = top === 3 && bottom % 3 !== 0;
    const name = `${text}${dotted ? ' dotted' : triplet ? ' triplet' : ''}`;
    return { text, length, triplet, dotted, name };
});

/** Note lengths as small bars on a time axis (longer = wider), a dot for dotted and three ticks for triplets. */
export function createNoteValuePicker(plan, io) {
    let redraw = () => {};
    const { wrap } = makeWrap('', [plan.def], () => redraw());
    const grid = html('div', 'nrpn-arp-grid nrpn-note-grid');
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', `Arpeggiator ${plan.label.toLowerCase()}`);
    wrap.append(grid, html('div', 'nrpn-name', plan.label));
    const fraction = value => (Math.log2(value.length) + 6.6) / 7.6;
    const buttons = NOTE_VALUES.map((value, index) => {
        const button = html('button', 'nrpn-arp');
        button.type = 'button';
        button.setAttribute('role', 'radio');
        button.title = `${plan.label} ${value.name}`;
        button.setAttribute('aria-label', `Arpeggiator ${plan.label.toLowerCase()} ${value.name}`);
        const icon = svg('svg', { viewBox: '0 0 44 16', class: 'nrpn-arp-icon', 'aria-hidden': 'true' });
        const width = 4 + 34 * fraction(value);
        icon.appendChild(svg('rect', { x: 2, y: 4, width, height: 8, rx: 2, class: 'nrpn-note-bar' }));
        if (value.triplet) for (const k of [1, 2]) icon.appendChild(svg('line', { x1: 2 + width * k / 3, x2: 2 + width * k / 3, y1: 4, y2: 12, class: 'nrpn-note-tick' }));
        if (value.dotted) icon.appendChild(svg('circle', { cx: 2 + width + 3, cy: 8, r: 1.4, class: 'nrpn-note-dot' }));
        button.append(icon, html('span', 'nrpn-dir-name', value.text));
        button.addEventListener('click', () => { io.set(plan.def, index); redraw(); });
        grid.appendChild(button);
        return button;
    });
    redraw = () => {
        const current = Math.round(read(io, plan.def));
        buttons.forEach((button, index) => button.setAttribute('aria-checked', String(index === current)));
    };
    redraw();
    return wrap;
}

// The 12 arpeggiator directions: each icon plots eight steps as dots at their pitch level (0 low .. 4 high);
// a chord plays all its notes at once, so it is drawn as stacks.
const ARP_DIRECTIONS = [
    ['Up', [0, 1, 2, 3, 0, 1, 2, 3]], ['Down', [3, 2, 1, 0, 3, 2, 1, 0]], ['Up & Down', [0, 1, 2, 3, 2, 1, 0, 1]],
    ['Played', [1, 3, 0, 2, 1, 3, 0, 2]], ['Random', [2, 0, 3, 1, 3, 0, 2, 1]], ['Chord', 'chord'],
    ['Rotate Up', [0, 1, 2, 3, 1, 2, 3, 0]], ['Rotate Down', [3, 2, 1, 0, 2, 1, 0, 3]], ['Rotate Up & Down', [0, 1, 2, 3, 2, 1, 0, 2]],
    ['Shift Up', [0, 1, 2, 3, 1, 2, 3, 4]], ['Shift Down', [4, 3, 2, 1, 3, 2, 1, 0]], ['Shift Up & Down', [0, 1, 2, 3, 4, 3, 2, 1]],
];

/** The arpeggiator direction as icons: the notes' path over time. */
export function createArpDirectionPicker(plan, io) {
    let redraw = () => {};
    const { wrap } = makeWrap('', [plan.def], () => redraw());
    const grid = html('div', 'nrpn-arp-grid nrpn-dir-grid');
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', 'Arpeggiator direction');
    wrap.appendChild(grid);
    const buttons = ARP_DIRECTIONS.map(([name, steps], index) => {
        const button = html('button', 'nrpn-arp');
        button.type = 'button';
        button.setAttribute('role', 'radio');
        button.title = name;
        button.setAttribute('aria-label', `Arpeggiator direction ${name}`);
        const icon = svg('svg', { viewBox: '0 0 48 26', class: 'nrpn-arp-icon', 'aria-hidden': 'true' });
        const x = i => 4 + i * 5.7, y = level => 22 - level * 4.5;
        if (steps === 'chord') {
            for (const i of [0, 2, 4, 6]) for (let level = 0; level < 4; level++) icon.appendChild(svg('circle', { cx: x(i + 0.5), cy: y(level), r: 1.7, class: 'nrpn-dir-dot' }));
        } else {
            icon.appendChild(svg('polyline', { points: steps.map((level, i) => `${x(i)},${y(level)}`).join(' '), class: 'nrpn-dir-line' }));
            steps.forEach((level, i) => icon.appendChild(svg('circle', { cx: x(i), cy: y(level), r: 1.9, class: 'nrpn-dir-dot' })));
        }
        button.append(icon, html('span', 'nrpn-dir-name', name));
        button.addEventListener('click', () => { io.set(plan.def, index); redraw(); });
        grid.appendChild(button);
        return button;
    });
    redraw = () => {
        const current = Math.round(read(io, plan.def));
        buttons.forEach((button, index) => button.setAttribute('aria-checked', String(index === current)));
    };
    redraw();
    return wrap;
}

/** A pill switch with one stop per label and a thumb that slides to the picked one. Value = first + index. */
function createStops(labels, label, onPick) {
    const box = html('div', 'nrpn-stops');
    box.style.setProperty('--stops', String(labels.length));
    box.setAttribute('role', 'radiogroup');
    box.setAttribute('aria-label', label);
    const thumb = html('span', 'nrpn-stops-thumb');
    box.appendChild(thumb);
    const buttons = labels.map((text, index) => {
        const button = html('button', 'nrpn-stop', text);
        button.type = 'button';
        button.setAttribute('role', 'radio');
        button.addEventListener('click', () => onPick(index));
        box.appendChild(button);
        return button;
    });
    const set = index => {
        thumb.style.setProperty('--at', String(clamp(index, 0, labels.length - 1)));
        buttons.forEach((button, i) => button.setAttribute('aria-checked', String(i === index)));
    };
    return { box, set };
}

/** Arpeggiator clock (Off / Int / Ext), tempo knob (live only on Int), octaves (1-3) and latch. */
export function createArpMain(plan, io) {
    let redraw = () => {};
    const defs = [plan.clock, plan.bpm, plan.octave, plan.latch].filter(Boolean);
    const { wrap } = makeWrap('', defs, () => redraw());
    const row = html('div', 'nrpn-arp-main');
    wrap.appendChild(row);
    const cell = (caption, ...nodes) => {
        const box = html('div', 'nrpn-arp-main-cell');
        box.append(...nodes, html('div', 'nrpn-name', caption));
        row.appendChild(box);
        return box;
    };
    const pick = (def, first, index) => { io.set(def, first + index); redraw(); };
    const clock = createStops(['Off', 'Int', 'Ext'], 'Arpeggiator clock', index => pick(plan.clock, span(plan.clock).min, index));
    cell('Clock', clock.box);
    let bpm = null;
    if (plan.bpm) {
        bpm = io.knob(plan.bpm);
        bpm.classList.add('nrpn-arp-bpm');
        bpm.querySelector?.('.synth-control-name')?.remove();
        bpm.title = 'Tempo of the internal clock';
        cell('BPM', bpm);
    }
    let octave = null;
    if (plan.octave) { octave = createStops(['1', '2', '3'], 'Arpeggiator octaves', index => pick(plan.octave, span(plan.octave).min, index)); cell('Octaves', octave.box); }
    let latch = null;
    if (plan.latch) { latch = createStops(['Off', 'On'], 'Arpeggiator latch', index => pick(plan.latch, span(plan.latch).min, index)); latch.box.classList.add('nrpn-stops-two'); cell('Latch', latch.box); }
    redraw = () => {
        const mode = Math.round(read(io, plan.clock)) - span(plan.clock).min;
        clock.set(mode);
        // The tempo knob only matters when the synth keeps the time itself.
        bpm?.classList.toggle('nrpn-idle', mode !== 1);
        octave?.set(Math.round(read(io, plan.octave)) - span(plan.octave).min);
        latch?.set(Math.round(read(io, plan.latch)) - span(plan.latch).min);
    };
    redraw();
    return wrap;
}

// The PreenFM2 filter types by value, and a sketch of each family's response (32x18 box, y down). Several types
// are only approximately like their sketch (the name says which exact type it is).
const FILTER_TYPES = ['Off', 'Mix', 'LP', 'HP', 'Bass', 'BP', 'Crsh', 'LP2', 'HP2', 'BP2', 'Lp3', 'Hp3', 'Bp3', 'Peak', 'Notc', 'Bell',
    'LowS', 'HigS', 'LpHp', 'BpDs', 'LPws', 'Tilt', 'Pann', 'Sat', 'Sigm', 'Fold', 'Wrap', 'Rot', 'Txr1', 'Txr2', 'LPx1', 'LPx2', 'LpSn',
    'HpSn', 'Not4', 'Ap4', 'Ap4b', 'Ap4D', 'Oryx', 'Orx2', 'Orx3', '18db', 'La+d', 'Lad+', 'Diod', 'L+d+', 'h3o+', 'Svh3', 'Alkx'];
const SKETCH = {
    flat: '1,9 31,9', off: '1,9 31,9', lp: '1,5 15,5 21,7 27,14 31,16', hp: '1,16 5,14 11,7 17,5 31,5',
    bp: '1,16 8,14 13,5 19,5 24,14 31,16', band: '1,16 5,7 9,5 23,5 27,7 31,16', notch: '1,5 11,5 14,12 16,16 18,12 21,5 31,5',
    peak: '1,11 10,11 14,6 16,3 18,6 22,11 31,11', low: '1,5 12,5 20,12 31,12', high: '1,12 12,12 20,5 31,5', tilt: '1,13 31,4',
    allpass: '1,9 31,9', sat: '1,15 9,14 15,9 21,4 31,3', fold: '1,15 9,3 16,14 23,3 31,10', wrap: '1,15 11,3 11,15 21,3 21,15 31,3',
    crush: '1,16 8,16 8,12 16,12 16,8 24,8 24,4 31,4', reso: '1,6 17,6 21,2 25,11 31,16', other: '',
};
const FILTER_SKETCH = {
    Off: 'off', Mix: 'flat', LP: 'lp', HP: 'hp', Bass: 'low', BP: 'bp', Crsh: 'crush', LP2: 'lp', HP2: 'hp', BP2: 'bp', Lp3: 'lp', Hp3: 'hp', Bp3: 'bp',
    Peak: 'peak', Notc: 'notch', Bell: 'peak', LowS: 'low', HigS: 'high', LpHp: 'band', BpDs: 'bp', LPws: 'lp', Tilt: 'tilt', Pann: 'allpass',
    Sat: 'sat', Sigm: 'sat', Fold: 'fold', Wrap: 'wrap', LPx1: 'lp', LPx2: 'lp', LpSn: 'lp', HpSn: 'hp', Not4: 'notch', Ap4: 'allpass',
    Ap4b: 'allpass', Ap4D: 'allpass', Oryx: 'reso', Orx2: 'reso', Orx3: 'reso', '18db': 'lp', 'La+d': 'lp', 'Lad+': 'lp', Diod: 'lp', 'L+d+': 'lp', 'h3o+': 'hp',
};

/** A horizontal slider over whole steps; `text(value)` is what the readout under it says. */
export function createHorizontalSlider(plan, io) {
    let redraw = () => {};
    const { wrap } = makeWrap('', [plan.def], () => redraw());
    wrap.classList.add('nrpn-hslider');
    const track = html('div', 'nrpn-hslider-track');
    track.tabIndex = 0;
    track.setAttribute('role', 'slider');
    track.setAttribute('aria-label', plan.def.name);
    const fill = html('div', 'nrpn-hslider-fill');
    const handle = html('div', 'nrpn-hslider-handle');
    track.append(fill, handle);
    const readout = html('output', 'nrpn-env-readout');
    wrap.append(track, readout);
    const { min, max } = span(plan.def);
    let value = min;
    const draw = () => {
        const f = plan.reverse ? 1 - clamp01((value - min) / (max - min)) : clamp01((value - min) / (max - min));
        handle.style.left = `${f * 100}%`;
        fill.style.width = `${f * 100}%`;
        readout.textContent = plan.text(value);
        track.setAttribute('aria-valuenow', String(value));
        track.setAttribute('aria-valuetext', plan.text(value));
        plan.onChange?.(value);
    };
    const change = next => {
        if (next === value) return;
        value = next;
        io.set(plan.def, value);
        draw();
    };
    redraw = () => { value = Math.round(read(io, plan.def)); draw(); };
    drag(track, track, wrap, { begin: () => true, move: f => change(snap(plan.def, min + (plan.reverse ? 1 - f[0] : f[0]) * (max - min))) });
    track.addEventListener('keydown', event => {
        const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key];
        if (!dir) return;
        event.preventDefault();
        change(snap(plan.def, value + (plan.reverse ? -dir : dir)));
    });
    redraw();
    return wrap;
}

/** A vertical slider in the parameter's own units: drag the bar up or down. */
export function createVerticalSlider(plan, io) {
    let redraw = () => {};
    const { wrap } = makeWrap(plan.label, [plan.def], () => redraw());
    wrap.classList.add('nrpn-vslider');
    const track = html('div', 'nrpn-vslider-track');
    track.tabIndex = 0;
    track.setAttribute('role', 'slider');
    track.setAttribute('aria-label', plan.def.name);
    const fill = html('div', 'nrpn-vslider-fill');
    const handle = html('div', 'nrpn-vslider-handle');
    track.append(fill, handle);
    const readout = html('output', 'nrpn-env-readout');
    wrap.append(track, readout);
    const { min, max } = span(plan.def);
    let value = min;
    const draw = () => {
        const f = clamp01((value - min) / (max - min));
        handle.style.bottom = `${f * 100}%`;
        fill.style.height = `${f * 100}%`;
        readout.textContent = fmt(plan.def, value);
        track.setAttribute('aria-valuenow', String(value));
    };
    const change = next => {
        if (next === value) return;
        value = next;
        io.set(plan.def, value);
        draw();
    };
    redraw = () => { value = read(io, plan.def); draw(); };
    drag(track, track, wrap, { begin: () => true, move: f => change(snap(plan.def, min + f[1] * (max - min))) });
    track.addEventListener('keydown', event => {
        const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[event.key];
        if (!dir) return;
        event.preventDefault();
        change(snap(plan.def, value + dir * (max - min) * (event.shiftKey ? 0.01 : 0.05)));
    });
    redraw();
    return wrap;
}

/** Filter: the two-parameter pad (the selected type's response as a thin line behind it) with the gain as a
 * vertical slider on its right and the type as a slider underneath. */
export function createFilterWidget(plan, io) {
    const box = html('div', 'nrpn-filter');
    const pad = createDotField(plan.pad, io);
    box.appendChild(pad);
    if (plan.gain) box.appendChild(createVerticalSlider({ def: plan.gain, label: 'Gain' }, io));
    if (plan.type) {
        // The curve sits behind the grid and the dot, in the plot area of the pad's 220x150 box.
        const curve = svg('polyline', { class: 'nrpn-field-curve' });
        const field = pad.querySelector('.nrpn-field');
        field.insertBefore(curve, field.firstChild);
        const show = value => {
            const name = FILTER_TYPES[value];
            const sketch = SKETCH[FILTER_SKETCH[name] || 'other'];
            curve.setAttribute('points', sketch.split(' ').filter(Boolean).map(pair => {
                const [x, y] = pair.split(',').map(Number);
                return `${(14 + (x - 1) / 30 * 192).toFixed(1)},${(14 + (y - 1) / 16 * 122).toFixed(1)}`;
            }).join(' '));
            curve.classList.toggle('dashed', FILTER_SKETCH[name] === 'off' || FILTER_SKETCH[name] === 'allpass');
        };
        const slider = createHorizontalSlider({ def: plan.type, text: value => FILTER_TYPES[value] ?? String(value), onChange: show }, io);
        slider.classList.add('nrpn-filter-types');
        box.appendChild(slider);
    }
    return box;
}

/** The modulation matrix: sources on the left, targets on the right, a knob per row between them. Click a knob to
 * pick its row (its source and targets light up), then click a source or a target to set it; click a lit one to clear it. */
export function createMatrixWidget(plan, io) {
    const defs = plan.rows.flatMap(row => [row.amount, row.source, row.dest1, row.dest2].filter(Boolean));
    let redraw = () => {};
    const { wrap } = makeWrap('', defs, () => redraw());
    wrap.classList.add('nrpn-matrix');
    const box = html('div', 'nrpn-matrix-box');
    wrap.appendChild(box);

    const state = plan.rows.map(() => ({ src: 0, d1: 0, d2: 0 }));
    let active = 0;
    const list = (options, onPick) => {
        const column = html('div', 'nrpn-matrix-list');
        column.setAttribute('role', 'listbox');
        const items = options.map((option, value) => {
            const item = html('button', 'nrpn-matrix-item');
            item.type = 'button';
            item.setAttribute('role', 'option');
            item.append(html('span', 'nrpn-matrix-text', value === 0 ? '—' : option), html('span', 'nrpn-matrix-badges'));
            item.addEventListener('click', () => onPick(value));
            column.appendChild(item);
            return item;
        });
        return { column, items };
    };
    const sources = list(plan.rows[0].source.options || [], value => {
        const row = state[active];
        row.src = row.src === value ? 0 : value;
        io.set(plan.rows[active].source, row.src);
        draw();
    });
    const targets = list(plan.rows[0].dest1.options || [], value => {
        const row = state[active], def = plan.rows[active];
        if (value !== 0 && row.d1 === value) { row.d1 = 0; io.set(def.dest1, 0); }
        else if (value !== 0 && row.d2 === value && def.dest2) { row.d2 = 0; io.set(def.dest2, 0); }
        else if (value !== 0 && row.d1 === 0) { row.d1 = value; io.set(def.dest1, value); }
        else if (value !== 0 && def.dest2) { row.d2 = value; io.set(def.dest2, value); }
        else if (value !== 0) { row.d1 = value; io.set(def.dest1, value); }
        draw();
    });

    const knobs = html('div', 'nrpn-matrix-knobs');
    const knobBoxes = plan.rows.map((row, index) => {
        const knob = io.knob(row.amount);
        knob.classList.add('nrpn-matrix-knob');
        // Just the knob: the row number is not written, the knob keeps its accessible name.
        knob.querySelector?.('.synth-control-name')?.remove();
        knob.title = `Matrix row ${row.n}`;
        knob.style.setProperty('--row', DOT_COLORS[index % DOT_COLORS.length]);
        // A press or keyboard focus on the knob picks the row; the knob itself still turns as usual.
        knob.addEventListener('pointerdown', () => select(index));
        knob.addEventListener('focusin', () => select(index));
        knobs.appendChild(knob);
        return knob;
    });
    // The lists fill a cell whose height comes from the knob column, so they are exactly as tall as the four knobs.
    const cell = column => { const holder = html('div', 'nrpn-matrix-cell'); holder.appendChild(column); return holder; };
    box.append(cell(sources.column), knobs, cell(targets.column));

    // Keep the row's lit entries in view in a long list, without scrolling the page.
    const reveal = (column, item) => {
        if (!item || !column.clientHeight) return;
        if (item.offsetTop < column.scrollTop || item.offsetTop + item.offsetHeight > column.scrollTop + column.clientHeight) {
            column.scrollTop = item.offsetTop - (column.clientHeight - item.offsetHeight) / 2;
        }
    };
    const draw = (scroll = false) => {
        const mine = state[active];
        const paint = (items, matches, claimed) => items.forEach((item, value) => {
            const lit = value !== 0 && matches(value);
            item.className = `nrpn-matrix-item${lit ? ' lit' : ''}`;
            item.setAttribute('aria-selected', String(lit));
            // A small number for each other row that uses this entry.
            item.querySelector('.nrpn-matrix-badges').replaceChildren(...state.flatMap((row, index) =>
                index !== active && value !== 0 && claimed(row, value) ? [html('span', 'nrpn-matrix-badge', String(plan.rows[index].n))] : []));
        });
        paint(sources.items, value => mine.src === value, (row, value) => row.src === value);
        paint(targets.items, value => mine.d1 === value || mine.d2 === value, (row, value) => row.d1 === value || row.d2 === value);
        knobBoxes.forEach((knob, index) => knob.classList.toggle('active', index === active));
        if (scroll) {
            reveal(sources.column, sources.items[mine.src]);
            reveal(targets.column, targets.items[mine.d1] || targets.items[mine.d2]);
        }
    };
    const select = index => { if (index !== active) { active = index; draw(true); } };
    redraw = () => {
        plan.rows.forEach((row, index) => {
            state[index].src = Math.round(read(io, row.source));
            state[index].d1 = Math.round(read(io, row.dest1));
            state[index].d2 = row.dest2 ? Math.round(read(io, row.dest2)) : 0;
        });
        draw(true);
    };
    redraw();
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
    const { wrap } = makeWrap('', defs, () => redraws.forEach(fn => fn()));
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
        graph.append(frame, zero, curve, dot, track, marker);
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
        cell.append(graph, html('div', 'nrpn-name', `LFO ${item.n}`), buttons, readout);
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
    if (plan.kind === 'algorithms') return createAlgorithmPicker(plan, io);
    if (plan.kind === 'note-values') return createNoteValuePicker(plan, io);
    if (plan.kind === 'hslider') {
        const wrap = createHorizontalSlider(plan, io);
        wrap.classList.add('nrpn-hslider-labelled');
        wrap.appendChild(html('div', 'nrpn-name', plan.label));
        return wrap;
    }
    if (plan.kind === 'arp-main') return createArpMain(plan, io);
    if (plan.kind === 'arp-directions') return createArpDirectionPicker(plan, io);
    if (plan.kind === 'arp-patterns') return createArpPatternPicker(plan, io);
    if (plan.kind === 'filter') return createFilterWidget(plan, io);
    if (plan.kind === 'matrix') return createMatrixWidget(plan, io);
    return createDotField(plan, io);
}
