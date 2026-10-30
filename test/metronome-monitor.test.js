import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { MetronomeController } from '../metronome-controller.js';

const python = spawnSync('python3', ['--version']).status === 0;

// Runs a snippet against metronome.py's Metronome class (no audio device is opened).
function py(code) {
    const result = spawnSync('python3', ['-c', `
import sys, json
sys.path.insert(0, ${JSON.stringify(join(import.meta.dirname, '..'))})
import metronome as m
from array import array
met = m.Metronome(120, alsa_device='null')
${code}
`], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split('\n').pop());
}
const tone = n => `array('h', [1000] * ${n * 2}).tobytes()`;   // n stereo frames (left and right 1000)

test('the controller sends the monitor gain and remembers it for a restart', () => {
    const written = [];
    const controller = new MetronomeController();
    controller._process = { stdin: { write: text => written.push(text) } };
    controller._pid = 1;
    controller._running = true;
    controller.setMonitorGain(4);
    controller.setMonitorGain(99);
    controller.setMonitorGain(-3);
    assert.deepEqual(written, ['monitorgain 4\n', 'monitorgain 32\n', 'monitorgain 0\n'], 'limited to 0..32');
    assert.equal(controller._monitorGain, 0);
});

test('the controller sends the monitor switch, remembers it and repeats it on a restart', () => {
    const written = [];
    const controller = new MetronomeController();
    controller._process = { stdin: { write: text => written.push(text) } };
    controller._pid = 1;
    controller._running = true;
    controller.setMonitor(true);
    controller.setMonitor(false);
    assert.deepEqual(written, ['monitor 1\n', 'monitor 0\n']);
    controller.setMonitor(true);
    assert.equal(controller._monitor, true, 'kept for the next start of the process');
});

test('monitored audio is mixed into the output next to the clicks', { skip: !python }, () => {
    const out = py(`
met.set_monitor(True)
met._monitor_stop.set()   # no router here: stop the reader thread
met._monitor_gain = 1.0
met._monitor_push(${tone(4410)})
met._monitor_primed = True
chunk = array('h'); chunk.frombytes(met._next_chunk())
print(json.dumps({"n": len(chunk), "first": chunk[0], "last": chunk[-1]}))
`);
    assert.equal(out.n, 1024, '512 stereo frames');
    assert.equal(out.first, 1000);
    assert.equal(out.last, 1000);
});

test('the output stays silent until a small cushion is buffered, and rebuilds it after running dry', { skip: !python }, () => {
    const out = py(`
met._monitor = True
met._monitor_gain = 1.0
met._monitor_push(${tone(100)})                       # 100 samples: less than the 60 ms cushion
silent = array('h'); silent.frombytes(met._monitor_pull(512))
met._monitor_push(${tone(4410)})                      # 100 ms
heard = array('h'); heard.frombytes(met._monitor_pull(512))
met._monitor_buf.clear()
met._monitor_push(${tone(300)})                       # ran dry: 300 samples then silence
tail = array('h'); tail.frombytes(met._monitor_pull(512))
print(json.dumps({"silent": max(abs(x) for x in silent), "heard": heard[0], "padded_zero": tail[800],
                  "primed_again": met._monitor_primed}))
`);
    assert.equal(out.silent, 0);
    assert.equal(out.heard, 1000);
    assert.equal(out.padded_zero, 0);
    assert.equal(out.primed_again, false, 'after running dry it waits for the cushion again');
});

test('a backlog is trimmed to a short cushion instead of growing the delay', { skip: !python }, () => {
    const out = py(`
met._monitor_push(${tone(44100)})                     # one second piled up
print(json.dumps({"ms": len(met._monitor_buf) / 4 / m.SAMPLE_RATE * 1000}))
`);
    assert.ok(out.ms <= 110 && out.ms >= 90, `kept ${out.ms} ms`);
});

test('mixing saturates instead of wrapping around', { skip: !python }, () => {
    const out = py(`
a = array('h', [30000] * 4); met._monitor_push(array('h', [30000] * 4).tobytes() * 100)
met._monitor = True; met._monitor_primed = True; met._monitor_gain = 1.0
met._mix_monitor(a)
print(json.dumps({"v": a[0]}))
`);
    assert.equal(out.v, 32767);
});

