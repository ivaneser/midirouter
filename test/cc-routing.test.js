/**
 * CC routing tests — production code path coverage.
 *
 * All routing scenarios below call `computeRoutingStep` from route-midi.js,
 * which is the SAME function used by worker-midi.js `_onIncomingMessage`.
 * No mirrored algorithm reimplementation: if these assertions pass, the
 * actual production routing tail behaves identically.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelFilter } from '../filters.js';
import { CCMapper } from '../cc-mapper.js';
import { computeRoutingStep } from '../route-midi.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an all-to-all outputs map like the worker's `this.outputs`. */
function outMap(names) {
    const m = new Map();
    for (const name of names) {
        // The real worker stores an RtMidiOut record; tests only need .sendMessage.
        const sent = [];
        m.set(name, { name, sendMessage: (buf) => sent.push(Array.from(buf)) });
    }
    return m;
}

/** Default Launchkey → Craft Synth all-to-all configuration. */
function allToAllCtx(ccMapper) {
    return { outputs: outMap(['Craft Synth 2.0']), mappings: new Map(), ccMapper };
}

// ---------------------------------------------------------------------------
// Test 1 — route input → specified synth (all-to-all, no explicit routes)
// CC knob on channel 3 reaches the connected synthesizer output.
// ---------------------------------------------------------------------------
test('CC from controller travels all-to-all to the listed synth output', () => {
    const ccMapper = new CCMapper();
    // 0xb2 = Control Change on MIDI channel 3; CC#16 (Knob 1).
    const result = computeRoutingStep(
        [0xb2, 16, 64],
        'Launchkey Mini MK3 MIDI Port',
        allToAllCtx(ccMapper)
    );

    assert.equal(result.dropped, null);
    assert.equal(result.delivered.length, 1, 'exactly one output should receive the CC');
    const sent = result.delivered[0];
    assert.equal(sent.output, 'Craft Synth 2.0');
    // Channel preserved (3).
    assert.equal(sent.channel, 3);
    // Auto-map: Launchkey Knob1 CC16 → 'volume' → Craft Synth CC7.
    assert.deepEqual(sent.bytes, [0xb2, 0x07, 0x40]);
});

// ---------------------------------------------------------------------------
// Test 2 — all-to-all forwards to EVERY listed output (no per-output filter)
// Second synth in the outputs list DOES receive it in all-to-all mode.
// ---------------------------------------------------------------------------
test('all-to-all delivers to every listed output (broadcast semantics)', () => {
    const ccMapper = new CCMapper();
    const result = computeRoutingStep(
        [0xb2, 16, 64],
        'Launchkey Mini MK3 MIDI Port',
        { outputs: outMap(['Craft Synth 2.0', 'Korg NTS-1 digital kit']), mappings: new Map(), ccMapper }
    );

    assert.equal(result.dropped, null);
    assert.equal(result.delivered.length, 2, 'all-to-all fans out to all listed outputs');
    const names = result.delivered.map((d) => d.output);
    assert.ok(names.includes('Craft Synth 2.0'));
    assert.ok(names.includes('Korg NTS-1 digital kit'));
});

// ---------------------------------------------------------------------------
// Test 3 — selected MIDI channel whitelist / drop in routed path
// CC on a non-selected channel is dropped by the channel filter.
// ---------------------------------------------------------------------------
test('routed channel whitelist drops non-whitelisted channels', () => {
    const ccMapper = new CCMapper();
    const mappings = new Map([['route1', {
        inputs: [{ name: 'Launchkey Mini MK3 MIDI Port' }],
        outputs: [{ name: 'Craft Synth 2.0' }],
        filters: [new ChannelFilter({ whitelist: [3] })],
    }]]);

    // CC on channel 4 (0xb4 = 0xB0|4) — whitelisted is CH3 → dropped.
    const result = computeRoutingStep(
        [0xb4, 16, 64],
        'Launchkey Mini MK3 MIDI Port',
        { outputs: outMap(['Craft Synth 2.0']), mappings, ccMapper }
    );

    assert.equal(result.dropped, null);
    assert.equal(result.delivered.length, 0, 'CC on non-whitelisted channel must not be delivered');
});

