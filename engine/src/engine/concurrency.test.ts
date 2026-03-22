import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { atConcurrencyLimit, getAvailableSlots } from "./concurrency.js";
import {
  getPendingObjectives,
  createObjective,
  updateStatus,
  insertMessage,
} from "../db/queries.js";

// ── helpers ────────────────────────────────────────────────────────────────

const MACHINE_ID = "test-machine";

/**
 * Create an in-memory DB with just enough schema for concurrency + pending
 * objective tests. Mirrors the tables from schema.ts without filesystem ops
 * or seed data.
 */
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

/**
 * Insert an objective with a given status and machine assignment,
 * using createObjective + updateStatus so the FTS index stays consistent.
 */
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

describe("concurrency cap", () => {
  it("returns true when 3 objectives are thinking", () => {
    const db = createTestDb();

    addObjective(db, { status: "thinking" });
    addObjective(db, { status: "thinking" });
    addObjective(db, { status: "thinking" });

    expect(atConcurrencyLimit(db, MACHINE_ID)).toBe(true);
    expect(getAvailableSlots(db, MACHINE_ID)).toBe(0);

    db.close();
  });

  it("returns false when only 2 objectives are thinking", () => {
    const db = createTestDb();

    addObjective(db, { status: "thinking" });
    addObjective(db, { status: "thinking" });

    expect(atConcurrencyLimit(db, MACHINE_ID)).toBe(false);
    expect(getAvailableSlots(db, MACHINE_ID)).toBe(1);

    db.close();
  });

  it("pending objective is NOT picked up when at concurrency limit", () => {
    const db = createTestDb();

    // Fill all 3 slots
    addObjective(db, { status: "thinking" });
    addObjective(db, { status: "thinking" });
    addObjective(db, { status: "thinking" });

    // Create a pending objective with an unprocessed message
    const pendingId = addObjective(db, {
      status: "idle",
      objective: "waiting task",
    });
    insertMessage(db, {
      objective_id: pendingId,
      message: "please do this",
      sender: "max",
    });

    // The pending objective shows up in getPendingObjectives...
    const pending = getPendingObjectives(db);
    expect(pending.some((o) => o.id === pendingId)).toBe(true);

    // ...but the concurrency check blocks it from being dispatched
    expect(atConcurrencyLimit(db, MACHINE_ID)).toBe(true);

    db.close();
  });

  it("pending objective CAN be picked up after resolving one thinking objective", () => {
    const db = createTestDb();

    // Fill 2 of 3 slots
    const firstId = addObjective(db, { status: "thinking" });
    addObjective(db, { status: "thinking" });

    // Concurrency not yet reached
    expect(atConcurrencyLimit(db, MACHINE_ID)).toBe(false);

    // Now fill the last slot
    addObjective(db, { status: "thinking" });
    expect(atConcurrencyLimit(db, MACHINE_ID)).toBe(true);

    // Create a pending objective with an unprocessed message
    const pendingId = addObjective(db, {
      status: "idle",
      objective: "ready task",
    });
    insertMessage(db, {
      objective_id: pendingId,
      message: "go ahead",
      sender: "max",
    });

    // Resolve one thinking objective → frees a slot
    updateStatus(db, firstId, "resolved");
    expect(atConcurrencyLimit(db, MACHINE_ID)).toBe(false);
    expect(getAvailableSlots(db, MACHINE_ID)).toBe(1);

    // The pending objective is available and can now be dispatched
    const pending = getPendingObjectives(db);
    expect(pending.some((o) => o.id === pendingId)).toBe(true);

    db.close();
  });
});
