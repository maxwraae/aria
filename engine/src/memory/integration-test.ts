/**
 * Memory system integration test.
 * Verifies the full V1 pipeline against the live memories.db.
 *
 * Run: npx tsx src/memory/integration-test.ts
 *
 * Checks:
 *   1. DB accessible + embeddings progress
 *   2. buildFtsQuery produces valid queries
 *   3. BM25 search returns ranked results
 *   4. Vector search returns semantically relevant results (requires Ollama + embeddings)
 *   5. Pool scoring — multi-signal entries score higher than single-signal
 *   6. Contextuality expansion — neighbors pulled in via edges
 *   7. incrementEdges writes correctly + count increments on repeat
 *   8. Full brick render produces sensible output with injectedIds
 */

import Database from "better-sqlite3";
import { initMemoryTables } from "./schema.js";
import {
  buildFtsQuery,
  searchBM25,
  incrementEdges,
  getTopEdges,
  getMemoryById,
} from "./queries.js";
import {
  getEmbedding,
  searchVector,
  cosineSimilarity,
  floatsToBuffer,
  bufferToFloats,
} from "./embeddings.js";
import { MEMORIES_DB_PATH, openMemoriesDb } from "../context/bricks/memory/index.js";

const PASS = "✓";
const FAIL = "✗";
const SKIP = "–";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ${PASS} ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function skip(label: string, reason: string) {
  console.log(`  ${SKIP} ${label} (skipped: ${reason})`);
}

// ── 1. DB accessible ───────────────────────────────────────────────────────

console.log("\n1. Database");
const db = openMemoriesDb();
check("memories.db opens", db !== null);
if (!db) {
  console.log(`\nCannot continue — memories.db not found at:\n  ${MEMORIES_DB_PATH}`);
  process.exit(1);
}