test('the clicks still work with monitoring off, and monitoring keeps the stream open without the metronome', { skip: !python }, () => {
    const out = py(`
a = met._next_chunk()
met.set_monitor(True); met._monitor_stop.set()
met.stop()   # the metronome stops, monitoring does not
print(json.dumps({"silent_when_off": a == bytes(2048), "monitor_after_stop": met._monitor, "status": met.status()["monitor"]}))
`);
    assert.equal(out.silent_when_off, true);
    assert.equal(out.monitor_after_stop, true);
    assert.equal(out.status, true);
});

test('the live input plays exactly as it arrives by default, even when it is loud', { skip: !python }, () => {
    const out = py(`
met._monitor = True; met._monitor_primed = True
met._monitor_push(array('h', [1000, -2500, 30000, -32768, 32767, 5]).tobytes() * 200)
a = array('h', [0] * 6); met._mix_monitor(a)
print(json.dumps({"gain": met._monitor_gain, "out": list(a)}))
`);
    assert.equal(out.gain, 1);
    assert.deepEqual(out.out, [1000, -2500, 30000, -32768, 32767, 5], 'no boost, no limiter, no change');
});

test('turned down it scales the audio, turned up it boosts it with the soft knee', { skip: !python }, () => {
    const out = py(`
def run(gain):
    mm = m.Metronome(120, alsa_device='null'); mm._monitor = True; mm._monitor_primed = True; mm._monitor_gain = gain
    mm._monitor_push(array('h', [1000, 30000]).tobytes() * 200)
    a = array('h', [0, 0]); mm._mix_monitor(a); return list(a)
print(json.dumps({"half": run(0.5), "x2": run(2.0)}))
`);
    assert.deepEqual(out.half, [500, 15000]);
    assert.equal(out.x2[0], 2000, 'quiet audio stays linear when boosted');
    assert.ok(out.x2[1] < 32767 && out.x2[1] > 30000, `a loud peak is rounded off, not clipped: ${out.x2[1]}`);
});

test('the metronome clicks are quiet by default, so they do not drown the live audio', { skip: !python }, () => {
    const out = py(`
c = array('h'); c.frombytes(met._normal_click)
print(json.dumps({"volume": m.VOLUME, "click_peak": max(abs(x) for x in c) / 32768}))
`);
    assert.equal(out.volume, 0.3);
    assert.ok(out.click_peak < 0.32 && out.click_peak > 0.2, `click peak ${out.click_peak}`);
    assert.equal(new MetronomeController().volume, 0.3);
});

test('the soft knee keeps loud boosted audio from clipping, and leaves quiet audio linear', { skip: !python }, () => {
    const out = py(`
f = m.Metronome._soft_clip
print(json.dumps({"quiet": f(10000), "at_knee": f(0.6 * 32767), "loud": f(200000), "loud_neg": f(-200000),
                  "monotonic": all(f(x) <= f(x + 500) for x in range(0, 40000, 500))}))
`);
    assert.equal(out.quiet, 10000);
    assert.ok(Math.abs(out.at_knee - 0.6 * 32767) < 2);
    assert.ok(out.loud <= 32767 && out.loud > 30000, `loud ${out.loud}`);
    assert.equal(out.loud_neg, -out.loud);
    assert.equal(out.monotonic, true);
});

test('the monitorgain command sets the gain', { skip: !python }, () => {
    const out = py(`
import io
src = io.StringIO("monitorgain 8\\nmonitorgain oops\\nmonitorgain 99\\nquit\\n")
old = sys.stdin; sys.stdin = src
try: m.read_commands(met)
finally: sys.stdin = old
print(json.dumps({"gain": met._monitor_gain}))
`);
    assert.equal(out.gain, 32, 'the last valid value, limited to 32');
});

test('the left and right of the live audio stay on their own sides', { skip: !python }, () => {
    const out = py(`
met._monitor = True; met._monitor_primed = True
met._monitor_push(array('h', [1000, -3000]).tobytes() * 600)      # left 1000, right -3000
c = array('h'); c.frombytes(met._next_chunk())
print(json.dumps({"left": c[0], "right": c[1], "left_last": c[-2], "right_last": c[-1]}))
`);
    assert.deepEqual([out.left, out.right, out.left_last, out.right_last], [1000, -3000, 1000, -3000]);
});

