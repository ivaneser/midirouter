import test from 'node:test';
import assert from 'node:assert/strict';
import { DAWEngine } from '../daw.js';
import { MIDIRouterWorker } from '../worker-midi.js';

for (const offset of [-120, 0, 90]) {
    test(`UI and hardware recording share audio compensation (${offset} ms), independently of click offset`, t => {
        const base = 10000;
        let wallTime = base;
        t.mock.method(performance, 'now', () => wallTime);
        function makeWorker(clickOffsetMs) {
            const worker = Object.create(MIDIRouterWorker.prototype);
            worker.audioOffsetMs = offset;
            worker.clickOffsetMs = clickOffsetMs;
            worker.daw = new DAWEngine({ tempo: 120 });
            worker.daw.getAudioOffsetMs = () => worker.audioOffsetMs;
            worker.daw.playing = true;
            worker.daw._playAnchorTime = base;
            worker.daw._globalCycleLocked = true;
            worker.daw.triggerPad(0, 0, base + 2000 + offset);
            worker.outputs = new Map();
            worker._broadcastState = () => {};
            return worker;
        }
        const hardware = makeWorker(-80);
        const ui = makeWorker(110);
        wallTime = base + 3000 + offset;
        hardware._recordPerformanceEvent(0x96, 60, 100, wallTime);
        ui._handleUiPerformance({ targets: [], bytes: [0x96, 60, 100] });
        wallTime += 250;
        hardware._recordPerformanceEvent(0x86, 60, 0, wallTime);
        ui._handleUiPerformance({ targets: [], bytes: [0x86, 60, 0] });
        const a = hardware.daw.tracks[0].clips[0].notes;
        const b = ui.daw.tracks[0].clips[0].notes;
        assert.deepEqual(b, a);
        assert.equal(b[0].start, 2);
        assert.equal(b[0].dur, 0.5);
        assert.equal(b[0].channel, 7);
    });
}
