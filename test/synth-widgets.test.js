import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { groupSynthControls } from '../frontend/js/synth-layout.js';
import { planWidgets, adsrPoints, ADSR_GEOMETRY as g } from '../frontend/js/synth-widgets.js';

const load = f => JSON.parse(readFileSync(new URL(`../device_maps/${f}.json`, import.meta.url))).controls;
const plans = f => groupSynthControls(load(f)).map(s => ({ category: s.category, ...planWidgets(s.controls) }));

test('MicroFreak filter gets an XY pad and the envelope an ADSR graph with its three stages', () => {
    const p = plans('arturia_microfreak');
    const filter = p.find(s => s.category === 'filter');
    const xy = filter.widgets.find(w => w.kind === 'xy');
    assert.deepEqual([xy.x.cc, xy.y.cc], [23, 83]);
    assert.ok(filter.rest.some(c => c.cc === 26), 'envelope amount stays a knob');
    const env = p.find(s => s.category === 'env').widgets[0];
    assert.deepEqual([env.a.cc, env.d.cc, env.s.cc, env.r], [105, 106, 29, undefined]);
});

test('Craft Synth: cutoff 34 / resonance 35 pad and full ADSR graphs from the CC chart', () => {
    const p = plans('modal_craft_synth_v2');
    const xy = p.find(s => s.category === 'filter').widgets.find(w => w.kind === 'xy');
    assert.deepEqual([xy.x.cc, xy.y.cc], [34, 35]);
    const amp = p.find(s => s.category === 'env').widgets[0];
    assert.deepEqual([amp.a.cc, amp.d.cc, amp.s.cc, amp.r.cc], [26, 27, 28, 29]);
    const filt = p.find(s => s.category === 'filter_env').widgets[0];
    assert.deepEqual([filt.a.cc, filt.d.cc, filt.s.cc, filt.r.cc], [22, 23, 24, 25]);
});

test('adsr outline stays inside each stage slot', () => {
    const lo = adsrPoints({ a: 0, d: 0, s: 0, r: 0 });
    const hi = adsrPoints({ a: 1, d: 1, s: 1, r: 1 });
    assert.equal(lo.peak[0], g.left);
    assert.equal(hi.peak[0], g.left + g.slot);
    assert.equal(hi.sustain[1], g.top);
    assert.equal(lo.sustain[1], g.bottom);
    assert.equal(hi.end[0], g.holdEnd + g.slot);
});
