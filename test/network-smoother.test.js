import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkSmoother } from '../network-smoother.js';

// Plays notes pressed every 100 ms whose network delay varies; returns the time each one sounds after its key press.
function soundDelays(smoother, delays, start = 1_000_000) {
    return delays.map((net, i) => {
        const at = start + i * 100, now = at + net;
        return now + smoother.delay(at, now) - at;
    });
}

test('a fixed target gives every note the same total delay despite the jitter', () => {
    const smoother = new NetworkSmoother(40);
    const total = soundDelays(smoother, [5, 5, 28, 7, 15, 5, 33, 9, 5, 12]);
    const settled = total.slice(1);
    assert.ok(Math.max(...settled) - Math.min(...settled) <= 6, `spread was ${Math.max(...settled) - Math.min(...settled)} ms`);
});

test('without smoothing the jitter reaches the sound', () => {
    const total = soundDelays(new NetworkSmoother('off'), [5, 5, 28, 7, 15, 5, 33]);
    assert.ok(Math.max(...total) - Math.min(...total) >= 25);
});

test('auto grows its target after a burst of jitter and stays within the limits', () => {
    const smoother = new NetworkSmoother('auto');
    soundDelays(smoother, [5, 5, 5, 5]);
    const calm = smoother.target;
    soundDelays(smoother, [5, 60, 5, 5]);
    assert.ok(smoother.target > calm && smoother.target <= 80);
    assert.ok(calm >= 10);
});

test('events never overtake each other and an event that is already late is sent at once', () => {
    const smoother = new NetworkSmoother(30);
    const at = 2_000_000;
    const first = smoother.delay(at, at + 5);          // fast: held
    const second = smoother.delay(at + 1, at + 6);     // pressed just after: not due before the first
    assert.ok(at + 5 + first <= at + 6 + second);
    assert.equal(smoother.delay(at + 5000, at + 5000 + 3000), 0, 'an implausibly old event is not delayed');
    assert.equal(new NetworkSmoother(30).delay(undefined, at), 0, 'no timestamp: sent at once');
});
