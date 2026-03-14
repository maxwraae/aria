import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function float32ToPcm16le(samples: Float32Array): Buffer {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = Math.round(clamped * 32767);
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

function chunkBuffer(buffer: Buffer, chunkBytes: number): Buffer[] {
  if (chunkBytes <= 0) return [buffer];
  const out: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += chunkBytes) {
    out.push(buffer.subarray(offset, Math.min(buffer.length, offset + chunkBytes)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text splitting
// ---------------------------------------------------------------------------

const MAX_TTS_SEGMENT_CHARS = 400;

function splitTextForTts(text: string, maxChars: number = MAX_TTS_SEGMENT_CHARS): string[] {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const parts: string[] = [];
  const sentenceChunks = normalized.split(/(?<=[.!?])\s+/);
  let current = "";

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) parts.push(trimmed);
    current = "";
  };

  const appendFragment = (fragment: string) => {
    const trimmed = fragment.trim();
    if (!trimmed) return;
    if (!current) { current = trimmed; return; }
    const candidate = `${current} ${trimmed}`;
    if (candidate.length <= maxChars) { current = candidate; return; }
    pushCurrent();
    current = trimmed;
  };

  const splitLargeFragment = (fragment: string): string[] => {
    const trimmed = fragment.trim();
    if (trimmed.length <= maxChars) return [trimmed];
    const out: string[] = [];
    let remaining = trimmed;
    while (remaining.length > maxChars) {
      let idx = remaining.lastIndexOf(" ", maxChars);
      if (idx < Math.floor(maxChars * 0.5)) idx = maxChars;
      out.push(remaining.slice(0, idx).trim());
      remaining = remaining.slice(idx).trim();
    }
    if (remaining.length > 0) out.push(remaining);
    return out;
  };

  for (const sentence of sentenceChunks) {
    for (const fragment of splitLargeFragment(sentence)) {
      appendFragment(fragment);
    }
  }
  pushCurrent();
  return parts;
}

// ---------------------------------------------------------------------------
// AriaTTS class
// ---------------------------------------------------------------------------

const MODEL_DIR = path.join(os.homedir(), '.paseo/models/local-speech/kokoro-en-v0_19');

type OnChunk = (audio: string, sampleRate: number, isLastChunk: boolean) => void;

class AriaTTS {
  private readonly tts: any;
  private readonly sampleRate: number;

  constructor() {
    // Load sherpa-onnx-node via createRequire
    const require = createRequire(import.meta.url);
    let sherpa: any;
    try {
      sherpa = require('sherpa-onnx-node');
    } catch {
      // If direct require fails, try loading the .node addon from the platform package
      const platformPkgDir = path.dirname(require.resolve('sherpa-onnx-darwin-arm64/package.json'));
      const addonPath = path.join(platformPkgDir, 'sherpa-onnx.node');
      sherpa = require(addonPath);
    }

    const modelPath = path.join(MODEL_DIR, 'model.onnx');
    const voicesPath = path.join(MODEL_DIR, 'voices.bin');
    const tokensPath = path.join(MODEL_DIR, 'tokens.txt');
    const dataDir = path.join(MODEL_DIR, 'espeak-ng-data');

    // Validate model files exist
    for (const [label, p] of [['model', modelPath], ['voices', voicesPath], ['tokens', tokensPath], ['espeak-ng-data', dataDir]] as const) {
      if (!existsSync(p)) throw new Error(`Missing TTS ${label}: ${p}`);
    }

    const config = {
      model: {
        kokoro: {
          model: modelPath,
          voices: voicesPath,
          tokens: tokensPath,
          dataDir,
          lengthScale: 1.0,
        },
      },
      numThreads: 2,
      provider: 'cpu',
      maxNumSentences: 1,
    };

    this.tts = new sherpa.OfflineTts(config);
    this.sampleRate = typeof this.tts.sampleRate === 'number' ? this.tts.sampleRate : 24000;
    console.log(`[tts] Kokoro initialized (sample rate: ${this.sampleRate})`);
  }

  /** Synthesize a single segment to PCM16LE chunks */
  private synthesizeSegment(text: string): { chunks: Buffer[]; sampleRate: number } {
    const audio = this.tts.generate({ text, sid: 0, speed: 1.0 });
    const samples: Float32Array = audio.samples instanceof Float32Array
      ? audio.samples
      : Float32Array.from(audio.samples as number[]);

    const sampleRate = typeof audio.sampleRate === 'number' && audio.sampleRate > 0
      ? audio.sampleRate
      : this.sampleRate;

    const pcm16 = float32ToPcm16le(samples);
    const chunkBytes = Math.max(2, Math.round(sampleRate * 0.05) * 2); // ~50ms chunks
    return { chunks: chunkBuffer(pcm16, chunkBytes), sampleRate };
  }

  /** Synthesize text with streaming callback. Splits into segments, generates each, streams chunks. */
  async synthesizeStreaming(text: string, onChunk: OnChunk): Promise<void> {
    const segments = splitTextForTts(text);
    if (segments.length === 0) return;

    for (let s = 0; s < segments.length; s++) {
      const { chunks, sampleRate } = this.synthesizeSegment(segments[s]!);
      const isLastSegment = s === segments.length - 1;

      for (let c = 0; c < chunks.length; c++) {
        const isLastChunk = isLastSegment && c === chunks.length - 1;
        onChunk(chunks[c]!.toString('base64'), sampleRate, isLastChunk);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton lazy initializer
// ---------------------------------------------------------------------------

let instance: AriaTTS | null = null;
let initAttempted = false;

export function getTTS(): AriaTTS | null {
  if (instance) return instance;
  if (initAttempted) return null;
  initAttempted = true;

  if (!existsSync(MODEL_DIR)) {
    console.warn(`[tts] Kokoro model not found at ${MODEL_DIR} — TTS disabled`);
    return null;
  }

  try {
    instance = new AriaTTS();
    return instance;
  } catch (err) {
    console.error('[tts] Failed to initialize:', err);
    return null;
  }
}

export type { OnChunk };
