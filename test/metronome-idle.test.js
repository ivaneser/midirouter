// ---------------------------------------------------------------------------
// Regression: `Metronome._play_loop` must sleep/wait while playing with no
// pending click — it must NOT busy-spin.
//
// Contract under test: when `_playing=True`, `_running=True`, and
// `_pending_click is None`, the playback loop should block on a
// `threading.Event` (or equivalent) rather than looping with bare
// `continue`. A hardware-free probe wraps the event in a spy that counts
// `wait()` invocations. If the loop never calls `.wait()`, it is busy-spinning.
//
// Known defect this locks down: `_play_loop` currently does
//   `if click_data is None: continue`
// with no sleep/wait, so the thread tight-loops until `quit()` — burning a
// full CPU core while idle.
//
// Hardware-free: no ALSA devices, no `aplay`, no waveform generation. The
// Metronome object is constructed via `__new__` (bypassing `__init__`), and all
// state the loop touches is seeded manually.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'path';
import * as url from 'url';

/**
 * Derive the repo root from this test file's location:
 *   <root>/test/metronome-idle.test.js  →  <root>
 */
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Build the Python probe script. It:
 *   1. Adds the repo root to sys.path so `import metronome` works.
 *   2. Constructs a Metronome via `__new__` (no `__init__`, no device probes).
 *   3. Seeds `_running=True`, `_playing=True`, `_lock=Lock()`,
 *      `_audio_process=None`, `_audio_generation=0`, `_pending_click=None`.
 *   4. Replaces `_click_event` with a SpyEvent wrapping a real threading.Event:
 *        - `.wait()` increments a counter, signals `wait_started`, then
 *          blocks on the underlying event (so the thread actually sleeps).
 *        - `.set()` / `.clear()` delegate to the real event.
 *   5. Starts `_play_loop` in a daemon thread.
 *   6. Waits up to ~1 s for `wait_started`.
 *   7. Calls `m.quit()`, joins the thread, and prints JSON with:
 *        - wait_calls: number of `.wait()` invocations observed
 *        - thread_alive: whether the playback thread is still alive after quit
 */
function buildPythonScript(repoRoot) {
    // Embed the repo root as a Python string literal. Use raw strings to avoid
    // shell-escaping headaches; the path comes from Node's filesystem, not user input.
    const py = `
import sys, os, json, threading, time

sys.path.insert(0, ${JSON.stringify(repoRoot)})

from metronome import Metronome


class SpyEvent:
    """Wraps a real threading.Event and counts .wait() calls."""
    def __init__(self):
        self._real = threading.Event()
        self.wait_calls = 0
        self.wait_started = threading.Event()

    def wait(self, timeout=None):
        self.wait_calls += 1
        self.wait_started.set()
        # Block on the real event so the thread actually sleeps.
        return self._real.wait(timeout)

    def set(self):
        self._real.set()

    def clear(self):
        self._real.clear()

    def is_set(self):
        return self._real.is_set()


# --- Construct Metronome without running __init__ -------------------------
m = Metronome.__new__(Metronome)

# Seed all state _play_loop touches. No device probes, no waveform generation.
m._running = True
m._playing = True
m._lock = threading.Lock()
m._audio_process = None
m._audio_generation = 0
m._pending_click = None
m._click_event = SpyEvent()

# --- Start the playback loop in a daemon thread ----------------------------
t = threading.Thread(target=m._play_loop, daemon=True)
t.start()

# --- Wait up to ~1 s for the loop to call .wait() --------------------------
spy = m._click_event
ok = spy.wait_started.wait(timeout=1.0)

if not ok:
    # The loop never called .wait() — it is busy-spinning.
    # Still quit so the process can exit cleanly.
    m.quit()
    t.join(timeout=2.0)
    result = {'wait_calls': spy.wait_calls, 'thread_alive': t.is_alive()}
    print(json.dumps(result))
    sys.exit(0)

# --- Quit and join ----------------------------------------------------------
m.quit()
t.join(timeout=5.0)
result = {'wait_calls': spy.wait_calls, 'thread_alive': t.is_alive()}
print(json.dumps(result))
`;
    return py;
}

test('metronome _play_loop waits (does not busy-spin) while playing with no pending click', () => {
    const script = buildPythonScript(REPO_ROOT);

    // Run Python via spawnSync. Use `python3 -c <script>`.
    // The script prints a single JSON line to stdout on success.
    const result = spawnSync('python3', ['-c', script], {
        encoding: 'utf8',
        timeout: 15000, // generous upper bound; the probe itself is ~2 s max
    });

    // --- Diagnostics on failure -------------------------------------------
    if (result.error) {
        throw new Error(`spawnSync python3 failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
        const stderr = (result.stderr || '').trim();
        throw new Error(
            `python3 exited with status ${result.status}\nstdout: ${(result.stdout || '').trim()}\nstderr: ${stderr}`,
        );
    }

    // --- Parse the JSON result ----------------------------------------------
    const stdout = (result.stdout || '').trim().split('\n').pop();
    let data;
    try {
        data = JSON.parse(stdout);
    } catch (e) {
        throw new Error(`failed to parse Python probe output as JSON: ${stdout}`);
    }

    // --- Assertions -----------------------------------------------------------
    assert.ok(
        typeof data.wait_calls === 'number' && data.wait_calls >= 1,
        `playback loop must call .wait() at least once while idle; got wait_calls=${data.wait_calls} (busy-spin)`,
    );
    assert.equal(
        data.thread_alive, false,
        `playback thread must exit after quit(); still alive: ${data.thread_alive}`,
    );
});
