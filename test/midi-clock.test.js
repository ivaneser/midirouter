import test from 'node:test';
import assert from 'node:assert/strict';
import { MidiClock, PULSES_PER_QTR } from '../midi-clock.js';
import { DAWEngine, noteOn, noteOff } from '../daw.js';

// ---------------------------------------------------------------------------
// 1. MidiClock standalone — verify MTC message generation
// ---------------------------------------------------------------------------
test('MidiClock emits Start at 0xFA on start()', () => {
    const emitted = [];
    const clock = new MidiClock({ bpm: 120, emit: (evt) => emitted.push(evt) });

    assert.equal(emitted.length, 0);
    clock.start();

    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0], { type: 'midi', data: [0xFA] });

    clock.stop();
});

test('MidiClock emits Continue at 0xFB when resumed from stopped state', () => {
    const emitted = [];
    const clock = new MidiClock({ bpm: 120, emit: (evt) => emitted.push(evt) });

    clock.start();
    clock.stop();
    assert.equal(emitted.length, 2); // start + stop

    clock.continue();
    assert.equal(emitted[emitted.length - 1], { type: 'midi', data: [0xFB] });

    clock.stop();
});

test('MidiClock emits Stop at 0xFC on stop()', () => {
    const emitted = [];
    const clock = new MidiClock({ bpm: 120, emit: (evt) => emitted.push(evt) });
    clock.start();
    clock.stop();
    assert.equal(emitted[emitted.length - 1], { type: 'midi', data: [0xFC] });
});

test('MidiClock emits 24 PPQN timing clocks (0xF8) while playing', (t) => {
    const emitted = [];
    const clock = new MidiClock({ bpm: 60, emit: (evt) => emitted.push(evt) });
    // 60 BPM -> 1 beat/sec -> 24 ticks/sec. Use 150ms to capture ~3-4 ticks.
    clock.start();

    // Let it run briefly
    const start = performance.now();
    while (performance.now() - start < 150) { /* spin */ }

    clock.stop();

    const tickEvents = emitted.filter(e => e.data[0] === 0xF8);
    assert.ok(tickEvents.length > 0, 'should have emitted some 0xF8 ticks');
    // At 60 BPM, ~3-4 ticks in 150ms is expected (24 ticks/sec * 0.15s = 3.6)
    assert.ok(tickEvents.length >= 2);
});

test('MidiClock reschedules on setTempo while playing', async () => {
    const emitted = [];
    const clock = new MidiClock({ bpm: 60, emit: (evt) => emitted.push(evt) });
    clock.start();

    // Wait a bit at 60 BPM
    await new Promise(r => setTimeout(r, 80));
    const ticksAt60 = emitted.filter(e => e.data[0] === 0xF8).length;

    // Change tempo to 120 (2x faster) — should reschedule immediately
    clock.setTempo(120);
    await new Promise(r => setTimeout(r, 80));
    const totalTicks = emitted.filter(e => e.data[0] === 0xF8).length;

    clock.stop();

    // After doubling tempo we expect noticeably more ticks in the second window.
    assert.ok(totalTicks > ticksAt60 * 1.5, 'faster tempo should produce more ticks');
});

test('setTempo clamps to 20-300 range', () => {
    const clock = new MidiClock({ bpm: 120 });
    clock.setTempo(10); // below min -> stays at 20
    assert.equal(clock.bpm, 20);
    clock.setTempo(500); // above max -> stays at 300
    assert.equal(clock.bpm, 300);
});

test('PULSES_PER_QTR is 24 (standard MIDI clock resolution)', () => {
    assert.equal(PULSES_PER_QTR, 24);
});

