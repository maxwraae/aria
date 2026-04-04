/**
 * Embedding daemon — runs inside the engine process.
 * Continuously picks unembedded memories one at a time, embeds them via Ollama,
 * and stores the result. Sleeps when caught up or when Ollama is unavailable.
 */

import Database from "better-sqlite3";
import { getEmbedding, floatsToBuffer } from "./embeddings.js";
import { initMemoryTables } from "./schema.js";
import { MEMORIES_DB_PATH } from "../context/bricks/memory/index.js";

const IDLE_POLL_MS = 30_000; // wait when no memories need embedding
const BETWEEN_EMBED_MS = 150; // pause between each embed to avoid congesting system

function openDb(): Database.Database | null {
  try {
    const db = new Database(MEMORIES_DB_PATH);
    initMemoryTables(db); // runs migrations (idempotent — safe to call every time)
    return db;
  } catch {
    return null;
  }
}

export function startEmbedDaemon(): void {
  async function tick(): Promise<void> {
    const db = openDb();
    if (!db) {
      setTimeout(tick, IDLE_POLL_MS);
      return;
    }

    try {
      const row = db
        .prepare("SELECT id, content FROM memories WHERE embedding IS NULL ORDER BY created_at ASC LIMIT 1")
        .get() as { id: string; content: string } | undefined;

      if (!row) {
        // Caught up — poll again later
        setTimeout(tick, IDLE_POLL_MS);
        return;
      }

      const embedding = await getEmbedding(row.content);
      db.prepare("UPDATE memories SET embedding = ? WHERE id = ?")
        .run(floatsToBuffer(embedding), row.id);

      setTimeout(tick, BETWEEN_EMBED_MS);
    } catch {
      // Ollama unavailable or error — back off and retry
      setTimeout(tick, IDLE_POLL_MS);
    } finally {
      db.close();
    }
  }

  // Start after a short delay so engine boot completes first
  setTimeout(tick, 5_000);
}