const total = (db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;
const embedded = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE embedding IS NOT NULL").get() as { c: number }).c;
const edges = (db.prepare("SELECT COUNT(*) as c FROM memory_edges").get() as { c: number }).c;

console.log(`  total memories:   ${total}`);
console.log(`  with embeddings:  ${embedded} (${Math.round(embedded / total * 100)}%)`);
console.log(`  memory_edges:     ${edges}`);

check("memory_edges table exists", edges >= 0);
check("node_weight column exists", (() => {
  const cols = db.pragma("table_info(memories)") as { name: string }[];
  return cols.some(c => c.name === "node_weight");
})());

// ── 2. buildFtsQuery ───────────────────────────────────────────────────────

console.log("\n2. buildFtsQuery");

const q1 = buildFtsQuery("Can you check what safety training KU requires");
check('includes "ku"', q1.includes('"ku"'));
check('excludes "can"', !q1.includes('"can"'));
check('excludes "you"', !q1.includes('"you"'));
check('excludes "what"', !q1.includes('"what"'));

const q2 = buildFtsQuery("AI alignment research at Harvard");
check('includes "ai"', q2.includes('"ai"'));
check('includes "harvard"', q2.includes('"harvard"'));

check("empty input returns empty string", buildFtsQuery("") === "");
check("all stop words returns empty string", buildFtsQuery("the and for with that") === "");

// ── 3. BM25 search ─────────────────────────────────────────────────────────

console.log("\n3. BM25 search");

const bm25Query = buildFtsQuery("Harvard lab safety training");
if (bm25Query) {
  const results = searchBM25(db, bm25Query, 10);
  check("returns results", results.length > 0, `got ${results.length}`);
  check("results have rank 1, 2, 3...", results.every((r, i) => r.rank === i + 1));
  check("results have content", results.every(r => r.content.length > 0));
  check("results have created_at", results.every(r => r.created_at > 0));
  if (results.length > 0) {
    console.log(`  top result: "${results[0].content.slice(0, 80)}..."`);
  }
} else {
  skip("BM25 search", "query was empty");
}

// ── 4. Vector search ───────────────────────────────────────────────────────

console.log("\n4. Vector search (requires Ollama + embeddings)");

let ollamaOk = false;
let queryEmbedding: number[] | null = null;

try {
  queryEmbedding = await getEmbedding("Harvard lab safety certification requirements");
  ollamaOk = true;
  check("Ollama returns 1024-dim vector", queryEmbedding.length === 1024, `got ${queryEmbedding.length}`);
} catch (e: unknown) {
  skip("Ollama embedding", `Ollama unavailable: ${e instanceof Error ? e.message : String(e)}`);
}

if (ollamaOk && queryEmbedding && embedded > 0) {
  const vecResults = searchVector(db, queryEmbedding, 10);
  check("vector search returns results", vecResults.length > 0, `got ${vecResults.length}`);
  check("results sorted by similarity desc", vecResults.every((r, i) =>
    i === 0 || r.similarity <= vecResults[i - 1].similarity
  ));
  check("similarity scores in [−1, 1]", vecResults.every(r => r.similarity >= -1 && r.similarity <= 1));

  // Semantic relevance: top result should be more similar than a random memory
  const randomRow = db.prepare("SELECT id, embedding FROM memories WHERE embedding IS NOT NULL ORDER BY RANDOM() LIMIT 1").get() as { id: string; embedding: Buffer } | undefined;
  if (randomRow && vecResults.length > 0) {
    const topId = vecResults[0].id;
    const topRow = db.prepare("SELECT embedding FROM memories WHERE id = ?").get(topId) as { embedding: Buffer } | null;
    if (topRow) {
      const topSim = cosineSimilarity(queryEmbedding, bufferToFloats(topRow.embedding));
      const rndSim = cosineSimilarity(queryEmbedding, bufferToFloats(randomRow.embedding));
      check("top result more similar than random", topSim > rndSim, `top=${topSim.toFixed(3)}, rnd=${rndSim.toFixed(3)}`);
    }
  }

  if (vecResults.length > 0) {
    console.log(`  top result (${vecResults[0].similarity.toFixed(3)}): "${vecResults[0].content.slice(0, 80)}..."`);
  }
} else if (embedded === 0) {
  skip("vector search", "no embeddings stored yet — daemon still running");
}

// ── 5. Pool scoring ────────────────────────────────────────────────────────

console.log("\n5. Pool scoring — multi-signal");

if (bm25Query && ollamaOk && queryEmbedding && embedded > 0) {
  const bm25 = searchBM25(db, bm25Query, 20);
  const vec = searchVector(db, queryEmbedding, 20);

  // Find memories that appear in both sets
  const bm25Ids = new Set(bm25.map(r => r.id));
  const overlap = vec.filter(r => bm25Ids.has(r.id));

  type PoolEntry = { score: number };
  const pool = new Map<string, PoolEntry>();

  const addToPool = (results: Array<{ id: string; rank: number }>) => {
    const n = results.length;
    for (const r of results) {
      const normRank = 1 - (r.rank - 1) / Math.max(n - 1, 1);
      const ex = pool.get(r.id);
      if (ex) ex.score += normRank;
      else pool.set(r.id, { score: normRank });
    }
  };

  addToPool(bm25);
  addToPool(vec);

  if (overlap.length > 0) {
    const overlapId = overlap[0].id;
    const overlapScore = pool.get(overlapId)?.score ?? 0;

    // Find a single-signal entry
    const singleBm25 = bm25.find(r => !vec.some(v => v.id === r.id));
    const singleScore = singleBm25 ? (pool.get(singleBm25.id)?.score ?? 0) : null;

    check("overlap entry exists in pool", pool.has(overlapId));
    if (singleScore !== null) {
      check(
        "multi-signal memory scores higher than single-signal at same rank",
        overlapScore >= singleScore,
        `overlap=${overlapScore.toFixed(3)}, single=${singleScore.toFixed(3)}`
      );
    } else {
      skip("multi vs single comparison", "no single-signal entries at comparable rank");
    }
    console.log(`  overlapping memories (in both BM25 + vector): ${overlap.length}`);
  } else {
    console.log(`  no overlap between BM25 and vector results — different result sets`);
    check("pool contains entries from both sources", pool.size >= Math.min(bm25.length + vec.length, 20));
  }
} else {
  skip("pool scoring", "requires BM25 + vector results");
}

// ── 6. Contextuality expansion ────────────────────────────────────────────

console.log("\n6. Contextuality expansion");

if (edges > 0) {
  // Find a memory with edges
  const topEdge = db.prepare("SELECT memory_a, memory_b, count FROM memory_edges ORDER BY count DESC LIMIT 1").get() as { memory_a: string; memory_b: string; count: number } | undefined;
  if (topEdge) {
    const edgesForA = getTopEdges(db, topEdge.memory_a, 20);
    check("getTopEdges returns results", edgesForA.length > 0);
    check("edges sorted by count desc", edgesForA.every((e, i) => i === 0 || e.count <= edgesForA[i - 1].count));

    const neighbor = getMemoryById(db, topEdge.memory_b);
    check("getMemoryById returns neighbor", neighbor !== null);
    if (neighbor) {
      console.log(`  top edge count: ${topEdge.count}`);
      console.log(`  neighbor: "${neighbor.content.slice(0, 80)}..."`);
    }
  }
} else {
  console.log("  no edges yet — will build after first turns run");
  console.log("  (this is expected on a fresh deployment)");
}

// ── 7. incrementEdges ─────────────────────────────────────────────────────

console.log("\n7. incrementEdges");

// Use a writable connection to a temp DB for this test
const tmpPath = `/tmp/aria-edge-test-${Date.now()}.db`;
const tmpDb = new Database(tmpPath);
initMemoryTables(tmpDb);

// Insert 3 test memories
const ids = ["mem-aaa", "mem-bbb", "mem-ccc"];
for (const id of ids) {
  tmpDb.prepare("INSERT OR IGNORE INTO memories (id, content, type, created_at) VALUES (?, ?, ?, ?)").run(id, `test memory ${id}`, "world", Math.floor(Date.now() / 1000));
}

incrementEdges(tmpDb, ids);

const e1 = tmpDb.prepare("SELECT count FROM memory_edges WHERE memory_a = ? AND memory_b = ?").get("mem-aaa", "mem-bbb") as { count: number } | undefined;
const e2 = tmpDb.prepare("SELECT count FROM memory_edges WHERE memory_a = ? AND memory_b = ?").get("mem-aaa", "mem-ccc") as { count: number } | undefined;
const e3 = tmpDb.prepare("SELECT count FROM memory_edges WHERE memory_a = ? AND memory_b = ?").get("mem-bbb", "mem-ccc") as { count: number } | undefined;

check("3 IDs create 3 edges (C(3,2))", [e1, e2, e3].every(e => e?.count === 1));
check("canonical ordering (a < b)", e1 !== undefined && e2 !== undefined && e3 !== undefined);

// Call again — counts should increment
incrementEdges(tmpDb, ids);
const e1b = tmpDb.prepare("SELECT count FROM memory_edges WHERE memory_a = ? AND memory_b = ?").get("mem-aaa", "mem-bbb") as { count: number } | undefined;
check("second call increments count to 2", e1b?.count === 2);

// 2 IDs should create 1 edge
incrementEdges(tmpDb, ["mem-aaa", "mem-bbb"]);
const e1c = tmpDb.prepare("SELECT count FROM memory_edges WHERE memory_a = ? AND memory_b = ?").get("mem-aaa", "mem-bbb") as { count: number } | undefined;
check("count increments to 3 on third call", e1c?.count === 3);

tmpDb.close();
import { unlinkSync } from "fs";
for (const suffix of ["", "-shm", "-wal"]) {
  try { unlinkSync(tmpPath + suffix); } catch {}
}

// ── 8. Full brick render ───────────────────────────────────────────────────

console.log("\n8. Full brick render (end-to-end)");

import memoryBrick from "../context/bricks/memory/index.js";
import Database2 from "better-sqlite3";

// Build a minimal engine DB with objective + inbox
const engineDb = new Database2(":memory:");
engineDb.exec(`
  CREATE TABLE objectives (
    id TEXT PRIMARY KEY,
    objective TEXT NOT NULL,
    description TEXT,
    parent TEXT,
    work_path TEXT
  );
  CREATE TABLE inbox (
    id TEXT PRIMARY KEY,
    objective_id TEXT NOT NULL,
    message TEXT NOT NULL,
    sender TEXT NOT NULL,
    type TEXT DEFAULT 'message',
    turn_id TEXT,
    created_at INTEGER NOT NULL
  );
`);
engineDb.prepare("INSERT INTO objectives (id, objective, description) VALUES (?, ?, ?)").run(
  "test-obj",
  "Harvard lab onboarding and safety certification",
  "Completing all required steps before starting at Abudayyeh-Gootenberg lab"
);
engineDb.prepare("INSERT INTO inbox (id, objective_id, message, sender, created_at) VALUES (?, ?, ?, ?, ?)").run(
  "msg-1", "test-obj",
  "What safety training do I need to complete before my first day at Harvard?",
  "max", Math.floor(Date.now() / 1000)
);

const ctx = {
  db: engineDb,
  objectiveId: "test-obj",
  budget: 200_000,
  config: {},
  memoryEmbeddings: ollamaOk && queryEmbedding ? {
    message: queryEmbedding,
    prevTurn: null,
    objective: queryEmbedding,
    parent: null,
    work: null,
  } : null,
};

const result = memoryBrick.render(ctx);

if (result) {
  check("brick returns a result", true);
  check("result has MEMORIES header", result.content.includes("# RELEVANT MEMORIES"));
  check("result type is 'matched'", result.type === "matched");
  check("tokens > 0", result.tokens > 0);
  check("injectedIds populated", (result.meta?.injectedIds?.length ?? 0) > 0, `${result.meta?.injectedIds?.length ?? 0} IDs`);
  check("injectedCount matches injectedIds length",
    result.meta?.injectedCount === result.meta?.injectedIds?.length
  );
  console.log(`  injected: ${result.meta?.injectedCount} memories, ${result.tokens} tokens`);
  console.log(`  first line: ${result.content.split("\n").find(l => l.startsWith("- ["))?.slice(0, 80)}`);
} else {
  check("brick returns a result", false, "returned null");
  if (embedded === 0) {
    console.log("  (likely because no embeddings stored yet — daemon is still running)");
  }
}

engineDb.close();

// ── 9. Assembled context — memory section visible to agent ────────────────

console.log("\n9. Assembled context (what the agent actually sees)");

import { assembleContext } from "../context/assembler.js";

// Rebuild engine DB (fresh connection since we closed the old one)
const engineDb2 = new Database("__tmp_integration_engine.db");
engineDb2.exec(`
  CREATE TABLE IF NOT EXISTS objectives (
    id TEXT PRIMARY KEY,
    objective TEXT NOT NULL,
    description TEXT,
    parent TEXT,
    work_path TEXT,
    status TEXT DEFAULT 'idle',
    waiting_on TEXT,
    resolution_summary TEXT,
    important BOOLEAN DEFAULT FALSE,
    urgent BOOLEAN DEFAULT FALSE,
    model TEXT DEFAULT 'sonnet',
    cwd TEXT,
    fail_count INTEGER DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER,
    depth INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS inbox (
    id TEXT PRIMARY KEY,
    objective_id TEXT NOT NULL,
    message TEXT NOT NULL,
    sender TEXT NOT NULL,
    type TEXT DEFAULT 'message',
    turn_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    objective_id TEXT NOT NULL,
    turn_number INTEGER NOT NULL,
    user_message TEXT,
    session_id TEXT,
    created_at INTEGER,
    injected_memory_ids TEXT
  );
  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    objective_id TEXT NOT NULL,
    message TEXT NOT NULL,
    interval TEXT,
    next_at INTEGER NOT NULL,
    created_at INTEGER
  );
`);

const ts = Math.floor(Date.now() / 1000);
engineDb2.prepare(`INSERT OR REPLACE INTO objectives (id, objective, description, parent, status, created_at, updated_at)
  VALUES (?, ?, ?, NULL, 'idle', ?, ?)`).run(
  "test-ctx-obj",
  "Harvard lab onboarding and safety certification",
  "Completing all required steps before starting at Abudayyeh-Gootenberg lab in June 2026",
  ts, ts
);
engineDb2.prepare("INSERT OR REPLACE INTO inbox (id, objective_id, message, sender, created_at) VALUES (?, ?, ?, ?, ?)").run(
  "ctx-msg-1", "test-ctx-obj",
  "What safety training and certifications do I need before my first day at Harvard?",
  "max", ts
);

// Run assembleContext with just the memory brick (isolates the test)
const asmCtx = {
  db: engineDb2,
  objectiveId: "test-ctx-obj",
  budget: 200_000,
  config: {},
  memoryEmbeddings: ollamaOk && queryEmbedding ? {
    message: queryEmbedding,
    prevTurn: null,
    objective: queryEmbedding,
    parent: null,
    work: null,
  } : null,
};

const assembled = assembleContext([memoryBrick], asmCtx);

check("assembleContext returns sections", assembled.sections.length > 0);

const memSection = assembled.sections.find(s => s.name === "MEMORIES");
check("MEMORIES section exists in assembled context", memSection !== undefined);

if (memSection) {
  check("section content starts with header", memSection.content.startsWith("# RELEVANT MEMORIES"));
  check("section has memory lines", memSection.content.includes("- [20"));
  check("section tokens > 0", memSection.tokens > 0);

  // Count memory lines
  const memLines = memSection.content.split("\n").filter(l => l.startsWith("- ["));
  check("multiple memories injected", memLines.length > 1, `${memLines.length} memories`);

  // Verify the assembled output string contains the memories
  check("assembled content string includes MEMORIES", assembled.content.includes("# RELEVANT MEMORIES"));
  check("assembled content string includes memory lines", assembled.content.includes("- [20"));

  // Check meta
  check("section meta has injectedIds", (memSection.meta?.injectedIds?.length ?? 0) > 0);
  check("section meta has totalMatches", (memSection.meta?.totalMatches ?? 0) > 0);

  // Show what the agent would see (first 5 memory lines)
  console.log(`  section tokens: ${memSection.tokens}`);
  console.log(`  total assembled tokens: ${assembled.totalTokens}`);
  console.log(`  memories in context: ${memLines.length}`);
  console.log(`  first 3 memory lines:`);
  for (const line of memLines.slice(0, 3)) {
    console.log(`    ${line.slice(0, 90)}`);
  }
} else {
  console.log("  MEMORIES section missing from assembled context!");
  if (embedded === 0) {
    console.log("  (likely because no embeddings stored yet)");
  }
}

engineDb2.close();
try { unlinkSync("__tmp_integration_engine.db"); } catch {}
try { unlinkSync("__tmp_integration_engine.db-shm"); } catch {}
try { unlinkSync("__tmp_integration_engine.db-wal"); } catch {}

db.close();

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`${passed + failed} checks: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log("Memory system is working as intended.\n");
} else {
  console.log("Some checks failed — see above.\n");
  process.exit(1);
}
