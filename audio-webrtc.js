import { RTCPeerConnection, RTCRtpCodecParameters, MediaStreamTrack, RtpPacket, RtpHeader } from 'werift';

// Live audio over WebRTC: the browser sends an SDP offer (POST /audio/webrtc), the router answers and then sends
// the shared Opus stream (see OpusBroadcast) as RTP over UDP. UDP never stalls behind a lost packet the way the
// TCP stream does, and the browser's own jitter buffer and decoder do the rest.
const OPUS_FRAME_TICKS = 960;   // 20 ms at 48 kHz
const PAYLOAD_TYPE = 111;
const GATHER_TIMEOUT_MS = 2000;

const AUDIO_CODEC = () => new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: PAYLOAD_TYPE, parameters: 'minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1' });

// Answers `offerSdp`. Resolves with { sdp, close }: the answer to hand back and the function that ends the call.
// `onClose` runs once when the call ends for any reason (the browser left, ICE failed, close()).
export async function answerOffer(opus, offerSdp, { onClose = () => {}, gatherTimeoutMs = GATHER_TIMEOUT_MS } = {}) {
    if (!opus?.available) throw new Error('Opus stream is not available');
    const pc = new RTCPeerConnection({ iceUseIpv6: false, codecs: { audio: [AUDIO_CODEC()], video: [] } });
    const track = new MediaStreamTrack({ kind: 'audio' });
    let unsubscribe = null, closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        unsubscribe = null;
        pc.close().catch(() => {});
        onClose();
    };
    try {
        await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
        const transceiver = pc.getTransceivers().find(t => t.kind === 'audio');
        if (!transceiver) throw new Error('The offer has no audio section');
        transceiver.direction = 'sendonly';
        transceiver.sender.registerTrack(track);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await Promise.race([
            new Promise(resolve => pc.iceGatheringStateChange.subscribe(state => { if (state === 'complete') resolve(); })),
            new Promise(resolve => setTimeout(resolve, gatherTimeoutMs)),
        ]);
    } catch (error) {
        close();
        throw error;
    }
    pc.connectionStateChange.subscribe(state => { if (state === 'failed' || state === 'closed' || state === 'disconnected') close(); });
    let sequence = Math.floor(Math.random() * 0xffff), timestamp = Math.floor(Math.random() * 0xffffffff);
    unsubscribe = opus.subscribe(framed => {
        // Packets arrive as a 2-byte length plus the Opus frame; RTP carries the bare frame.
        const payload = framed.subarray(2, 2 + framed.readUInt16BE(0));
        const header = new RtpHeader({ payloadType: PAYLOAD_TYPE, sequenceNumber: sequence, timestamp, marker: false });
        sequence = (sequence + 1) & 0xffff;
        timestamp = (timestamp + OPUS_FRAME_TICKS) >>> 0;
        try { track.writeRtp(new RtpPacket(header, payload)); } catch { /* the call is ending */ }
    });
    return { sdp: pc.localDescription.sdp, close };
}

// POST /audio/webrtc with {"sdp": "<offer>"} -> {"sdp": "<answer>"}. 503 when nothing is being captured or Opus is
// off (the browser then uses the HTTP stream), 400 for a bad offer.
export function serveWebRtcOffer(capture, opus, req, res) {
    const reply = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
    };
    const status = capture.status();
    if (status.state !== 'live') return reply(503, { error: status.error || `audio capture ${status.state}` });
    if (!opus?.available) return reply(503, { error: 'Opus stream is off' });
    let body = '';
    let tooBig = false;
    req.on('data', chunk => { body += chunk; if (body.length > 65536) { tooBig = true; req.destroy(); } });
    req.on('end', async () => {
        if (tooBig) return;
        let sdp;
        try { sdp = JSON.parse(body).sdp; } catch { /* handled below */ }
        if (typeof sdp !== 'string' || !sdp) return reply(400, { error: 'expected {"sdp": "..."}' });
        try {
            capture.listeners_++;
            const call = await answerOffer(opus, sdp, { onClose: () => { capture.listeners_ = Math.max(0, capture.listeners_ - 1); } });
            reply(200, { sdp: call.sdp, channels: capture.channels });
        } catch (error) {
            capture.listeners_ = Math.max(0, capture.listeners_ - 1);
            reply(400, { error: error.message });
        }
    });
}
