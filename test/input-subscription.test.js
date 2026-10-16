import test from 'node:test';
import assert from 'node:assert/strict';
import { aconnectPortDisplayName, isInputSubscribed } from '../alsa-subscriptions.js';

// Real `aconnect -l` output captured while the NTS-1 clock master was silent
// (its subscription to the router input was gone).
const LOST = `client 0: 'System' [type=kernel]
    0 'Timer           '
client 20: 'NTS-1 digital kit' [type=kernel,card=1]
    0 'NTS-1 digital kit _ SOUND'
	Connected From: 132:0[real:0]
client 28: 'Craft Synth 2.0' [type=kernel,card=3]
    0 'Craft Synth 2.0 MIDI 1'
	Connecting To: 131:0
	Connected From: 133:0[real:0], 137:0[real:0]
client 130: 'RtMidi Input Client' [type=user,pid=938]
    0 'RtMidi Input    '
client 131: 'RtMidi Input Client' [type=user,pid=938]
    0 'RtMidi Input    '
	Connected From: 28:0
`;

// Same system after the router was restarted: NTS-1 sends to RtMidi input 130.
const OK = `client 20: 'NTS-1 digital kit' [type=kernel,card=1]
    0 'NTS-1 digital kit _ SOUND'
	Connecting To: 130:0
	Connected From: 133:0[real:0]
client 130: 'RtMidi Input Client' [type=user,pid=2607]
    0 'RtMidi Input    '
	Connected From: 20:0
`;

test('aconnectPortDisplayName strips the client id and the ALSA address', () => {
    assert.equal(aconnectPortDisplayName('NTS-1 digital kit:NTS-1 digital kit _ SOUND 20:0'), 'NTS-1 digital kit _ SOUND');
    assert.equal(aconnectPortDisplayName('Craft Synth 2.0:Craft Synth 2.0 MIDI 1 28:0'), 'Craft Synth 2.0 MIDI 1');
});

test('a device port without a subscription to an RtMidi input is reported as not subscribed', () => {
    assert.equal(isInputSubscribed(LOST, 'NTS-1 digital kit _ SOUND'), false);
});

test('a device port that sends to an RtMidi input is reported as subscribed', () => {
    assert.equal(isInputSubscribed(OK, 'NTS-1 digital kit _ SOUND'), true);
});

test('a device port that only receives from us (output side) does not count as an input subscription', () => {
    // Craft has "Connecting To: 131:0" (into our input) in LOST, so it is subscribed.
    assert.equal(isInputSubscribed(LOST, 'Craft Synth 2.0 MIDI 1'), true);
});

test('a port absent from the listing returns null (hot-plug handles it)', () => {
    assert.equal(isInputSubscribed(LOST, 'Launchkey Mini MK3 DAW'), null);
});