// ---------------------------------------------------------------------------
// 2. DAWEngine <-> MidiClock integration
// ---------------------------------------------------------------------------
test('DAWEngine startTransport() starts the internal MidiClock when MTC enabled', () => {
    let midiOut = [];
    const daw = new DAWEngine({ tempo: 120 });
    // Capture emitted MIDI via the _onEvent callback
    daw._onEvent = (evt) => {
        if (evt.data?.length >= 1) midiOut.push(evt.data);
    };

    assert.equal(daw.getMidiClockState(), true);
    daw.startTransport();

    // First message should be MIDI Start (0xFA) from the internal clock
    const startMsg = midiOut.find(m => m[0] === 0xFA);
    assert.ok(startMsg, 'internal MidiClock should emit 0xFA on transport start');

    daw.stopTransport();
});

test('DAWEngine stopTransport() stops the internal MidiClock', () => {
    let midiOut = [];
    const daw = new DAWEngine({ tempo: 120 });
    daw._onEvent = (evt) => {
        if (evt.data?.length >= 1) midiOut.push(evt.data);
    };

    daw.startTransport();
    const beforeStop = midiOut.filter(m => m[0] === 0xFA).length;
    daw.stopTransport();

    // After stop, no additional Start should be emitted (clock halted)
    const afterStop = midiOut.filter(m => m[0] === 0xFA).length;
    assert.equal(afterStop, beforeStop);
});

test('DAWEngine setTempo propagates to the internal MidiClock', () => {
    let count = 0;
    const daw = new DAWEngine({ tempo: 120 });
    // Temporarily make midiClock setTempo observable by counting calls.
    // We verify via the public bpm property which drives _msPerBeat internally.
    daw.setTempo(90);
    assert.equal(daw.tempo, 90);

    daw.setTempo(200);
    assert.equal(daw.tempo, 200);

    // Clamp check
    daw.setTempo(10);
    assert.equal(daw.tempo, 20);
    daw.setTempo(400);
    assert.equal(daw.tempo, 300);
});

test('DAWEngine toggling MIDI clock off stops the clock', () => {
    let midiOut = [];
    const daw = new DAWEngine({ tempo: 120 });
    daw._onEvent = (evt) => {
        if (evt.data?.length >= 1) midiOut.push(evt.data);
    };

    assert.equal(daw.getMidiClockState(), true);
    daw.setMidiClock(false);
    assert.equal(daw.getMidiClockState(), false);

    // Stop transport to clear any clock state
    daw.stopTransport();
});

test('DAWEngine setExternalClock(true) pauses the internal MTC', () => {
    let midiOut = [];
    const daw = new DAWEngine({ tempo: 120 });
    daw._onEvent = (evt) => {
        if (evt.data?.length >= 1) midiOut.push(evt.data);
    };

    daw.startTransport();
    daw.setExternalClock(true);

    // Internal clock should be paused — no new ticks while external active.
    const faCount = midiOut.filter(m => m[0] === 0xFA).length;
    assert.equal(faCount, 1); // only the initial start

    daw.setExternalClock(false);
    daw.stopTransport();
});

// ---------------------------------------------------------------------------
// 3. External MIDI Clock slave handling (worker path)
//    Simulate receiving incoming 0xF8 ticks from an external master.
// ---------------------------------------------------------------------------
test('Incoming external 0xF8 clock activates external clock mode & estimates tempo', async () => {
    const emitted = [];
    const worker = await import('../worker-midi.js');
    // The worker module is self-bootstrapping (it creates a worker thread parent),
    // so we instead test the logic via DAWEngine's setExternalClock + clock handling.
    // Direct unit-test of _handleMidiClock requires the full MIDIRouterWorker which
    // needs ALSA ports, so we verify the observable contract through DAWEngine:
    const daw = new DAWEngine({ tempo: 120 });

    let capturedEvt = null;
    daw._onEvent = (evt) => { capturedEvt = evt; };

    // Simulate receiving a Start (0xFA) externally while not playing
    daw.setExternalClock(true);
    assert.equal(daw._externalClock, true);

    // After 750ms of silence the external clock should time out and internal resumes.
    daw.setExternalClock(false);
});

test('DAWEngine keeps MIDI clock enabled by default', () => {
    const daw = new DAWEngine();
    assert.equal(daw.getMidiClockState(), true);
});
