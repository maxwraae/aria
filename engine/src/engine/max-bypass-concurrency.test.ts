import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { atConcurrencyLimit } from "./concurrency.js";
import {
  createObjective,
  updateStatus,
  insertMessage,
  hasUnprocessedMaxMessage,
} from "../db/queries.js";

// ── helpers ────────────────────────────────────────────────────────────────

const MACHINE_ID = "test-machine";

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
      resolved_at INTEGER
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
  opts: { status?: string; machine?: string; objective?: string }
): string {
  const obj = createObjective(db, {
    objective: opts.objective ?? "test objective",
    parent: undefined,
    machine: opts.machine ?? MACHINE_ID,
  });

  if (opts.status && opts.status !== "idle") {
    updateStatus(db, obj.id, opts.status);
  }

  return obj.id;
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("Max bypasses concurrency", () => {
  it("Max message bypasses idle cap (3 thinking)", () => {
    const db = createTestDb();

    // Fill all 3 idle slots
    addObjective(db, { status: "thinking" });
    addObjective(db, { status: "thinking" });
    addObjective(db, { status: "thinking" });

    // At the cap
    expect(atConcurrencyLimit(db, MACHINE_ID)).toBe(true);

    // Create a 4th objective with an unprocessed Max message
    const maxObjId = addObjective(db, { status: "idle", objective: "max-direct task" });
    insertMessage(db, {
      objective_id: maxObjId,
      message: "do this now",
      sender: "max",
    });

    // Has a Max message — should bypass the cap
    expect(hasUnprocessedMaxMessage(db, maxObjId)).toBe(true);

    db.close();
  });

  it("Max message bypasses even max_active cap (10 thinking)", () => {
    const db = createTestDb();

    // Fill all 10 max_active slots
    for (let i = 0; i < 10; i++) {
      addObjective(db, { status: "thinking" });
    }

    // At the max_active cap
    expect(atConcurrencyLimit(db, MACHINE_ID, 10)).toBe(true);

    // Create an 11th objective with a Max message
    const maxObjId = addObjective(db, { status: "idle", objective: "urgent max task" });
    insertMessage(db, {
      objective_id: maxObjId,
      message: "handle this",
      sender: "max",
    });

    // Has a Max message — should bypass regardless of cap
    expect(hasUnprocessedMaxMessage(db, maxObjId)).toBe(true);

    db.close();
  });

  it("non-Max message at cap is blocked", () => {
    const db = createTestDb();

    // Fill all 3 idle slots
    addObjective(db, { status: "thinking" });
    addObjective(db, { status: "thinking" });
    addObjective(db, { status: "thinking" });

    // At the cap
    expect(atConcurrencyLimit(db, MACHINE_ID)).toBe(true);

    // Create a 4th objective with only a system message
    const sysObjId = addObjective(db, { status: "idle", objective: "system task" });
    insertMessage(db, {
      objective_id: sysObjId,
      message: "scheduled check",
      sender: "system",
    });

    // No Max message — should NOT bypass the cap
    expect(hasUnprocessedMaxMessage(db, sysObjId)).toBe(false);
    // And the concurrency check blocks it
    expect(atConcurrencyLimit(db, MACHINE_ID)).toBe(true);

    db.close();
  });
});
