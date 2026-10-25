import test from 'node:test';
import assert from 'node:assert/strict';
import { MidiClock } from '../midi-clock.js';
import { DAWEngine } from '../daw.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('idle clock ticks without Start or Stop and Start takes over cleanly', async () => {
    const emitted = [];
    const clock = new MidiClock({ bpm: 240, emit: (evt) => emitted.push(evt.data[0]) });
    clock.runIdle();
    await wait(150);
    assert.ok(emitted.length >= 3 && emitted.every(byte => byte === 0xF8), 'only ticks while idle');
    clock.start();
    assert.equal(emitted.includes(0xFA), true);
    clock.stop();
    assert.equal(emitted.at(-1), 0xFC);
    const afterStop = emitted.length;
    await wait(80);
    assert.equal(emitted.length, afterStop, 'a stopped clock does not tick');
});

test('DAW keeps the clock ticking while stopped and stops it when clock output is turned off', async () => {
    const emitted = [];
    const daw = new DAWEngine();
    daw._onEvent = (evt) => emitted.push(evt.data[0]);
    daw.setMidiClock(true);
    await wait(120);
    assert.ok(emitted.includes(0xF8) && !emitted.includes(0xFA), 'ticks but no Start while stopped');
    daw.setMidiClock(false);
    const count = emitted.length;
    await wait(100);
    assert.equal(emitted.length, count);
});
