/**
 * MEMORY BRICK — V2
 *
 * 6-search retrieval pipeline:
 *   BM25-tight  (current message + prev turn)
 *   BM25-broad  (objective + parent)
 *   Vector-message, Vector-prevTurn, Vector-objective, Vector-parent
 *     (pre-computed embeddings passed via ctx.memoryEmbeddings from spawn.ts)
 *
 * Pool → contextuality expansion → MMR diversity → inject
 * After every turn: injected IDs written to turn record → incrementEdges called
 *
 * Gracefully degrades to BM25-only if ctx.memoryEmbeddings is null (Ollama down).
 */

import os from "os";
import path from "path";
import fs from "fs";
import Database from "better-sqlite3";
import type { Brick, BrickContext, BrickResult } from "../../types.js";
import { countTokens } from "../../tokens.js";
import {
  buildFtsQuery,
  searchBM25,
  getTopEdges,
  getMemoryById,
} from "../../../memory/queries.js";
import { initMemoryTables } from "../../../memory/schema.js";
import {
  searchVector,
  bufferToFloats,
  cosineSimilarity,
} from "../../../memory/embeddings.js";

export const MEMORIES_DB_PATH = path.join(
  os.homedir(),
  "Library",
  "Mobile Documents",
  "com~apple~CloudDocs",
  "Aria",
  "data",
  "memories.db"
);

const DEFAULT_MAX_TOKENS = 3000;
const MMR_LAMBDA = 0.7; // 0 = max diversity, 1 = pure relevance

export function openMemoriesDb(dbPath: string = MEMORIES_DB_PATH): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

export function openMemoriesDbWritable(dbPath: string = MEMORIES_DB_PATH): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath);
    initMemoryTables(db); // runs migrations (idempotent)
    return db;
  } catch {
    return null;
  }
}

type PoolEntry = { score: number; content: string; type: string; created_at: number };

const DEBUG = !!process.env.ARIA_MEMORY_DEBUG;
function dbg(msg: string) { if (DEBUG) process.stderr.write(`[memory] ${msg}\n`); }

