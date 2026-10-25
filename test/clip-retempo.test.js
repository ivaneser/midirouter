import test from 'node:test';
import assert from 'node:assert/strict';
import { MIDIRouterWorker } from '../worker-midi.js';
import { DAWEngine } from '../daw.js';

// A playing clip carries on from the same beat when the tempo changes.
function setup(t) {
    const timers = [];
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    globalThis.setTimeout = (fn, delay) => { const timer = { fn, delay, cleared: false }; timers.push(timer); return timer; };
    globalThis.clearTimeout = timer => { if (timer) timer.cleared = true; };
    t.after(() => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; });

    const worker = Object.create(MIDIRouterWorker.prototype);
    worker.daw = { playing: true, tempo: 120, _secondsPerBeat() { return 60 / this.tempo; }, tracks: [{ clips: [{ length: 4, notes: [
        { start: 0, dur: 0.5, note: 60, velocity: 100, channel: 1 },
        { start: 2, dur: 0.5, note: 64, velocity: 100, channel: 1 },
    ] }] }] };
    worker._externalClockActive = false;
    worker._sendToSynthOutputs = () => {};
    worker._trackPlayTimers = new Map();
    const playback = { slot: 0, timeouts: new Set(), noteOnTimers: new Set(), active: new Map(), originMs: 0, audioOffsetMs: 0, loopBeats: 4, msPerBeat: 500 };
    playback.schedule = (fn, delay, isNoteOn = false) => {
        const timer = setTimeout(fn, delay);
        playback.timeouts.add(timer);
        if (isNoteOn) playback.noteOnTimers.add(timer);
    };
    worker._trackPlayTimers.set(0, playback);
    return { worker, playback, timers };
}

test('a tempo change re-times the pending note-ons from the current beat', t => {
    const { worker, playback, timers } = setup(t);
    const now = performance.now();
    playback.originMs = now - 500;   // one beat (500 ms at 120 BPM) into the clip
    worker._scheduleClipNotes(playback, worker.daw.tracks[0].clips[0], 0, now);
    const first = timers.splice(0);
    assert.equal(first.length, 2);

    worker.daw.tempo = 240;           // twice as fast: a beat is now 250 ms
    worker._retempoPlayingClips(now);
    assert.ok(first.every(timer => timer.cleared), 'old note-ons are cancelled');
    assert.equal(playback.msPerBeat, 250);
    assert.ok(Math.abs(playback.originMs - (now - 250)) < 1e-6, 'the clip keeps its beat position');
    // The beat-2 note is one beat (250 ms) away; the beat-0 note comes after the wrap, 3 beats away.
    const delays = timers.map(timer => Math.round(timer.delay)).sort((x, y) => x - y);
    assert.deepEqual(delays, [250, 750]);
});

test('the transport keeps its beat position when the tempo changes', () => {
    const daw = new DAWEngine();
    daw.playing = true;
    daw._playAnchorTime = performance.now() - 2000; // 4 beats in at 120 BPM
    daw.setTempo(60);
    const beat = (performance.now() - daw._playAnchorTime) / 1000 / daw._secondsPerBeat();
    assert.ok(Math.abs(beat - 4) < 0.05, `beat ${beat}`);
});
