import { useRef, useState, useCallback } from "react";

type TTSAudioMessage = {
  type: "tts_audio";
  requestId: string;
  audio: string; // base64 PCM16LE
  sampleRate: number;
  isLastChunk: boolean;
};

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

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function useAudioPlayer() {
  const [speakingId, setSpeakingId] = useState<string | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const queueRef = useRef<AudioBuffer[]>([]);
  const isPlayingRef = useRef(false);
  const activeSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const currentRequestRef = useRef<string | null>(null);

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

  const playNext = useCallback(() => {
    const buf = queueRef.current.shift();
    if (!buf) {
      isPlayingRef.current = false;
      activeSourceRef.current = null;
      setSpeakingId(null);
      return;
    }

    const ctx = ctxRef.current;
    if (!ctx) {
      isPlayingRef.current = false;
      setSpeakingId(null);
      return;
    }

    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.connect(ctx.destination);
    activeSourceRef.current = source;
    source.onended = () => playNext();
    source.start();
  }, []);

  const stop = useCallback(() => {
    queueRef.current = [];
    currentRequestRef.current = null;

    if (activeSourceRef.current) {
      try {
        activeSourceRef.current.onended = null;
        activeSourceRef.current.stop();
      } catch { /* ignore */ }
      activeSourceRef.current = null;
    }

    isPlayingRef.current = false;
    setSpeakingId(null);
  }, []);

  const onTTSChunk = useCallback(async (msg: TTSAudioMessage) => {
    // Ignore chunks for a different request
    if (currentRequestRef.current && msg.requestId !== currentRequestRef.current) return;

    const ctx = await ensureContext();
    const bytes = base64ToUint8Array(msg.audio);
    const audioBuf = pcm16leToAudioBuffer(ctx, bytes, msg.sampleRate);

    queueRef.current.push(audioBuf);

    if (!isPlayingRef.current) {
      isPlayingRef.current = true;
      playNext();
    }
  }, [ensureContext, playNext]);

  const startSpeaking = useCallback((requestId: string) => {
    // If already speaking, stop first
    if (currentRequestRef.current) stop();
    currentRequestRef.current = requestId;
    setSpeakingId(requestId);
  }, [stop]);

  return { speakingId, onTTSChunk, startSpeaking, stop };
}
