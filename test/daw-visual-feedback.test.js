import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';
import { DAWUI } from '../frontend/js/daw-ui.js';
import { MIDIRouterWorker } from '../worker-midi.js';

function makeElement() {
    const classes = new Set();
    return {
        classes,
        classList: {
            add: (...names) => names.forEach((name) => classes.add(name)),
            remove: (...names) => names.forEach((name) => classes.delete(name)),
            toggle: (name, force) => {
                if (force === undefined ? !classes.has(name) : force) classes.add(name);
                else classes.delete(name);
            },
            contains: (name) => classes.has(name),
        },
        dataset: {},
        addEventListener() {},
        textContent: '',
        value: '',
    };
}

function useFakeDocument(t) {
    const previousDocument = globalThis.document;
    const mode = makeElement();
    const indicator = makeElement();
    const slot = makeElement();
    globalThis.document = {
        getElementById(id) {
            if (id === 'record-mode') return mode;
            if (id === 'daw-beat-indicator') return indicator;
            return null;
        },
        querySelector(selector) {
            return selector === '.session-slot[data-track="2"][data-slot="1"]' ? slot : null;
        },
    };
    t.after(() => { globalThis.document = previousDocument; });
    return { mode, indicator, slot };
}

test('transport reports cycle and following-bar boundaries for visual cues', async () => {
    const daw = new DAWEngine({ tempo: 300, loopLenBeats: 8 });
    const cues = [];
    daw._onProgress = (beat, _progress, cue) => cues.push({ beat, ...cue });

    daw.startTransport();
    await new Promise((resolve) => setTimeout(resolve, 950));
    daw.stopTransport();

    assert.equal(cues[0].cycleStart, true, 'transport start is the first cycle boundary');
    assert.ok(cues.some((cue) => cue.barStart && !cue.cycleStart && cue.beat >= 4 && cue.beat < 5),
        'the next 4/4 downbeat is reported separately from cycle start');
});

test('DAW UI colors record mode and distinguishes bar, cycle, and clip starts', (t) => {
    const { mode, indicator, slot } = useFakeDocument(t);
    const ui = new DAWUI(null);
    ui.dawState = { recordMode: 'overdub', tempo: 120 };
    ui._syncControls();
    assert.ok(mode.classList.contains('mode-overdub'));
    assert.equal(mode.dataset.recordMode, 'overdub');

    ui.handleMessage({ type: 'daw_progress', payload: { beat: 4, meter: 4, playing: true, barStart: true } });
    assert.ok(indicator.classList.contains('bar-start'));
    assert.equal(indicator.textContent, 'Bar 2 · Beat 1');

    ui.handleMessage({ type: 'daw_progress', payload: { beat: 0, meter: 4, playing: true, barStart: true, cycleStart: true } });
    assert.ok(indicator.classList.contains('cycle-start'));

    ui.handleMessage({ type: 'daw_visual_event', event: { kind: 'clip-start', trackIdx: 2, slot: 1 } });
    assert.ok(slot.classList.contains('clip-start'));
    ui.handleMessage({ type: 'daw_visual_event', event: { kind: 'record-start', trackIdx: 2, slot: 1 } });
    assert.ok(slot.classList.contains('record-start'));

    for (const timer of ui._cueTimers.values()) clearTimeout(timer);
    ui._cueTimers.clear();
});

test('clip-start feedback is emitted after the state redraw message', () => {
    const order = [];
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = {
        recordMode: 'none',
        triggerPad: () => ({ action: 'play' }),
    };
    worker._clearStaleRecordingFeedback = () => {};
    worker._startTrackPlayback = () => {};
    worker._broadcastState = () => order.push('state');
    worker._emitVisualEvent = () => order.push('cue');

    worker._triggerPad(2, 1, 1000);

    assert.deepEqual(order, ['state', 'cue'], 'the cue must target the freshly rendered slot');
});
