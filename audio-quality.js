// Opus runs at 48 kHz. Kept apart from audio-opus.js so the main thread does not load the codec itself.
export const OPUS_RATE = 48000;

// "opus-96" -> 96000 bit/s; "pcm" (or anything else) -> null.
export function qualityBitrate(quality) {
    const match = /^opus-(\d+)$/.exec(String(quality));
    return match ? Number(match[1]) * 1000 : null;
}
