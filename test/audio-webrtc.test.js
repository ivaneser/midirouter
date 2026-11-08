import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RTCPeerConnection, RTCRtpCodecParameters } from 'werift';
import { answerOffer } from '../audio-webrtc.js';

class FakeOpus extends EventEmitter {
    available = true;
    count = 0;
    subscribe(fn) { this.count++; this.on('packet', fn); return () => { this.off('packet', fn); this.count--; }; }
}

function framed(bytes) {
    const out = Buffer.allocUnsafe(2 + bytes.length);
    out.writeUInt16BE(bytes.length, 0);
    Buffer.from(bytes).copy(out, 2);
    return out;
}

test('the router answers an audio offer and sends the Opus packets as RTP', async () => {
    const opus = new FakeOpus();
    const client = new RTCPeerConnection({ iceUseIpv6: false, codecs: { audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 111 })], video: [] } });
    const received = [];
    client.addTransceiver('audio', { direction: 'recvonly' });
    client.onTrack.subscribe(track => track.onReceiveRtp.subscribe(rtp => received.push(rtp)));
    await client.setLocalDescription(await client.createOffer());
    const call = await answerOffer(opus, client.localDescription.sdp);
    assert.match(call.sdp, /a=candidate:/, 'the answer carries the ICE candidates (no trickle)');
    assert.match(call.sdp, /opus\/48000/);
    await client.setRemoteDescription({ type: 'answer', sdp: call.sdp });
    assert.equal(opus.count, 1);
    const frame = [1, 2, 3, 4, 5];
    for (let i = 0; i < 200 && received.length < 3; i++) {
        opus.emit('packet', framed(frame));
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(received.length >= 3, 'RTP reached the client');
    assert.deepEqual([...received[0].payload], frame);
    const [a, b] = received;
    assert.equal((b.header.timestamp - a.header.timestamp) >>> 0, 960 * (b.header.sequenceNumber - a.header.sequenceNumber & 0xffff));
    call.close();
    assert.equal(opus.count, 0, 'closing the call stops the encoder subscription');
    await client.close();
});

test('an offer without audio, or an unavailable stream, is refused and subscribes to nothing', async () => {
    const opus = new FakeOpus();
    await assert.rejects(answerOffer({ ...opus, available: false }, 'v=0'), /not available/);
    await assert.rejects(answerOffer(opus, 'garbage'));
    assert.equal(opus.count, 0);
});
