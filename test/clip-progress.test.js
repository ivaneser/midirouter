import test from 'node:test';
import assert from 'node:assert/strict';
import { MIDIRouterWorker } from '../worker-midi.js';
import { DAWUI } from '../frontend/js/daw-ui.js';

function worker() {
    const w = Object.create(MIDIRouterWorker.prototype);
    w.daw = { playing: true, clipState: [0, 1], _secondsPerBeatMs: () => 500 };
    w._trackPlayTimers = new Map();
    return w;
}

test('playing clips use their own length and origin and wrap at their own end', () => {
    const w = worker();
    w._trackPlayTimers.set(0, { slot: 0, originMs: 1000, loopBeats: 4, msPerBeat: 500 });
    w._trackPlayTimers.set(1, { slot: 1, originMs: 1000, loopBeats: 8, msPerBeat: 500 });
    assert.deepEqual(w._clipPlaybackProgress(2000).map(p => p.progress), [0.5, 0.25]);
    assert.deepEqual(w._clipPlaybackProgress(3000).map(p => p.progress), [0, 0.5]);
    assert.deepEqual(w._clipPlaybackProgress(4000).map(p => p.progress), [0.5, 0.75]);
});

test('latency-shifted playback origin is used and queued clips do not advance early', () => {
    const w = worker();
    w._trackPlayTimers.set(0, { slot: 0, originMs: 1000, audioOffsetMs: -100, loopBeats: 4, msPerBeat: 500 });
    assert.deepEqual(w._clipPlaybackProgress(899), []);
    assert.equal(w._clipPlaybackProgress(900)[0].progress, 0);
    assert.equal(w._clipPlaybackProgress(1900)[0].progress, 0.5);
    w.audioOffsetMs = 200;
    assert.equal(w._clipPlaybackProgress(1900)[0].progress, 0.5, 'internal progress follows the offset captured by the active scheduler');
});

test('external-clock progress follows MIDI ticks, latency and clip length', () => {
    const w = worker();
    w.audioOffsetMs = -125; // six ticks before the grid boundary
    w._externalMidiClock = { tickCount: 90 };
    w._trackPlayTimers.set(0, { slot: 0, externalClock: true, startTick: 96, loopTicks: 96 });
    assert.equal(w._clipPlaybackProgress()[0].progress, 0);
    w._externalMidiClock.tickCount = 138;
    assert.equal(w._clipPlaybackProgress()[0].progress, 0.5);
    w._externalMidiClock.tickCount = 186;
    assert.equal(w._clipPlaybackProgress()[0].progress, 0);
});

test('stopped, switched and not-yet-scheduled clips do not report progress', () => {
    const w = worker();
    assert.deepEqual(w._clipPlaybackProgress(), []);
    w._trackPlayTimers.set(0, { slot: 1, originMs: 1000, loopBeats: 4, msPerBeat: 500 });
    assert.deepEqual(w._clipPlaybackProgress(2000), []);
    w.daw.playing = false;
    assert.deepEqual(w._clipPlaybackProgress(2000), []);
});

test('UI progress fills forwards, snaps at wrap and hides on stop without rebuilding clips', t => {
    const fill = { style: {}, dataset: {} };
    const bar = { hidden: true, querySelector: () => fill };
    const clip = { dataset: { track: '0', slot: '1' }, querySelector: () => bar };
    const previous = globalThis.document;
    globalThis.document = { querySelectorAll: () => [clip] };
    t.after(() => { globalThis.document = previous; });
    const ui = Object.create(DAWUI.prototype);
    ui._updateClipProgress([{ trackIdx: 0, slot: 1, progress: 0.75 }]);
    assert.equal(bar.hidden, false);
    assert.equal(fill.style.transform, 'scaleX(0.75)');
    assert.equal(fill.style.transition, '');
    ui._updateClipProgress([{ trackIdx: 0, slot: 1, progress: 0.01 }]);
    assert.equal(fill.style.transform, 'scaleX(0.01)');
    assert.equal(fill.style.transition, 'none');
    ui._updateClipProgress([]);
    assert.equal(bar.hidden, true);
});
