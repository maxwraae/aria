import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  getPendingObjectives,
  createObjective,
  updateStatus,
  insertMessage,
} from "../db/queries.js";

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
 * Create an objective, set its urgent/important flags and created_at timestamp,
 * then give it an unprocessed inbox message so getPendingObjectives picks it up.
 */
function addPriorityObjective(
  db: Database.Database,
  opts: {
    urgent: boolean;
    important: boolean;
    createdAt: number;
    status?: string;
    objective?: string;
  }
): string {
  const obj = createObjective(db, {
    objective: opts.objective ?? "test objective",
  });

  // Set priority flags and created_at directly (createObjective doesn't expose these)
  db.prepare(
    "UPDATE objectives SET urgent = ?, important = ?, created_at = ? WHERE id = ?"
  ).run(opts.urgent ? 1 : 0, opts.important ? 1 : 0, opts.createdAt, obj.id);

  if (opts.status && opts.status !== "idle") {
    updateStatus(db, obj.id, opts.status);
  }

  // Each pending objective needs at least one unprocessed inbox message
  insertMessage(db, {
    objective_id: obj.id,
    message: "ping",
    sender: "max",
  });

  return obj.id;
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("priority ordering", () => {
  it("returns objectives ordered by urgent DESC, important DESC, created_at ASC", () => {
    const db = createTestDb();
    const now = Math.floor(Date.now() / 1000);

    const idA = addPriorityObjective(db, {
      urgent: true,
      important: true,
      createdAt: now - 3600, // 1 hour ago
      objective: "A: urgent+important",
    });

    const idB = addPriorityObjective(db, {
      urgent: true,
      important: false,
      createdAt: now - 1800, // 30 min ago
      objective: "B: urgent only",
    });

    const idC = addPriorityObjective(db, {
      urgent: false,
      important: true,
      createdAt: now - 7200, // 2 hours ago
      objective: "C: important only",
    });

    const idD = addPriorityObjective(db, {
      urgent: false,
      important: false,
      createdAt: now - 600, // 10 min ago
      objective: "D: neither",
    });

    const pending = getPendingObjectives(db);
    const ids = pending.map((o) => o.id);

    expect(ids).toEqual([idA, idB, idC, idD]);

    db.close();
  });

  it("oldest first within the same priority bucket", () => {
    const db = createTestDb();
    const now = Math.floor(Date.now() / 1000);

    const idE = addPriorityObjective(db, {
      urgent: true,
      important: true,
      createdAt: now - 7200, // 2 hours ago
      objective: "E: older",
    });

    const idF = addPriorityObjective(db, {
      urgent: true,
      important: true,
      createdAt: now - 3600, // 1 hour ago
      objective: "F: newer",
    });

    const pending = getPendingObjectives(db);
    const ids = pending.map((o) => o.id);

    expect(ids[0]).toBe(idE);
    expect(ids[1]).toBe(idF);

    db.close();
  });

  it("excludes objectives in thinking status", () => {
    const db = createTestDb();
    const now = Math.floor(Date.now() / 1000);

    const idG = addPriorityObjective(db, {
      urgent: true,
      important: true,
      createdAt: now - 3600,
      objective: "G: idle",
    });

    // This one is thinking — should be excluded
    addPriorityObjective(db, {
      urgent: true,
      important: true,
      createdAt: now - 1800,
      status: "thinking",
      objective: "H: thinking",
    });

    const idI = addPriorityObjective(db, {
      urgent: false,
      important: false,
      createdAt: now - 600,
      objective: "I: idle",
    });

    const pending = getPendingObjectives(db);
    const ids = pending.map((o) => o.id);

    expect(ids).toEqual([idG, idI]);

    db.close();
  });
});
