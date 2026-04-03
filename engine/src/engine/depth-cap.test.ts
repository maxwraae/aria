import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  createObjective,
  insertMessage,
  getInitiationDepth,
  checkDepthCap,
  getObjective,
  getMaxAutonomousDepth,
  INITIATION_WINDOW,
} from "../db/queries.js";
import { now } from "../db/utils.js";

// ── helpers ────────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE objectives (
      id TEXT PRIMARY KEY,
      objective TEXT NOT NULL,
      description TEXT,
      parent TEXT,
      status TEXT DEFAULT 'idle',
      waiting_on TEXT,
      resolution_summary TEXT,
      last_error TEXT,
      important BOOLEAN DEFAULT FALSE,
      urgent BOOLEAN DEFAULT FALSE,
      model TEXT DEFAULT 'sonnet',
      cwd TEXT,
      machine TEXT,
      depth INTEGER DEFAULT 0,
      fail_count INTEGER DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER,
      resolved_at INTEGER,
      work_path TEXT
    );

    CREATE INDEX idx_status ON objectives(status);
    CREATE INDEX idx_parent ON objectives(parent);

    CREATE VIRTUAL TABLE objectives_fts USING fts5(
      objective, waiting_on, description, resolution_summary
    );

    CREATE TABLE inbox (
      id TEXT PRIMARY KEY,
      objective_id TEXT NOT NULL,
      message TEXT NOT NULL,
      sender TEXT NOT NULL,
      type TEXT DEFAULT 'message',
      turn_id TEXT,
      processed_by TEXT,
      cascade_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (objective_id) REFERENCES objectives(id)
    );

    CREATE INDEX idx_unprocessed ON inbox(objective_id) WHERE turn_id IS NULL;
    CREATE INDEX idx_sender ON inbox(sender, created_at);
    CREATE INDEX idx_recent ON inbox(created_at);

    CREATE TABLE turns (
      id TEXT PRIMARY KEY,
      objective_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      user_message TEXT,
      session_id TEXT,
      created_at INTEGER,
      FOREIGN KEY (objective_id) REFERENCES objectives(id)
    );

    CREATE INDEX idx_objective_turns ON turns(objective_id, turn_number);

    CREATE TABLE schedules (
      id TEXT PRIMARY KEY,
      objective_id TEXT NOT NULL,
      message TEXT NOT NULL,
      interval TEXT,
      next_at INTEGER NOT NULL,
      created_at INTEGER,
      FOREIGN KEY (objective_id) REFERENCES objectives(id)
    );

    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      type TEXT NOT NULL,
      source TEXT,
      embedding BLOB,
      created_at INTEGER NOT NULL
    );
  `);

  return db;
}

/**
 * Build a chain of objectives from root down to a given depth.
 * Returns array of objective IDs [root, depth1, depth2, ...].
 */
function buildChain(db: Database.Database, depth: number): string[] {
  const ids: string[] = [];

  // Create root manually (depth 0, no parent)
  const root = createObjective(db, { objective: "root" });
  ids.push(root.id);

  for (let i = 1; i <= depth; i++) {
    const child = createObjective(db, {
      objective: `level-${i}`,
      parent: ids[i - 1],
    });
    ids.push(child.id);
  }

  return ids;
}

/**
 * Insert a Max message with a specific timestamp into an objective's inbox.
 */
function insertMaxMessage(db: Database.Database, objectiveId: string, timestamp: number): void {
  db.prepare(
    `INSERT INTO inbox (id, objective_id, message, sender, type, created_at)
     VALUES (?, ?, ?, 'max', 'message', ?)`
  ).run(`msg-${Math.random().toString(36).slice(2, 10)}`, objectiveId, "Max message", timestamp);
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("depth cap", () => {
  it("createObjective computes depth correctly from parent chain", () => {
    const db = createTestDb();
    const ids = buildChain(db, 5);

    for (let i = 0; i <= 5; i++) {
      const obj = getObjective(db, ids[i])!;
      expect(obj.depth).toBe(i);
    }

    db.close();
  });

  it("agent at depth 4, Max messaged depth 1 within the hour — can create child", () => {
    const db = createTestDb();
    const ids = buildChain(db, 4);
    // ids: [root(0), level1(1), level2(2), level3(3), level4(4)]

    // Max messaged the depth-1 objective recently
    insertMaxMessage(db, ids[1], now());

    // Agent at depth 4 wants to create a child (depth 5)
    const result = checkDepthCap(db, ids[4]);
    // autonomous depth = 5 - 1 = 4 < 5
    expect(result.allowed).toBe(true);
    expect(result.newChildDepth).toBe(5);
    expect(result.autonomousDepth).toBe(4);

    db.close();
  });

  it("agent at depth 6, Max messaged depth 1 within the hour — CANNOT create child", () => {
    const db = createTestDb();
    const ids = buildChain(db, 6);

    // Max messaged the depth-1 objective recently
    insertMaxMessage(db, ids[1], now());

    // Agent at depth 6 wants to create a child (depth 7)
    const result = checkDepthCap(db, ids[6]);
    // autonomous depth = 7 - 1 = 6 >= 5
    expect(result.allowed).toBe(false);
    expect(result.newChildDepth).toBe(7);
    expect(result.autonomousDepth).toBe(6);

    db.close();
  });

  it("agent at depth 3, no Max message in any ancestor within the hour — can create child", () => {
    const db = createTestDb();
    const ids = buildChain(db, 3);

    // No Max messages anywhere — initiation depth defaults to 0
    const result = checkDepthCap(db, ids[3]);
    // autonomous depth = 4 - 0 = 4 < 5
    expect(result.allowed).toBe(true);
    expect(result.newChildDepth).toBe(4);
    expect(result.autonomousDepth).toBe(4);

    db.close();
  });

  it("agent at depth 5, no Max message in any ancestor within the hour — CANNOT create child", () => {
    const db = createTestDb();
    const ids = buildChain(db, 5);

    // No Max messages anywhere — initiation depth defaults to 0
    const result = checkDepthCap(db, ids[5]);
    // autonomous depth = 6 - 0 = 6 >= 5
    expect(result.allowed).toBe(false);
    expect(result.newChildDepth).toBe(6);
    expect(result.autonomousDepth).toBe(6);

    db.close();
  });

  it("Max message older than 1 hour is not counted — initiation depth falls to root", () => {
    const db = createTestDb();
    const ids = buildChain(db, 5);

    // Max messaged depth 1, but over an hour ago
    const oldTimestamp = now() - INITIATION_WINDOW - 60;
    insertMaxMessage(db, ids[1], oldTimestamp);

    // Agent at depth 5 tries to create child (depth 6)
    const result = checkDepthCap(db, ids[5]);
    // No recent Max message → initiation depth = 0
    // autonomous depth = 6 - 0 = 6 >= 5
    expect(result.allowed).toBe(false);
    expect(result.autonomousDepth).toBe(6);

    db.close();
  });

  it("Max message at deeper ancestor is still used if it's the shallowest", () => {
    const db = createTestDb();
    const ids = buildChain(db, 6);

    // Max messaged both depth 2 and depth 4
    insertMaxMessage(db, ids[2], now());
    insertMaxMessage(db, ids[4], now());

    // Agent at depth 6 tries to create child (depth 7)
    // Shallowest Max message is at depth 2
    const result = checkDepthCap(db, ids[6]);
    // autonomous depth = 7 - 2 = 5 >= 5
    expect(result.allowed).toBe(false);
    expect(result.autonomousDepth).toBe(5);

    db.close();
  });

  it("Max message at depth 3 allows deeper creation than message at depth 1", () => {
    const db = createTestDb();
    const ids = buildChain(db, 7);

    // Max messaged only depth 3 (not depth 1)
    insertMaxMessage(db, ids[3], now());

    // Agent at depth 7 tries to create child (depth 8)
    // Initiation depth = 3, autonomous depth = 8 - 3 = 5 >= 5 → blocked
    const result7 = checkDepthCap(db, ids[7]);
    expect(result7.allowed).toBe(false);
    expect(result7.autonomousDepth).toBe(5);

    // But agent at depth 6 can create child (depth 7)
    // autonomous depth = 7 - 3 = 4 < 5 → allowed
    const result6 = checkDepthCap(db, ids[6]);
    expect(result6.allowed).toBe(true);
    expect(result6.autonomousDepth).toBe(4);

    db.close();
  });

  it("getInitiationDepth uses the shallowest ancestor with recent Max message", () => {
    const db = createTestDb();
    const ids = buildChain(db, 5);

    // Max messaged depth 1 and depth 3
    insertMaxMessage(db, ids[1], now());
    insertMaxMessage(db, ids[3], now());

    // Walking up from depth 5: finds max msg at depth 3 (depth=3),
    // then finds max msg at depth 1 (depth=1). Shallowest wins.
    const initDepth = getInitiationDepth(db, ids[5]);
    expect(initDepth).toBe(1);

    db.close();
  });

  it("edge case: checking depth cap on root objective always allows", () => {
    const db = createTestDb();
    const ids = buildChain(db, 0); // just root

    const result = checkDepthCap(db, ids[0]);
    // new child at depth 1, initiation = 0, autonomous = 1 < 5
    expect(result.allowed).toBe(true);
    expect(result.newChildDepth).toBe(1);

    db.close();
  });
});
