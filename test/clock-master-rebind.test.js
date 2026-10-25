// A re-plugged clock master gets a new ALSA address (client number changes), so its
// full port name changes. The master must follow the device, not be lost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stablePortKey } from '../clock-master.js';
import { MIDIRouterWorker } from '../worker-midi.js';

test('stablePortKey drops the ALSA address and keeps the device name', () => {
    assert.equal(stablePortKey('NTS-1 digital kit:NTS-1 digital kit _ SOUND 20:0'),
        'NTS-1 digital kit:NTS-1 digital kit _ SOUND');
    assert.equal(stablePortKey('NTS-1 digital kit:NTS-1 digital kit _ SOUND 21:0'),
        stablePortKey('NTS-1 digital kit:NTS-1 digital kit _ SOUND 20:0'));
});

test('clock master is re-bound to the device after it is re-plugged with a new address', () => {
    const worker = Object.create(MIDIRouterWorker.prototype);
    worker._broadcastState = () => {};
    worker._clockMaster = { source: { kind: 'external', masterPortName: 'NTS-1 digital kit:NTS-1 digital kit _ SOUND 20:0' },
        selectExternal(name) { this.source = { kind: 'external', masterPortName: name }; } };
    // Device is back on a new address.
    worker.inputs = new Map([['NTS-1 digital kit:NTS-1 digital kit _ SOUND 21:0', {}]]);
    worker._rebindClockMaster();
    assert.equal(worker._clockMaster.source.masterPortName, 'NTS-1 digital kit:NTS-1 digital kit _ SOUND 21:0');
});

test('clock master falls back to the internal clock when its device is gone', () => {
    const worker = Object.create(MIDIRouterWorker.prototype);
    const calls = [];
    worker._broadcastState = () => calls.push('broadcast');
    worker.daw = { setMidiClock: v => calls.push(['mtc', v]) };
    worker._clockMaster = { source: { kind: 'external', masterPortName: 'NTS-1 digital kit:NTS-1 digital kit _ SOUND 20:0' },
        selectExternal() { throw new Error('must not change'); },
        selectInternal() { this.source = { kind: 'internal' }; } };
    worker.inputs = new Map([['Launchkey Mini MK3 MIDI 1 28:1', {}]]);
    worker._rebindClockMaster();
    assert.equal(worker._clockMaster.source.kind, 'internal');
    assert.deepEqual(calls, [['mtc', true], 'broadcast']);
});

function restoreWorker(saved, inputs) {
    const worker = Object.create(MIDIRouterWorker.prototype);
    const calls = [];
    worker.inputs = new Map(inputs.map(n => [n, {}]));
    worker.daw = { setMidiClock: v => calls.push(['mtc', v]) };
    worker.controllerEngine = { profiles: [] };
    worker._clockMaster = { source: { kind: 'internal' }, selectExternal(n) { this.source = { kind: 'external', masterPortName: n }; }, selectInternal() { this.source = { kind: 'internal' }; } };
    worker._savedClockSource = saved;
    worker._selectDefaultClockSource();
    return { worker, calls };
}

test('a clock source saved in an earlier session is restored at startup', () => {
    const ext = restoreWorker({ kind: 'external', portName: 'NTS-1 digital kit:NTS-1 digital kit _ SOUND 20:0' },
        ['NTS-1 digital kit:NTS-1 digital kit _ SOUND 24:0']);
    assert.equal(ext.worker._clockMaster.source.masterPortName, 'NTS-1 digital kit:NTS-1 digital kit _ SOUND 24:0');
    assert.deepEqual(ext.calls, [['mtc', false]]);
    const absent = restoreWorker({ kind: 'external', portName: 'Gone:Gone 20:0' }, []);
    assert.equal(absent.worker._clockMaster.source.kind, 'internal', 'missing source falls back to internal');
    assert.deepEqual(absent.calls, [['mtc', true]]);
    assert.equal(absent.worker._savedClockSource.portName, 'Gone:Gone 20:0', 'the saved choice is kept');
    const internal = restoreWorker({ kind: 'internal' }, ['Launchkey Mini MK3:x 20:0']);
    assert.equal(internal.worker._clockMaster.source.kind, 'internal');
    assert.deepEqual(internal.calls, [['mtc', true]]);
});
