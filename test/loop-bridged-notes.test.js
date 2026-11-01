import test from 'node:test';
import assert from 'node:assert/strict';
import { MIDIRouterWorker } from '../worker-midi.js';

// A note that ends where the clip loops while the same note starts at the loop start must not send the
// note-off that would cut the note beginning at that moment.
function play(notes) {
    const timers = [];
    const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
    globalThis.setTimeout = (fn, delay) => { const timer = { fn, delay, cleared: false }; timers.push(timer); return timer; };
    globalThis.clearTimeout = timer => { if (timer) timer.cleared = true; };
    try {
        const sent = [];
        const worker = Object.create(MIDIRouterWorker.prototype);
        worker._sendToSynthOutputs = bytes => sent.push(bytes);
        const playback = { slot: 0, timeouts: new Set(), noteOnTimers: new Set(), active: new Map(), originMs: performance.now(), audioOffsetMs: 0, loopBeats: 4, msPerBeat: 500 };
        playback.schedule = (fn, delay) => { const timer = setTimeout(fn, delay); playback.timeouts.add(timer); };
        worker._scheduleClipNotes(playback, { length: 4, notes }, 0);
        // Run the pending timers (note-ons, and the note-offs they schedule) for two passes.
        for (let round = 0; round < 6 && timers.length; round++) for (const timer of timers.splice(0)) if (!timer.cleared && timer.delay < 5000) timer.fn();
        return { sent, playback };
    } finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; }
}

const note = (n, start, dur) => ({ note: n, start, dur, velocity: 100, channel: 1 });
const offs = sent => sent.filter(bytes => (bytes[0] & 0xf0) === 0x80).map(bytes => bytes[1]);

test('the note-off of a note ending at the loop end is dropped when the same note starts the loop', () => {
    const { sent, playback } = play([note(60, 0, 1), note(60, 3, 1), note(64, 3, 1)]);
    assert.ok(sent.some(bytes => bytes[0] === 0x90 && bytes[1] === 60), 'notes still play');
    assert.ok(!offs(sent).includes(60) || offs(sent).filter(n => n === 60).length < sent.filter(b => b[0] === 0x90 && b[1] === 60).length, 'not every C4 is ended at the boundary');
    assert.ok(offs(sent).includes(64), 'a note without a partner keeps its note-off');
    assert.ok(playback.held.has('1:60'), 'the bridged note is remembered as sounding, so a stop still releases it');
    assert.ok(!playback.held.has('1:64'));
});
