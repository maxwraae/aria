/**
 * One-time backfill: embed all memories that don't have an embedding yet.
 * Run with: npx tsx src/memory/backfill.ts
 *
 * Uses mxbai-embed-large via Ollama (must be running on localhost:11434).
 * Stores embeddings as float32 BLOBs in memories.embedding column.
 * Safe to re-run — only processes rows WHERE embedding IS NULL.
 */

import Database from "better-sqlite3";
import { getEmbedding, floatsToBuffer } from "./embeddings.js";
import { MEMORIES_DB_PATH } from "../context/bricks/memory/index.js";

const BATCH_SIZE = 1;  // sequential — Ollama processes one at a time anyway
const BATCH_PAUSE_MS = 100; // brief pause between calls

async function backfill(): Promise<void> {
  const db = new Database(MEMORIES_DB_PATH);
  db.pragma("journal_mode = WAL");

  const rows = db
    .prepare("SELECT id, content FROM memories WHERE embedding IS NULL ORDER BY created_at ASC")
    .all() as { id: string; content: string }[];

  if (rows.length === 0) {
    console.log("All memories already have embeddings.");
    db.close();
    return;
  }

  console.log(`Backfilling ${rows.length} memories with embeddings...`);

  const update = db.prepare("UPDATE memories SET embedding = ? WHERE id = ?");
  let done = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map((r) => getEmbedding(r.content))
    );

    const storeEmbeddings = db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const result = results[j];
        if (result.status === "fulfilled") {
          update.run(floatsToBuffer(result.value), batch[j].id);
          done++;
        } else {
          errors++;
          process.stderr.write(`\nFailed to embed ${batch[j].id}: ${result.reason}\n`);
        }
      }
    });
    storeEmbeddings();

    process.stdout.write(`\r${done + errors}/${rows.length} (${done} ok, ${errors} errors)`);
    await new Promise(resolve => setTimeout(resolve, BATCH_PAUSE_MS));
  }

  console.log(`\nDone. ${done} embedded, ${errors} errors.`);

  if (errors > 0) {
    console.log("Re-run to retry failed memories.");
  }

  db.close();
}

backfill().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
