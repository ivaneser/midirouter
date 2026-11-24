import test from 'node:test';
import assert from 'node:assert/strict';
import { RTCPeerConnection, RTCRtpCodecParameters } from 'werift';
import { ThreadedAudioCapture } from '../audio-thread.js';

const FRAME = 960;   // 20 ms at 48 kHz

function tone(phase) {
    const bytes = Buffer.alloc(FRAME * 4);
    for (let i = 0; i < FRAME; i++) {
        const v = Math.round(Math.sin((phase + i) * 2 * Math.PI * 440 / 48000) * 8000);
        bytes.writeInt16LE(v, i * 4);
        bytes.writeInt16LE(v, i * 4 + 2);
    }
    return bytes;
}

// A capture that is fed by the test instead of arecord, with its audio thread running.
function makeCapture(options = {}) {
    const capture = new ThreadedAudioCapture({ sampleRate: 48000, channels: 2, filter: 'off', quality: 'opus-96', ...options });
    capture._spawn();
    return capture;
}

const feed = async (capture, frames, gap = 20) => {
    for (let n = 0; n < frames; n++) {
        capture._onData(tone(n * FRAME));
        await new Promise(resolve => setTimeout(resolve, gap));
    }
};

test('Opus packets are made on the audio thread and come back framed', async () => {
    const capture = makeCapture();
    try {
        const packets = [];
        const off = capture.opus.subscribe(packet => packets.push(packet));
        await new Promise(resolve => setTimeout(resolve, 300));   // the worker starts
        await feed(capture, 40);
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.ok(packets.length >= 25, `${packets.length} packets`);
        for (const packet of packets) assert.equal(packet.readUInt16BE(0), packet.length - 2);
        off();
        assert.equal(capture.opusOn, false, 'the worker stops encoding when nobody listens');
    } finally { capture.stop(); }
});

test('the cleaned stream passes through the thread, and chunks only travel while someone listens', async () => {
    const capture = makeCapture();
    try {
        const sent = [];
        const post = capture.worker.postMessage.bind(capture.worker);
        capture.worker.postMessage = (message, transfer) => { sent.push(message.type); post(message, transfer); };
        capture._onData(tone(0));
        assert.ok(!sent.includes('chunk'), 'nobody listens: nothing is sent');
        const got = [];
        const off = capture.subscribeClean(chunk => got.push(chunk));
        await new Promise(resolve => setTimeout(resolve, 300));
        await feed(capture, 10);
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(got.length, 10);
        assert.deepEqual(got[3], tone(3 * FRAME), 'filter off: the audio unchanged');
        off();
    } finally { capture.stop(); }
});

test('a WebRTC call is answered on the audio thread and receives its RTP', async () => {
    const capture = makeCapture();
    const client = new RTCPeerConnection({ iceUseIpv6: false, codecs: { audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 111 })], video: [] } });
    try {
        const received = [];
        client.addTransceiver('audio', { direction: 'recvonly' });
        client.onTrack.subscribe(track => track.onReceiveRtp.subscribe(rtp => received.push(rtp)));
        await client.setLocalDescription(await client.createOffer());
        let closed = false;
        const call = await capture.opus.answerOffer(client.localDescription.sdp, { onClose: () => { closed = true; } });
        assert.match(call.sdp, /a=candidate:/);
        await client.setRemoteDescription({ type: 'answer', sdp: call.sdp });
        for (let n = 0; n < 200 && received.length < 3; n++) { capture._onData(tone(n * FRAME)); await new Promise(resolve => setTimeout(resolve, 20)); }
        assert.ok(received.length >= 3, 'RTP reached the client');
        call.close();
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.ok(closed, 'the call reports that it ended');
        assert.equal(capture.calls.size, 0);
    } finally { await client.close(); capture.stop(); }
});

test('the audio thread restarts after it dies and listeners carry on', async () => {
    const capture = makeCapture();
    try {
        const packets = [];
        capture.opus.subscribe(packet => packets.push(packet));
        await new Promise(resolve => setTimeout(resolve, 300));
        await capture.worker.terminate();
        await new Promise(resolve => setTimeout(resolve, 1600));
        assert.ok(capture.worker, 'a new thread is running');
        await feed(capture, 30);
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.ok(packets.length >= 15, `${packets.length} packets after the restart`);
    } finally { capture.stop(); }
});
