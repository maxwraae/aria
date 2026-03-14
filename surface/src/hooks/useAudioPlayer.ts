import { useRef, useState, useCallback } from "react";

type TTSAudioMessage = {
  type: "tts_audio";
  requestId: string;
  audio: string; // base64 PCM16LE
  sampleRate: number;
  isLastChunk: boolean;
};

type BufferedChunk = {
  audio: string;
  sampleRate: number;
};

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function pcm16leToAudioBuffer(
  ctx: AudioContext,
  bytes: Uint8Array,
  sampleRate: number
): AudioBuffer {
  const sampleCount = Math.floor(bytes.length / 2);
  const buf = ctx.createBuffer(1, sampleCount, sampleRate);
  const channel = buf.getChannelData(0);
  for (let i = 0; i < sampleCount; i++) {
    const lo = bytes[i * 2]!;
    const hi = bytes[i * 2 + 1]!;
    let value = (hi << 8) | lo;
    if (value & 0x8000) value = value - 0x10000;
    channel[i] = value / 0x8000;
  }
  return buf;
}

/**
 * Audio player for TTS. Buffers all chunks until isLastChunk,
 * concatenates into one AudioBuffer, then plays.
 * Matches the proven Paseo/aiMessage pattern.
 */
export function useAudioPlayer() {
  const [speakingId, setSpeakingId] = useState<string | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const activeSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const currentRequestRef = useRef<string | null>(null);
  const chunkBufferRef = useRef<BufferedChunk[]>([]);

  const ensureContext = useCallback(async (): Promise<AudioContext> => {
    if (ctxRef.current) {
      if (ctxRef.current.state === "suspended") {
        try { await ctxRef.current.resume(); } catch { /* best effort */ }
      }
      return ctxRef.current;
    }
    const ctx = new AudioContext();
    if (ctx.state === "suspended") {
      try { await ctx.resume(); } catch { /* best effort */ }
    }
    ctxRef.current = ctx;
    return ctx;
  }, []);

  const stop = useCallback(() => {
    chunkBufferRef.current = [];
    currentRequestRef.current = null;

    if (activeSourceRef.current) {
      try {
        activeSourceRef.current.onended = null;
        activeSourceRef.current.stop();
      } catch { /* ignore */ }
      activeSourceRef.current = null;
    }

    setSpeakingId(null);
  }, []);

  const onTTSChunk = useCallback(async (msg: TTSAudioMessage) => {
    // Ignore chunks for a different request
    if (currentRequestRef.current && msg.requestId !== currentRequestRef.current) return;

    console.log('[TTS] chunk received, isLast:', msg.isLastChunk, 'buffered:', chunkBufferRef.current.length);

    // Buffer the chunk
    chunkBufferRef.current.push({ audio: msg.audio, sampleRate: msg.sampleRate });

    // Wait until we have all chunks
    if (!msg.isLastChunk) return;

    // All chunks received — concatenate and play
    const chunks = chunkBufferRef.current;
    chunkBufferRef.current = [];

    console.log('[TTS] all chunks received:', chunks.length, '— concatenating and playing');

    // Decode all chunks to bytes
    const decodedChunks: Uint8Array[] = [];
    let totalSize = 0;
    for (const chunk of chunks) {
      const bytes = base64ToUint8Array(chunk.audio);
      decodedChunks.push(bytes);
      totalSize += bytes.length;
    }

    // Concatenate
    const concatenated = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of decodedChunks) {
      concatenated.set(chunk, offset);
      offset += chunk.length;
    }

    // Play
    try {
      const ctx = await ensureContext();
      const sampleRate = chunks[0]?.sampleRate ?? 24000;
      const audioBuf = pcm16leToAudioBuffer(ctx, concatenated, sampleRate);

      console.log('[TTS] playing audio, duration:', audioBuf.duration.toFixed(2) + 's');

      const source = ctx.createBufferSource();
      source.buffer = audioBuf;
      source.connect(ctx.destination);
      activeSourceRef.current = source;
      source.onended = () => {
        activeSourceRef.current = null;
        setSpeakingId(null);
        currentRequestRef.current = null;
        console.log('[TTS] playback finished');
      };
      source.start();
    } catch (err) {
      console.error('[TTS] playback error:', err);
      setSpeakingId(null);
      currentRequestRef.current = null;
    }
  }, [ensureContext]);

  const startSpeaking = useCallback((requestId: string) => {
    if (currentRequestRef.current) stop();
    chunkBufferRef.current = [];
    currentRequestRef.current = requestId;
    setSpeakingId(requestId);
  }, [stop]);

  return { speakingId, onTTSChunk, startSpeaking, stop };
}