test('a mono stream is centered: the same on both sides', { skip: !python }, () => {
    const out = py(`
met._monitor_push(array('h', [100, 200, 300]).tobytes(), 1)
met._monitor_primed = True
a = array('h'); a.frombytes(met._monitor_pull(3))
print(json.dumps(list(a)))
`);
    assert.deepEqual(out, [100, 100, 200, 200, 300, 300]);
});

test('a click is centered: the same on both sides', { skip: !python }, () => {
    const out = py(`
import time
met._playing = True; met._last_write_done = time.monotonic(); met._emit_click(False)
c = array('h'); c.frombytes(met._next_chunk())
print(json.dumps({"n": len(c), "same": all(c[i] == c[i + 1] for i in range(0, len(c), 2)), "heard": max(abs(x) for x in c) > 1000}))
`);
    assert.equal(out.n, 1024);
    assert.equal(out.same, true);
    assert.equal(out.heard, true);
});

test('the output stream is stereo and keeps the old buffering time, so click calibration still holds', { skip: !python }, () => {
    const out = py(`
print(json.dumps({"channels": m.OUT_CHANNELS, "pipe_frames": m.PIPE_BYTES // (2 * m.OUT_CHANNELS), "latency": m.CLICK_LATENCY_MS}))
`);
    assert.equal(out.channels, 2);
    assert.equal(out.pipe_frames, 2048, 'the same 2048 frames of backlog as in mono');
    assert.ok(Math.abs(out.latency - (4096 + 2048) * 1000 / 44100) < 0.01, `latency ${out.latency}`);
});

test('the controller sends the noise filter, refuses unknown levels and remembers it for a restart', () => {
    const written = [];
    const controller = new MetronomeController();
    controller._process = { stdin: { write: text => written.push(text) } };
    controller._pid = 1;
    controller._running = true;
    controller.setMonitorFilter('light');
    controller.setMonitorFilter('strong');
    controller.setMonitorFilter('extreme');
    assert.deepEqual(written, ['monitorfilter light\n', 'monitorfilter strong\n', 'monitorfilter off\n']);
    assert.equal(controller._monitorFilter, 'off');
});

test('the monitor asks the router for the chosen noise filter and reconnects when it changes', { skip: !python }, () => {
    const out = py(`
import http.server, threading, time
paths = []
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        paths.append(self.path)
        self.send_response(200); self.send_header('X-Sample-Rate', '44100'); self.send_header('X-Channels', '2'); self.end_headers()
        try:
            for _ in range(400):
                self.wfile.write(array('h', [100, -100] * 512).tobytes()); self.wfile.flush(); time.sleep(0.01)
        except OSError: pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
m.MONITOR_URL = f'http://127.0.0.1:{srv.server_address[1]}/audio/live'
met.set_monitor_filter('bogus')            # refused
met.set_monitor(True); time.sleep(0.5)
first = list(paths)
met.set_monitor_filter('light'); time.sleep(0.6)
met.set_monitor_filter('strong'); time.sleep(0.6)
met.set_monitor_filter('off'); time.sleep(0.6)
met.set_monitor(False); time.sleep(0.2); srv.shutdown()
print(json.dumps({"first": first, "all": paths, "status": met.status()["monitor_filter"]}))
`);
    assert.deepEqual(out.first, ['/audio/live'], 'no filter parameter while it is off, and "bogus" is refused');
    assert.deepEqual(out.all, ['/audio/live', '/audio/live?filter=light', '/audio/live?filter=strong', '/audio/live'], 'each change reconnects at once');
    assert.equal(out.status, 'off');
});

test('the monitorfilter command sets the filter', { skip: !python }, () => {
    const out = py(`
import io
old = sys.stdin; sys.stdin = io.StringIO("monitorfilter strong\\nquit\\n")
try: m.read_commands(met)
finally: sys.stdin = old
print(json.dumps({"filter": met._monitor_filter}))
`);
    assert.equal(out.filter, 'strong');
});
