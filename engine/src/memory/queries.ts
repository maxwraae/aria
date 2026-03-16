import Database from "better-sqlite3";
import { generateId } from "../db/utils.js";

// ── Types ──────────────────────────────────────────────────────────

export interface Memory {
  id: string;
  content: string;
  type: string;
  source: string | null;
  embedding: Buffer | null;
  created_at: number;
}

export interface MemorySearchResult {
  id: string;
  content: string;
  type: string;
  source: string | null;
  created_at: number;
  score: number;
}

export interface MemoryTypeCount {
  type: string;
  count: number;
}

// ── Prepared statement cache ───────────────────────────────────────

const stmtCache = new WeakMap<Database.Database, Record<string, Database.Statement>>();

function stmt(db: Database.Database, key: string, sql: string): Database.Statement {
  let cache = stmtCache.get(db);
  if (!cache) {
    cache = {};
    stmtCache.set(db, cache);
  }
  if (!cache[key]) {
    cache[key] = db.prepare(sql);
  }
  return cache[key];
}

// ── Queries ────────────────────────────────────────────────────────

export function insertMemory(
  db: Database.Database,
  content: string,
  type: string,
  source: string | null,
  createdAt: number
): string {
  const id = generateId();

  stmt(
    db,
    "insertMemory",
    `INSERT INTO memories (id, content, type, source, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, content, type, source, createdAt);

  // Sync to FTS5
  stmt(
    db,
    "insertMemoryFts",
    `INSERT INTO memories_fts (rowid, content, type)
     VALUES ((SELECT rowid FROM memories WHERE id = ?), ?, ?)`
  ).run(id, content, type);

  return id;
}

export function searchMemories(
  db: Database.Database,
  query: string,
  limit: number = 20
): MemorySearchResult[] {
  return stmt(
    db,
    "searchMemories",
    `SELECT
       m.id,
       m.content,
       m.type,
       m.source,
       m.created_at,
       (-bm25(memories_fts)) * 0.7
         + (1.0 / (1.0 + (cast(strftime('%s','now') as integer) - m.created_at) / 2592000.0)) * 0.3
         AS score
     FROM memories m
     JOIN memories_fts fts ON fts.rowid = m.rowid
     WHERE memories_fts MATCH ?
     ORDER BY score DESC
     LIMIT ?`
  ).all(query, limit) as MemorySearchResult[];
}

export function getRecentMemories(
  db: Database.Database,
  type: string,
  limit: number = 5
): Memory[] {
  return stmt(
    db,
    "getRecentMemories",
    `SELECT * FROM memories WHERE type = ? ORDER BY created_at DESC LIMIT ?`
  ).all(type, limit) as Memory[];
}

export function countMemories(db: Database.Database): number {
  const row = stmt(
    db,
    "countMemories",
    "SELECT COUNT(*) as count FROM memories"
  ).get() as { count: number };
  return row.count;
}

export function countMemoriesByType(db: Database.Database): MemoryTypeCount[] {
  return stmt(
    db,
    "countMemoriesByType",
    "SELECT type, COUNT(*) as count FROM memories GROUP BY type ORDER BY count DESC"
  ).all() as MemoryTypeCount[];
}
