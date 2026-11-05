import test from 'node:test';
import assert from 'node:assert/strict';
import { findOutputs, resolveOutputDevice, parsePlaybackCards } from '../metronome-controller.js';

const PI4 = `**** List of PLAYBACK Hardware Devices ****
card 0: vc4hdmi0 [vc4-hdmi-0], device 0: MAI PCM i2s-hifi-0 [MAI PCM i2s-hifi-0]
card 1: Headphones [bcm2835 Headphones], device 0: bcm2835 Headphones [bcm2835 Headphones]
card 2: CODEC [USB Audio CODEC], device 0: USB Audio [USB Audio]
`;
const ZERO = `card 0: CODEC [USB Audio CODEC], device 0: USB Audio [USB Audio]\n`;

test('parsePlaybackCards lists every card', () => {
    assert.deepEqual(parsePlaybackCards(PI4).map(c => c.id), ['vc4hdmi0', 'Headphones', 'CODEC']);
});

test('findOutputs sees jack and USB on a Pi 4', () => {
    assert.deepEqual(findOutputs(PI4), { hdmi: 'plughw:CARD=vc4hdmi0,DEV=0', jack: 'hw:Headphones', usb: 'plughw:CARD=CODEC,DEV=0' });
});

test('a Zero 2 W has no jack', () => {
    assert.equal(resolveOutputDevice('jack', ZERO), null);
    assert.equal(resolveOutputDevice('usb', ZERO), 'plughw:CARD=CODEC,DEV=0');
});

test('hdmi resolves to the HDMI card', () => {
    assert.equal(resolveOutputDevice('hdmi', PI4), 'plughw:CARD=vc4hdmi0,DEV=0');
    assert.equal(resolveOutputDevice('hdmi', ZERO), null);
});

test('auto leaves the choice to metronome.py', () => {
    assert.equal(resolveOutputDevice('auto', PI4), null);
});