const memoryBrick: Brick = {
  name: "MEMORIES",
  type: "matched",

  render(ctx: BrickContext): BrickResult | null {
    if (!ctx.db || !ctx.objectiveId) return null;
    const db = ctx.db as Database.Database;

    // ── 1. Gather context from engine DB ──────────────────────────

    const obj = db
      .prepare("SELECT objective, description, work_path FROM objectives WHERE id = ?")
      .get(ctx.objectiveId) as { objective: string; description: string | null; work_path: string | null } | undefined;
    if (!obj?.objective) return null;

    // Read work document if it exists
    let workContent = '';
    if (obj.work_path) {
      try { workContent = fs.readFileSync(obj.work_path, 'utf-8').trim(); } catch {}
    }

    const parent = db
      .prepare(`
        SELECT o2.objective, o2.description
        FROM objectives o1
        JOIN objectives o2 ON o1.parent = o2.id
        WHERE o1.id = ?
      `)
      .get(ctx.objectiveId) as { objective: string; description: string | null } | undefined;

    const currentMsg = db
      .prepare(
        "SELECT message FROM inbox WHERE objective_id = ? AND turn_id IS NULL ORDER BY created_at ASC LIMIT 1"
      )
      .get(ctx.objectiveId) as { message: string } | undefined;

    const prevMessages = db
      .prepare(
        "SELECT message FROM inbox WHERE objective_id = ? AND turn_id IS NOT NULL ORDER BY created_at DESC LIMIT 2"
      )
      .all(ctx.objectiveId) as { message: string }[];

    // ── 2. Build text sources ─────────────────────────────────────

    const tightText = [currentMsg?.message, ...prevMessages.map((m) => m.message)]
      .filter(Boolean)
      .join(" ");
    const broadText = [
      obj.objective,
      obj.description,
      parent?.objective,
      parent?.description,
    ]
      .filter(Boolean)
      .join(" ");

    const tightQuery = buildFtsQuery(tightText);
    const broadQuery = buildFtsQuery(broadText);
    const workQuery = workContent ? buildFtsQuery(workContent) : '';

    // ── 3. Open memories DB ───────────────────────────────────────

    const memoriesDb = openMemoriesDb();
    if (!memoriesDb) return null;

    try {
      // ── 4. Run 6 searches ───────────────────────────────────────

      // BM25 (synchronous)
      const bm25Tight = tightQuery ? searchBM25(memoriesDb, tightQuery, 20) : [];
      const bm25Broad = broadQuery ? searchBM25(memoriesDb, broadQuery, 20) : [];
      const bm25Work  = workQuery  ? searchBM25(memoriesDb, workQuery,  20) : [];

      // Vector (pre-computed embeddings from spawn.ts — null if Ollama unavailable)
      const emb = ctx.memoryEmbeddings;
      const vecMessage  = emb?.message   ? searchVector(memoriesDb, emb.message,   20) : [];
      const vecPrev     = emb?.prevTurn  ? searchVector(memoriesDb, emb.prevTurn,  20) : [];
      const vecObj      = emb?.objective ? searchVector(memoriesDb, emb.objective, 20) : [];
      const vecParent   = emb?.parent    ? searchVector(memoriesDb, emb.parent,    20) : [];
      const vecWork     = emb?.work      ? searchVector(memoriesDb, emb.work,      20) : [];

      dbg(`searches: bm25-tight=${bm25Tight.length} bm25-broad=${bm25Broad.length} bm25-work=${bm25Work.length} vec-msg=${vecMessage.length} vec-prev=${vecPrev.length} vec-obj=${vecObj.length} vec-parent=${vecParent.length} vec-work=${vecWork.length}`);
      dbg(`embeddings available: ${emb ? 'yes' : 'no (BM25-only mode)'}`);

      // ── 5. Build pool with normalized rank scoring ──────────────

      const pool = new Map<string, PoolEntry>();

      const addToPool = (
        results: Array<{ id: string; content: string; type: string; created_at: number; rank: number }>
      ) => {
        const n = results.length;
        for (const r of results) {
          const normRank = 1 - (r.rank - 1) / Math.max(n - 1, 1);
          const existing = pool.get(r.id);
          if (existing) {
            existing.score += normRank;
          } else {
            pool.set(r.id, {
              score: normRank,
              content: r.content,
              type: r.type,
              created_at: r.created_at,
            });
          }
        }
      };

      for (const results of [bm25Tight, bm25Broad, bm25Work, vecMessage, vecPrev, vecObj, vecParent, vecWork]) {
        addToPool(results);
      }

      dbg(`pool after scoring: ${pool.size} unique memories`);

      // ── 6. Contextuality expansion (one hop) ────────────────────

      const poolSizeBefore = pool.size;
      const candidateIds = [...pool.keys()];
      for (const id of candidateIds) {
        const edges = getTopEdges(memoriesDb, id, 20);
        if (edges.length === 0) continue;

        const parentScore = pool.get(id)!.score;
        const maxWeight = edges[0].count;

        for (const edge of edges) {
          const neighborId = edge.memory_a === id ? edge.memory_b : edge.memory_a;
          const inheritedScore = parentScore * (edge.count / maxWeight);
          const existing = pool.get(neighborId);
          if (existing) {
            existing.score += inheritedScore;
          } else {
            const memory = getMemoryById(memoriesDb, neighborId);
            if (memory) {
              pool.set(neighborId, {
                score: inheritedScore,
                content: memory.content,
                type: memory.type,
                created_at: memory.created_at,
              });
            }
          }
        }
      }

      dbg(`contextuality: ${pool.size - poolSizeBefore} neighbors added (pool: ${poolSizeBefore} → ${pool.size})`);

      // ── 7. Batch-load embeddings for MMR ────────────────────────

      const poolIds = [...pool.keys()];
      const embRows = memoriesDb
        .prepare(
          `SELECT id, embedding FROM memories WHERE id IN (${poolIds.map(() => "?").join(",")}) AND embedding IS NOT NULL`
        )
        .all(...poolIds) as { id: string; embedding: Buffer }[];
      const poolEmbeddings = new Map(embRows.map((r) => [r.id, bufferToFloats(r.embedding)]));

      // ── 9. MMR diversity selection ───────────────────────────────

      const brickConf = ctx.config as Record<string, unknown>;
      const memoriesConf = (brickConf?.bricks as Record<string, unknown>)
        ?.memories as Record<string, number> | undefined;
      const maxTokens = memoriesConf?.max_tokens ?? DEFAULT_MAX_TOKENS;

      const sorted = [...pool.entries()].sort((a, b) => b[1].score - a[1].score);

      if (DEBUG) {
        dbg(`top 5 before MMR:`);
        for (const [id, c] of sorted.slice(0, 5)) {
          dbg(`  score=${c.score.toFixed(3)} "${c.content.slice(0, 70)}"`);
        }
        dbg(`embeddings loaded for MMR: ${poolEmbeddings.size}/${pool.size}`);
        dbg(`token budget: ${maxTokens}`);
      }

      const header = "# RELEVANT MEMORIES\n";
      let usedTokens = countTokens(header);
      const lines: string[] = [];
      const selectedIds: string[] = [];
      const selectedEmbs: number[][] = [];
      const metaMatches: Array<{ label: string; tokens: number; included: boolean }> = [];

      for (const [id, candidate] of sorted) {
        const date = new Date(candidate.created_at * 1000).toISOString().slice(0, 10);
        const line = `- [${date}] ${candidate.content}`;
        const lineTokens = countTokens(line);

        if (usedTokens + lineTokens > maxTokens) {
          metaMatches.push({ label: candidate.content.slice(0, 60), tokens: lineTokens, included: false });
          continue;
        }

        // MMR: penalize similarity to already-selected memories
        let mmrScore = candidate.score;
        const candidateEmb = poolEmbeddings.get(id);
        if (candidateEmb && selectedEmbs.length > 0) {
          const maxSim = Math.max(...selectedEmbs.map((se) => cosineSimilarity(candidateEmb, se)));
          mmrScore = MMR_LAMBDA * candidate.score - (1 - MMR_LAMBDA) * maxSim;
        }

        const include = mmrScore > 0 || selectedIds.length === 0;
        if (DEBUG && !include) {
          dbg(`  MMR rejected: score=${candidate.score.toFixed(3)} mmr=${mmrScore.toFixed(3)} "${candidate.content.slice(0, 50)}"`);
        }
        metaMatches.push({ label: candidate.content.slice(0, 60), tokens: lineTokens, included: include });

        if (include) {
          lines.push(line);
          usedTokens += lineTokens;
          selectedIds.push(id);
          if (candidateEmb) selectedEmbs.push(candidateEmb);
        }
      }

      if (lines.length === 0) {
        dbg("no memories selected — returning null");
        return null;
      }

      const content = header + "\n" + lines.join("\n");
      const tokens = countTokens(content);

      dbg(`result: ${selectedIds.length} injected, ${tokens} tokens, ${pool.size - selectedIds.length} in pool not selected`);

      return {
        name: "MEMORIES",
        type: "matched" as const,
        content,
        tokens,
        meta: {
          totalMatches: pool.size,
          injectedCount: selectedIds.length,
          injectedIds: selectedIds,
          matches: metaMatches,
        },
      };
    } catch (err) {
      dbg(`error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      memoriesDb.close();
    }
  },
};

export default memoryBrick;
