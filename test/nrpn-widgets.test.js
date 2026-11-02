import test from 'node:test';
import assert from 'node:assert/strict';
import { freqPull, freqFineness, pullToIntegers, FREQ_LOCK_RANGE, FREQ_PULL_RANGE } from '../frontend/js/nrpn-widgets.js';

test('the pull is full near the middle line and fades out smoothly, never abruptly', () => {
    assert.equal(freqPull(0), 1);
    assert.equal(freqPull(FREQ_LOCK_RANGE), 1, 'a flat zone right at the line');
    assert.equal(freqPull(FREQ_PULL_RANGE), 0);
    assert.equal(freqPull(-FREQ_PULL_RANGE * 3), 0);
    assert.equal(freqPull(5), freqPull(-5), 'above and below the line count the same');
    let previous = 1;
    for (let offset = FREQ_LOCK_RANGE; offset <= FREQ_PULL_RANGE; offset += 1) {
        const pull = freqPull(offset);
        assert.ok(pull <= previous + 1e-12, 'never increases with distance');
        assert.ok(previous - pull < 0.08, `no sudden drop between ${offset - 1} and ${offset} units (${previous} -> ${pull})`);
        previous = pull;
    }
    assert.ok(freqPull(20) > 0.7, 'a small shift keeps most of the pull');
});

test('on the middle line the value snaps to whole ratios', () => {
    assert.equal(pullToIntegers(2.3, 1), 2);
    assert.equal(pullToIntegers(2.7, 1), 3);
    assert.equal(pullToIntegers(0.4, 1), 0);
});

test('away from the line the pull weakens and finally leaves the value alone', () => {
    assert.equal(pullToIntegers(2.3, 0), 2.3);
    const strong = pullToIntegers(2.2, 0.8), middling = pullToIntegers(2.2, 0.5), weak = pullToIntegers(2.2, 0.2);
    assert.ok(strong > 2 && strong < middling && middling < weak && weak < 2.2, `${strong} ${middling} ${weak}`);
    assert.equal(pullToIntegers(3.0, 0.4), 3, 'a whole ratio stays put');
    assert.ok(Math.abs(pullToIntegers(2.5, 0.7) - 2.5) < 1e-9, 'halfway between two ratios nothing moves');
});

test('the pull is continuous and keeps the order of the values', () => {
    for (const pull of [0.2, 0.5, 0.9]) {
        let previous = pullToIntegers(0, pull);
        for (let value = 0.01; value <= 4; value += 0.01) {
            const pulled = pullToIntegers(value, pull);
            assert.ok(pulled >= previous - 1e-9, `monotonic at ${value} (pull ${pull})`);
            assert.ok(pulled - previous < 0.06, `no jump at ${value} (pull ${pull})`);
            previous = pulled;
        }
    }
});

test('sideways movement is finer the further the pointer is from the line', () => {
    assert.equal(freqFineness(1), 1);
    assert.ok(Math.abs(freqFineness(0) - 0.1) < 1e-9);
    assert.ok(freqFineness(0.5) > freqFineness(0.2));
});
