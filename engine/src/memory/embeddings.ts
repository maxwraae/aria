import Database from "better-sqlite3";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EMBED_MODEL = "mxbai-embed-large";
const EMBED_DIMS = 1024;

// ── Ollama client ──────────────────────────────────────────────────

export async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });

  if (!res.ok) {
    throw new Error(`Ollama embed failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { embeddings: number[][] };
  return data.embeddings[0];
}

// ── Math ───────────────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function floatsToBuffer(floats: number[]): Buffer {
  const buf = Buffer.allocUnsafe(floats.length * 4);
  for (let i = 0; i < floats.length; i++) {
    buf.writeFloatLE(floats[i], i * 4);
  }
  return buf;
}

export function bufferToFloats(buf: Buffer): number[] {
  const floats: number[] = new Array(buf.length / 4);
  for (let i = 0; i < floats.length; i++) {
    floats[i] = buf.readFloatLE(i * 4);
  }
  return floats;
}

// ── Vector search ──────────────────────────────────────────────────

export interface VectorResult {
  id: string;
  content: string;
  type: string;
  created_at: number;
  similarity: number;
  rank: number;
}

export function searchVector(
  db: Database.Database,
  queryEmbedding: number[],
  limit: number = 20
): VectorResult[] {
  // Load all memories that have embeddings
  const rows = db
    .prepare("SELECT id, content, type, created_at, embedding FROM memories WHERE embedding IS NOT NULL")
    .all() as { id: string; content: string; type: string; created_at: number; embedding: Buffer }[];

  if (rows.length === 0) return [];

  // Compute cosine similarity for each
  const scored = rows.map((row) => ({
    id: row.id,
    content: row.content,
    type: row.type,
    created_at: row.created_at,
    similarity: cosineSimilarity(queryEmbedding, bufferToFloats(row.embedding)),
  }));

  // Sort by similarity descending, take top N
  scored.sort((a, b) => b.similarity - a.similarity);
  const top = scored.slice(0, limit);

  return top.map((r, i) => ({ ...r, rank: i + 1 }));
}

export { EMBED_DIMS, EMBED_MODEL };