// ---------------------------------------------------------------------------
// Test 4 — second synth without a route does NOT receive the CC
// Only outputs named in matching routes are delivered.
// ---------------------------------------------------------------------------
test('a synth not listed in any matching route never receives the routed CC', () => {
    const ccMapper = new CCMapper();
    // Route only reaches 'Craft Synth 2.0'; Korg NTS-1 is absent from route outputs.
    const mappings = new Map([['route1', {
        inputs: [{ name: 'Launchkey Mini MK3 MIDI Port' }],
        outputs: [{ name: 'Craft Synth 2.0' }],
        filters: [],
    }]]);

    const result = computeRoutingStep(
        [0xb2, 7, 100],
        'Launchkey Mini MK3 MIDI Port',
        { outputs: outMap(['Craft Synth 2.0', 'Korg NTS-1 digital kit']), mappings, ccMapper }
    );

    assert.equal(result.dropped, null);
    assert.equal(result.delivered.length, 1, 'only route-listed outputs are delivered');
    assert.equal(result.delivered[0].output, 'Craft Synth 2.0');
});

// ---------------------------------------------------------------------------
// Test 5 — CCMapper transform per target: CC# is remapped for the destination
// Launchkey Knob1 (CC16) → volume → Craft Synth CC7.
// ---------------------------------------------------------------------------
test('CCMapper auto-maps CC to the target synth function per route', () => {
    const ccMapper = new CCMapper();
    const mappings = new Map([['route1', {
        inputs: [{ name: 'Launchkey Mini MK3 MIDI Port' }],
        outputs: [{ name: 'Craft Synth 2.0' }],
        filters: [new ChannelFilter({ whitelist: [3] })],
    }]]);

    const result = computeRoutingStep(
        [0xb2, 16, 64],
        'Launchkey Mini MK3 MIDI Port',
        { outputs: outMap(['Craft Synth 2.0']), mappings, ccMapper }
    );

    assert.equal(result.dropped, null);
    assert.equal(result.delivered.length, 1);
    const sent = result.delivered[0];
    // CC number transformed from 16 to 7 (volume) for Craft Synth 2.0.
    assert.equal(sent.bytes[1], 7, `CC16 should be auto-mapped to CC7 (volume), got ${sent.bytes[1]}`);
    // Channel preserved (3).
    assert.equal(sent.channel, 3);
    // Velocity/value preserved.
    assert.equal(sent.bytes[2], 64);
});

// ---------------------------------------------------------------------------
// Test 6 — DAW Port input travels the SAME routing path (no special bypass)
// No change to its semantics; transport CC is on channel 16, not this one.
// ---------------------------------------------------------------------------
test('DAW Port CC messages travel through the same routing path as MIDI Port', () => {
    const ccMapper = new CCMapper();
    // 0xb2 = CC on channel 3 sent via DAW Port.
    const result = computeRoutingStep(
        [0xb2, 16, 80],
        'Launchkey Mini MK3 DAW Port',
        allToAllCtx(ccMapper)
    );

    assert.equal(result.dropped, null);
    assert.equal(result.delivered.length, 1);
    const sent = result.delivered[0];
    assert.ok(sent.output.includes('Craft Synth'));
    assert.equal(sent.channel, 3);
    // Not converted to a transport command (0xbf is channel-16 CC / DAW mode).
    assert.notEqual(sent.bytes[0], 0xbf);
});

// ---------------------------------------------------------------------------
// Test 7 — all-to-all passes the REAL output device name to CCMapper
// Regression: previously `outputDeviceName='default'` was passed, so
// auto-map could never find a target profile. Verify it works now.
// ---------------------------------------------------------------------------
test('all-to-all path passes real output device name to transformCC (auto-map works)', () => {
    const ccMapper = new CCMapper();
    const result = computeRoutingStep(
        [0xb2, 16, 64],
        'Launchkey Mini MK3 MIDI Port',
        allToAllCtx(ccMapper)
    );

    assert.equal(result.dropped, null);
    assert.equal(result.delivered.length, 1);
    const sent = result.delivered[0];
    // If the worker passes 'default' instead of 'Craft Synth 2.0', auto-map
    // fails and CC# stays 16. After the fix it becomes 7.
    assert.equal(sent.bytes[1], 7, 'auto-mapped CC must be 7 (volume), not raw 16');
});

// ---------------------------------------------------------------------------
// Test 8 — unrelated CC numbers pass through unchanged (no semantic match)
// ---------------------------------------------------------------------------
test('unrelated CC numbers are passed through unchanged by CCMapper', () => {
    const ccMapper = new CCMapper();
    // CC#100 is not in any controller layout → no auto-map possible.
    const result = computeRoutingStep(
        [0xb2, 100, 50],
        'Launchkey Mini MK3 MIDI Port',
        allToAllCtx(ccMapper)
    );

    assert.equal(result.dropped, null);
    assert.equal(result.delivered[0].bytes[1], 100, 'unrelated CC must remain unchanged');
});

