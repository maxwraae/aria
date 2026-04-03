import { describe, it, expect, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  getMaxActiveSet,
  getConcurrencyLimit,
} from "./concurrency.js";

const MAX_CONCURRENT_IDLE = 3;
const MAX_CONCURRENT_ACTIVE = 10;
import {
  createObjective,
  updateStatus,
  insertMessage,
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

function addObjective(
  db: Database.Database,
  opts?: { parent?: string; objective?: string }
): string {
  const obj = createObjective(db, {
    objective: opts?.objective ?? "test objective",
    parent: opts?.parent ?? undefined,
  });
  return obj.id;
}

/**
 * Insert a raw inbox message with a specific created_at timestamp.
 * Bypasses insertMessage's auto-timestamping so we can test time windows.
 */
function rawInboxInsert(
  db: Database.Database,
  opts: {
    objective_id: string;
    sender: string;
    message?: string;
    created_at: number;
  }
): void {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO inbox (id, objective_id, message, sender, type, created_at)
     VALUES (?, ?, ?, ?, 'message', ?)`
  ).run(id, opts.objective_id, opts.message ?? "test", opts.sender, opts.created_at);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── tests ──────────────────────────────────────────────────────────────────

describe("Max Priority Lane", () => {
  it("Max messages objective → it's max_active", () => {
    const db = createTestDb();
    const objId = addObjective(db);

    // Max messages the objective recently
    rawInboxInsert(db, {
      objective_id: objId,
      sender: "max",
      created_at: now() - 60, // 1 minute ago
    });

    const activeSet = getMaxActiveSet(db);
    expect(activeSet.has(objId)).toBe(true);

    db.close();
  });

  it("propagation through new messages", () => {
    const db = createTestDb();
    const objA = addObjective(db, { objective: "objective A" });
    const objB = addObjective(db, { objective: "objective B" });

    // Max messages A → A is max_active
    rawInboxInsert(db, {
      objective_id: objA,
      sender: "max",
      created_at: now() - 60,
    });

    // A sends a message to B (e.g., via aria tell) → B should become max_active
    rawInboxInsert(db, {
      objective_id: objB,
      sender: objA,
      created_at: now() - 30,
    });

    const activeSet = getMaxActiveSet(db);
    expect(activeSet.has(objA)).toBe(true);
    expect(activeSet.has(objB)).toBe(true);

    db.close();
  });

  it("old children not activated — no recent messages from parent", () => {
    const db = createTestDb();
    const objA = addObjective(db, { objective: "objective A" });
    const objC = addObjective(db, { objective: "objective C", parent: objA });

    // Max messages A recently → A is max_active
    rawInboxInsert(db, {
      objective_id: objA,
      sender: "max",
      created_at: now() - 60,
    });

    // C is a child of A but has NO recent messages from A.
    // (Old message from A to C, outside the 15-min window)
    rawInboxInsert(db, {
      objective_id: objC,
      sender: objA,
      created_at: now() - 20 * 60, // 20 minutes ago
    });

    const activeSet = getMaxActiveSet(db);
    expect(activeSet.has(objA)).toBe(true);
    expect(activeSet.has(objC)).toBe(false);

    db.close();
  });

  it("two separate waves — independent max_active trees", () => {
    const db = createTestDb();
    const objA = addObjective(db, { objective: "objective A" });
    const objX = addObjective(db, { objective: "objective X" });

    // Max messages both A and X
    rawInboxInsert(db, {
      objective_id: objA,
      sender: "max",
      created_at: now() - 120,
    });
    rawInboxInsert(db, {
      objective_id: objX,
      sender: "max",
      created_at: now() - 60,
    });

    const activeSet = getMaxActiveSet(db);
    expect(activeSet.has(objA)).toBe(true);
    expect(activeSet.has(objX)).toBe(true);

    db.close();
  });

  it("timeout — Max messaged 20 minutes ago, not max_active", () => {
    const db = createTestDb();
    const objA = addObjective(db, { objective: "objective A" });

    // Max messaged 20 minutes ago (outside the 15-min window)
    rawInboxInsert(db, {
      objective_id: objA,
      sender: "max",
      created_at: now() - 20 * 60,
    });

    const activeSet = getMaxActiveSet(db);
    expect(activeSet.has(objA)).toBe(false);
    expect(activeSet.size).toBe(0);

    db.close();
  });

  it("concurrency cap — 10 when max_active, 3 when idle", () => {
    const db = createTestDb();
    const objA = addObjective(db);

    // No max activity → idle cap
    const emptySet = getMaxActiveSet(db);
    expect(getConcurrencyLimit(emptySet)).toBe(MAX_CONCURRENT_IDLE);
    expect(MAX_CONCURRENT_IDLE).toBe(3);

    // Max messages an objective → active cap
    rawInboxInsert(db, {
      objective_id: objA,
      sender: "max",
      created_at: now() - 60,
    });

    const activeSet = getMaxActiveSet(db);
    expect(getConcurrencyLimit(activeSet)).toBe(MAX_CONCURRENT_ACTIVE);
    expect(MAX_CONCURRENT_ACTIVE).toBe(10);

    db.close();
  });
});
