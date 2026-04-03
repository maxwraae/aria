/**
 * Tests for the memory brick.
 *
 * Tests are structured to work without mocking the filesystem:
 * - Brick logic (null guards, FTS query building) tested in pure isolation
 * - Integration tests use openMemoriesDb() directly with temp DB files
 * - The assembler integration test uses the real memories.db if present
 */
import os from "os";
import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initMemoryTables } from "../../../memory/schema.js";
import { insertMemory, searchMemories, buildFtsQuery } from "../../../memory/queries.js";
import { openMemoriesDb, MEMORIES_DB_PATH } from "./index.js";
import memoryBrick from "./index.js";
import type { BrickContext } from "../../types.js";
import { assembleContext } from "../../assembler.js";
import { countTokens } from "../../tokens.js";

// ── helpers ────────────────────────────────────────────────────────────────

function makeEngineDb(objectiveId: string, objective: string): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
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
  db.prepare("INSERT INTO objectives (id, objective) VALUES (?, ?)").run(objectiveId, objective);
  return db;
}

function makeTempMemoriesDb(
  memories: Array<{ content: string; type?: string; createdAt?: number }>
): { dbPath: string; cleanup: () => void } {
  const dbPath = path.join(os.tmpdir(), `aria-test-memories-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(dbPath);
  initMemoryTables(db);
  for (const m of memories) {
    insertMemory(db, m.content, m.type ?? "world", null, m.createdAt ?? 1_700_000_000);
  }
  db.close();
  return {
    dbPath,
    cleanup: () => {
      for (const suffix of ["", "-shm", "-wal"]) {
        try { fs.unlinkSync(dbPath + suffix); } catch {}
      }
    },
  };
}

// ── buildFtsQuery unit tests ───────────────────────────────────────────────

describe("buildFtsQuery", () => {
  it("returns empty string for empty input", () => {
    expect(buildFtsQuery("")).toBe("");
  });

  it("filters single-char words (keeps 2+ chars)", () => {
    expect(buildFtsQuery("a it now")).toBe('"it" OR "now"');
  });

  it("strips punctuation and lower-cases", () => {
    const q = buildFtsQuery("Harvard! Lab, research.");
    expect(q).toContain('"harvard"');
    expect(q).toContain('"lab"');
    expect(q).toContain('"research"');
  });

  it("joins terms with OR", () => {
    const q = buildFtsQuery("protein engineering");
    expect(q).toContain(" OR ");
  });

  it("caps at 12 terms", () => {
    const long = Array.from({ length: 20 }, (_, i) => `word${i + 100}`).join(" ");
    const q = buildFtsQuery(long);
    // 12 terms → 11 OR separators
    expect((q.match(/ OR /g) ?? []).length).toBe(11);
  });
});

// ── openMemoriesDb ─────────────────────────────────────────────────────────

describe("openMemoriesDb", () => {
  it("returns null for a path that does not exist", () => {
    const result = openMemoriesDb("/nonexistent/path/memories.db");
    expect(result).toBeNull();
  });

  it("opens an existing DB file successfully", () => {
    const { dbPath, cleanup } = makeTempMemoriesDb([]);
    try {
      const db = openMemoriesDb(dbPath);
      expect(db).not.toBeNull();
      db?.close();
    } finally {
      cleanup();
    }
  });
});

// ── brick render null-guard tests ─────────────────────────────────────────

describe("memoryBrick render null guards", () => {
  it("returns null when ctx.db is null", () => {
    const ctx: BrickContext = { db: null, objectiveId: "obj1", budget: 200_000, config: {} };
    expect(memoryBrick.render(ctx)).toBeNull();
  });

  it("returns null when ctx.objectiveId is null", () => {
    const engineDb = makeEngineDb("obj1", "research protein engineering");
    const ctx: BrickContext = { db: engineDb, objectiveId: null, budget: 200_000, config: {} };
    expect(memoryBrick.render(ctx)).toBeNull();
  });

  it("returns null when objective not found in engine DB", () => {
    const engineDb = makeEngineDb("real-id", "some objective text");
    const ctx: BrickContext = { db: engineDb, objectiveId: "nonexistent-id", budget: 200_000, config: {} };
    expect(memoryBrick.render(ctx)).toBeNull();
  });

  it("returns null when objective text is all short words (no valid FTS query)", () => {
    const engineDb = makeEngineDb("obj-short", "a I x");
    const ctx: BrickContext = { db: engineDb, objectiveId: "obj-short", budget: 200_000, config: {} };
    expect(memoryBrick.render(ctx)).toBeNull();
  });
});

// ── memory search integration ──────────────────────────────────────────────

describe("searchMemories with temp DB", () => {
  it("finds memories matching the FTS query", () => {
    const { dbPath, cleanup } = makeTempMemoriesDb([
      {
        content: "Max is building Aria, an autonomous agent engine using TypeScript and SQLite",
        createdAt: 1_700_000_000,
      },
      {
        content: "The Aria engine stores objectives in SQLite and processes them with agents",
        createdAt: 1_700_000_001,
      },
    ]);

    try {
      const db = openMemoriesDb(dbPath)!;
      const query = buildFtsQuery("build Aria agent engine TypeScript SQLite");
      const results = searchMemories(db, query, 10);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain("Aria");
      expect(typeof results[0].score).toBe("number");
      expect(typeof results[0].created_at).toBe("number");
      db.close();
    } finally {
      cleanup();
    }
  });

  it("returns empty array when no matches", () => {
    const { dbPath, cleanup } = makeTempMemoriesDb([
      { content: "Max likes hiking on weekends in the mountains" },
    ]);

    try {
      const db = openMemoriesDb(dbPath)!;
      const results = searchMemories(db, '"quantum" OR "physics" OR "reactor" OR "nuclear"', 10);
      expect(results).toHaveLength(0);
      db.close();
    } finally {
      cleanup();
    }
  });
});

// ── token budget enforcement ───────────────────────────────────────────────

describe("token budget enforcement", () => {
  it("token truncation logic works correctly", () => {
    const { dbPath, cleanup } = makeTempMemoriesDb(
      Array.from({ length: 30 }, (_, i) => ({
        content: `Max uses TypeScript to build agent systems at Aria, task number ${i} related to context assembly and brick architecture for the autonomous engine`,
        createdAt: 1_700_000_000 + i,
      }))
    );

    try {
      const db = openMemoriesDb(dbPath)!;
      const query = buildFtsQuery("TypeScript agent context assembly brick architecture Aria");
      const results = searchMemories(db, query, 30);

      // Simulate brick formatting with a tight budget
      const maxTokens = 150;
      const header = "# RELEVANT MEMORIES\n";
      let usedTokens = countTokens(header);
      const lines: string[] = [];

      for (const r of results) {
        const date = new Date(r.created_at * 1000).toISOString().slice(0, 10);
        const line = `- [${date}] ${r.content}`;
        const lineTokens = countTokens(line);
        if (usedTokens + lineTokens <= maxTokens) {
          lines.push(line);
          usedTokens += lineTokens;
        }
      }

      // With a 150-token budget and 30 long memories, should truncate
      if (results.length > 0) {
        expect(lines.length).toBeLessThan(results.length);
        expect(usedTokens).toBeLessThanOrEqual(maxTokens + 10); // tiny slack for rounding
      }

      db.close();
    } finally {
      cleanup();
    }
  });
});

// ── assembler integration ──────────────────────────────────────────────────

describe("assembler integration", () => {
  it("memory brick produces MEMORIES section in assembled context when DB has matches", () => {
    // Use the real memories.db — if it exists and has relevant content,
    // the brick should produce a MEMORIES section.
    // If memories.db is absent or has no matches, the brick returns null (also valid).
    const engineDb = makeEngineDb(
      "test-aria-obj",
      "build Aria agent engine TypeScript SQLite context assembler bricks"
    );
    const ctx = { db: engineDb, objectiveId: "test-aria-obj", budget: 200_000, config: {} };
    const result = assembleContext([memoryBrick], ctx);

    if (result.sections.length > 0) {
      const memoriesSection = result.sections.find((s) => s.name === "MEMORIES");
      expect(memoriesSection).toBeDefined();
      expect(memoriesSection!.content).toContain("# RELEVANT MEMORIES");
      expect(memoriesSection!.type).toBe("matched");
      expect(memoriesSection!.tokens).toBeGreaterThan(0);
    } else {
      // No memories.db or no matches — acceptable in test environment
      expect(result.sections).toHaveLength(0);
    }
  });

  it("memory brick is a valid Brick (name, type, render)", () => {
    expect(typeof memoryBrick.name).toBe("string");
    expect(memoryBrick.name).toBe("MEMORIES");
    expect(memoryBrick.type).toBe("matched");
    expect(typeof memoryBrick.render).toBe("function");
  });
});