// ---------------------------------------------------------------------------
// Test 9 — ChannelFilter whitelist/blacklist mechanics (standalone)
// ---------------------------------------------------------------------------
test('ChannelFilter whitelist and blacklist work correctly', () => {
    const whitelist = new ChannelFilter({ whitelist: [3] });
    assert.ok(whitelist.process({ channel: 2, bytes: Buffer.from([0xb2, 16, 64]) })); // CH3 → pass
    assert.equal(whitelist.process({ channel: 3, bytes: Buffer.from([0xb2, 16, 64]) }), false); // CH4 → drop

    const blacklist = new ChannelFilter({ blacklist: [4] });
    assert.ok(blacklist.process({ channel: 2, bytes: Buffer.from([0xb2, 16, 64]) })); // CH3 → pass
    assert.equal(blacklist.process({ channel: 3, bytes: Buffer.from([0xb2, 16, 64]) }), false); // CH4 → blocked
});

// ---------------------------------------------------------------------------
// Test 10 — non-CC messages (note-on) are not transformed by CCMapper in routing
// ---------------------------------------------------------------------------
test('non-CC messages pass through unchanged in both all-to-all and routed paths', () => {
    const ccMapper = new CCMapper();

    // All-to-all: note-on on channel 3.
    let result = computeRoutingStep(
        [0x92, 60, 100],
        'Launchkey Mini MK3 MIDI Port',
        allToAllCtx(ccMapper)
    );
    assert.equal(result.dropped, null);
    assert.deepEqual(result.delivered[0].bytes, [0x92, 60, 100]);

    // Routed: note-on with channel filter.
    const mappings = new Map([['route1', {
        inputs: [{ name: 'Launchkey Mini MK3 MIDI Port' }],
        outputs: [{ name: 'Craft Synth 2.0' }],
        filters: [new ChannelFilter({ whitelist: [3] })],
    }]]);
    result = computeRoutingStep(
        [0x92, 60, 100],
        'Launchkey Mini MK3 MIDI Port',
        { outputs: outMap(['Craft Synth 2.0']), mappings, ccMapper }
    );
    assert.equal(result.dropped, null);
    assert.deepEqual(result.delivered[0].bytes, [0x92, 60, 100]);
});

// ---------------------------------------------------------------------------
// Test 11 — two routes with different ChannelFilter({map:{...}}) keep independent contexts
// Regression: ChannelFilter._process mutates via `map` (writes status nibble + channel).
// Two routes for the SAME input CC must each receive their own remapped output
// MIDI channel / status byte without leaking into one another. Also keeps
// whitelist/drop regression intact (verified in Tests 12–13).
// ---------------------------------------------------------------------------
test('two concurrent routes with different channel maps keep independent per-route context', () => {
    const ccMapper = new CCMapper();

    // Route A: input CH3 → output CH2 (0-based 1) — status byte must become 0xB1.
    // Route B: input CH3 → output CH8 (0-based 7) — status byte must become 0xB7.
    // Both routes listen on the same input port for the same CC#16 message.
    const mappings = new Map([
        ['routeA', {
            inputs: [{ name: 'Launchkey Mini MK3 MIDI Port' }],
            outputs: [{ name: 'Craft Synth 2.0' }],
            filters: [new ChannelFilter({ map: { 3: 2 } })],
        }],
        ['routeB', {
            inputs: [{ name: 'Launchkey Mini MK3 MIDI Port' }],
            outputs: [{ name: 'Korg NTS-1 digital kit' }],
            filters: [new ChannelFilter({ map: { 3: 8 } })],
        }],
    ]);

    // 0xb2 = CC on MIDI channel 3; CC#16 (Knob 1).
    const result = computeRoutingStep(
        [0xb2, 16, 64],
        'Launchkey Mini MK3 MIDI Port',
        { outputs: outMap(['Craft Synth 2.0', 'Korg NTS-1 digital kit']), mappings, ccMapper }
    );

    assert.equal(result.dropped, null);
    assert.equal(result.delivered.length, 2, 'both routes should deliver');

    // Route A delivers to Craft Synth with remapped channel status byte 0xB1 (ch2), CC7.
    const routeA = result.delivered.find((d) => d.output === 'Craft Synth 2.0');
    assert.ok(routeA, 'routeA output should be present');
    assert.equal(routeA.bytes[0], 0xb1, `status byte should encode CH2 (0xB1), got 0x${routeA.bytes[0].toString(16)}`);
    assert.equal(routeA.channel, 2, 'channel field should report 2');

    // Route B delivers to Korg with remapped channel status byte 0xB7 (ch8), CC16.
    const routeB = result.delivered.find((d) => d.output === 'Korg NTS-1 digital kit');
    assert.ok(routeB, 'routeB output should be present');
    assert.equal(routeB.bytes[0], 0xb7, `status byte should encode CH8 (0xB7), got 0x${routeB.bytes[0].toString(16)}`);
    assert.equal(routeB.channel, 8, 'channel field should report 8');
});

