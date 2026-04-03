import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  getPendingObjectives,
  createObjective,
  insertMessage,
} from "../db/queries.js";
import type { Objective } from "../db/queries.js";

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Replicates the machine filter from loop.ts (lines 142-145).
 * This is the exact logic the engine uses to decide which pending
 * objectives belong to the current machine.
 */
function filterByMachine(pending: Objective[], machineId: string): Objective[] {
  return pending.filter((obj) => {
    if (!obj.machine) return machineId === "mini"; // unassigned defaults to mini
    return obj.machine === machineId;
  });
}

/**
 * In-memory DB with the same schema as concurrency.test.ts.
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

// ── tests ──────────────────────────────────────────────────────────────────

describe("machine ownership filtering", () => {
  it("returns objective when machine matches", () => {
    const db = createTestDb();

    const obj = createObjective(db, {
      objective: "macbook task",
      machine: "macbook",
    });
    insertMessage(db, {
      objective_id: obj.id,
      message: "do this",
      sender: "max",
    });

    const pending = getPendingObjectives(db);
    const mine = filterByMachine(pending, "macbook");

    expect(mine.some((o) => o.id === obj.id)).toBe(true);

    db.close();
  });

  it("excludes objective when machine does not match", () => {
    const db = createTestDb();

    const obj = createObjective(db, {
      objective: "mini task",
      machine: "mini",
    });
    insertMessage(db, {
      objective_id: obj.id,
      message: "do this",
      sender: "max",
    });

    const pending = getPendingObjectives(db);
    const mine = filterByMachine(pending, "macbook");

    expect(mine.some((o) => o.id === obj.id)).toBe(false);

    db.close();
  });

  it("defaults unassigned objectives to mini", () => {
    const db = createTestDb();

    // Create objective with no machine (NULL)
    const obj = createObjective(db, {
      objective: "unassigned task",
    });
    insertMessage(db, {
      objective_id: obj.id,
      message: "do this",
      sender: "max",
    });

    const pending = getPendingObjectives(db);

    // mini should pick it up
    const miniPending = filterByMachine(pending, "mini");
    expect(miniPending.some((o) => o.id === obj.id)).toBe(true);

    // macbook should NOT
    const macbookPending = filterByMachine(pending, "macbook");
    expect(macbookPending.some((o) => o.id === obj.id)).toBe(false);

    db.close();
  });

  it("follows machine reassignment after toggle", () => {
    const db = createTestDb();

    const obj = createObjective(db, {
      objective: "toggled task",
      machine: "mini",
    });
    insertMessage(db, {
      objective_id: obj.id,
      message: "do this",
      sender: "max",
    });

    // Initially belongs to mini
    let pending = getPendingObjectives(db);
    expect(filterByMachine(pending, "mini").some((o) => o.id === obj.id)).toBe(true);
    expect(filterByMachine(pending, "macbook").some((o) => o.id === obj.id)).toBe(false);

    // Toggle to macbook
    db.prepare("UPDATE objectives SET machine = 'macbook' WHERE id = ?").run(obj.id);

    // Now belongs to macbook
    pending = getPendingObjectives(db);
    expect(filterByMachine(pending, "macbook").some((o) => o.id === obj.id)).toBe(true);
    expect(filterByMachine(pending, "mini").some((o) => o.id === obj.id)).toBe(false);

    db.close();
  });
});
