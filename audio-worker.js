import { parentPort, workerData } from 'node:worker_threads';
import { AudioCapture } from './audio-capture.js';
import { OpusBroadcast } from './audio-opus.js';
import { answerOffer } from './audio-webrtc.js';

// The audio thread: the noise filter, the Opus encoder and the WebRTC peers. The main thread keeps the capture
// itself (arecord, the ring buffer, HTTP) and sends the raw PCM chunks here only while someone listens, so the
// heavy per-packet work cannot hold up the web server or the live notes that share its event loop.
const capture = new AudioCapture({ sampleRate: workerData.sampleRate, channels: workerData.channels, filter: workerData.filter });
const opus = new OpusBroadcast(capture, { quality: workerData.quality });
const calls = new Map();
let unsubscribeClean = null, unsubscribeOpus = null;

const post = (message, transfer) => parentPort.postMessage(message, transfer);

parentPort.on('message', async message => {
    switch (message.type) {
        case 'chunk':
            capture._emitClean(Buffer.from(message.data.buffer, message.data.byteOffset, message.data.byteLength));
            break;
        case 'filter':
            capture.setFilterLevel(message.level);
            break;
        case 'quality':
            opus.setQuality(message.quality);
            break;
        case 'clean':
            if (message.on && !unsubscribeClean) {
                unsubscribeClean = capture.subscribeClean(chunk => {
                    const copy = new Uint8Array(chunk);   // own memory, so it can be transferred
                    post({ type: 'clean', data: copy }, [copy.buffer]);
                });
            } else if (!message.on && unsubscribeClean) { unsubscribeClean(); unsubscribeClean = null; }
            break;
        case 'opus':
            if (message.on && !unsubscribeOpus) unsubscribeOpus = opus.subscribe(packet => post({ type: 'opus', packet: new Uint8Array(packet) }));
            else if (!message.on && unsubscribeOpus) { unsubscribeOpus(); unsubscribeOpus = null; }
            break;
        case 'offer':
            try {
                const call = await answerOffer(opus, message.sdp, { onClose: () => { calls.delete(message.id); post({ type: 'closed', id: message.id }); } });
                calls.set(message.id, call);
                post({ type: 'answer', id: message.id, sdp: call.sdp });
            } catch (error) {
                post({ type: 'answer', id: message.id, error: error.message });
            }
            break;
        case 'hangup':
            calls.get(message.id)?.close();
            break;
    }
});
post({ type: 'ready' });