// ---------------------------------------------------------------------------
// Test 12 — two concurrent routes with different whitelist values stay independent
// (whitelist/drop regression: a ChannelFilter's channel check must not be
// influenced by another route's mutation of the shared filterCtx).
// ---------------------------------------------------------------------------
test('two concurrent routes with different whitelists keep independent context', () => {
    const ccMapper = new CCMapper();

    // Route A: whitelist CH3 — passes input on CH3.
    // Route B: whitelist CH4 — must NOT be affected by route A's filterCtx.channel mutation.
    const mappings = new Map([
        ['routeA', {
            inputs: [{ name: 'Launchkey Mini MK3 MIDI Port' }],
            outputs: [{ name: 'Craft Synth 2.0' }],
            filters: [new ChannelFilter({ whitelist: [3] })],
        }],
        ['routeB', {
            inputs: [{ name: 'Launchkey Mini MK3 MIDI Port' }],
            outputs: [{ name: 'Korg NTS-1 digital kit' }],
            filters: [new ChannelFilter({ whitelist: [4] })],
        }],
    ]);

    // 0xb2 = CC on channel 3. Route A should pass it; route B (channel 4) must drop it.
    const result = computeRoutingStep(
        [0xb2, 16, 64],
        'Launchkey Mini MK3 MIDI Port',
        { outputs: outMap(['Craft Synth 2.0', 'Korg NTS-1 digital kit']), mappings, ccMapper }
    );

    assert.equal(result.dropped, null);
    assert.equal(result.delivered.length, 1, 'only the route matching channel 3 delivers');
    assert.equal(result.delivered[0].output, 'Craft Synth 2.0');
});

// ---------------------------------------------------------------------------
// Test 13 — deliverRoutedMessages actually drives sendFn with real delivery data
// Regression: verify production code uses `result.delivered` (not a hand-rolled
// list) so transformCC output reaches the hardware.
// ---------------------------------------------------------------------------
test('deliverRoutedMessages drives sendFn with every delivered entry', async (t) => {
    const ccMapper = new CCMapper();
    const result = computeRoutingStep(
        [0xb2, 16, 64],
        'Launchkey Mini MK3 MIDI Port',
        allToAllCtx(ccMapper)
    );

    assert.equal(result.delivered.length, 1);

    const sent = [];
    const { deliverRoutedMessages } = await import('../route-midi.js');
    const n = deliverRoutedMessages(result, (output, buf) => {
        sent.push({ output, bytes: Array.from(buf) });
    });
    assert.equal(n, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].output, 'Craft Synth 2.0');
    // sendFn receives the transformed bytes (CC7), not the raw CC16.
    assert.deepEqual(sent[0].bytes, [0xb2, 0x07, 0x40]);
});

// ---------------------------------------------------------------------------
// Test 14 — ChannelFilter({map:{...}}) must never touch SysEx / System Common
// Regression: `type >= 8 && type <= 15` included 0xF0 (SysEx, type 15), so a
// channel map could turn 0xF0 into 0xF1. Verify SysEx bytes stay identical.
// ---------------------------------------------------------------------------
test('ChannelFilter({map:{1:2}}) leaves SysEx bytes unchanged', () => {
    const filter = new ChannelFilter({ map: { 1: 2 } });

    // SysEx frame: 0xF0 ... 0xF7 (end of system exclusive).
    const sysex = Buffer.from([0xF0, 0x00, 0x01, 0x02, 0xF7]);
    const result = filter.process({ channel: 0, bytes: sysex });

    assert.ok(result);
    assert.deepEqual(Array.from(result.bytes), [0xF0, 0x00, 0x01, 0x02, 0xF7],
        'SysEx bytes must not be altered by ChannelFilter map');
});
