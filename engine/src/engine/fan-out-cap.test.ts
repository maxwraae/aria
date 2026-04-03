import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  createObjective,
  updateStatus,
  getActiveChildCount,
  getMaxChildren,
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

describe("fan-out cap", () => {
  it("agent creates 10 children under one parent — getActiveChildCount returns 10", () => {
    const db = createTestDb();
    const parent = createObjective(db, { objective: "parent" });

    for (let i = 0; i < 10; i++) {
      createObjective(db, { objective: `child-${i}`, parent: parent.id });
    }

    const count = getActiveChildCount(db, parent.id);
    expect(count).toBe(10);

    db.close();
  });

  it("after 10 active children, count >= getMaxChildren is true — cap would be enforced", () => {
    const db = createTestDb();
    const parent = createObjective(db, { objective: "parent" });

    for (let i = 0; i < 10; i++) {
      createObjective(db, { objective: `child-${i}`, parent: parent.id });
    }

    const count = getActiveChildCount(db, parent.id);
    expect(count >= getMaxChildren()).toBe(true);

    db.close();
  });

  it("10 children created, 3 get resolved — getActiveChildCount returns 7", () => {
    const db = createTestDb();
    const parent = createObjective(db, { objective: "parent" });
    const ids: string[] = [];

    for (let i = 0; i < 10; i++) {
      const child = createObjective(db, { objective: `child-${i}`, parent: parent.id });
      ids.push(child.id);
    }

    // Resolve 3 children
    updateStatus(db, ids[0], "resolved");
    updateStatus(db, ids[1], "resolved");
    updateStatus(db, ids[2], "resolved");

    const count = getActiveChildCount(db, parent.id);
    expect(count).toBe(7);

    db.close();
  });

  it("10 children created, 3 get failed — getActiveChildCount returns 7", () => {
    const db = createTestDb();
    const parent = createObjective(db, { objective: "parent" });
    const ids: string[] = [];

    for (let i = 0; i < 10; i++) {
      const child = createObjective(db, { objective: `child-${i}`, parent: parent.id });
      ids.push(child.id);
    }

    // Fail 3 children
    updateStatus(db, ids[0], "failed");
    updateStatus(db, ids[1], "failed");
    updateStatus(db, ids[2], "failed");

    const count = getActiveChildCount(db, parent.id);
    expect(count).toBe(7);

    db.close();
  });

  it("10 children created, 3 get abandoned — getActiveChildCount returns 7", () => {
    const db = createTestDb();
    const parent = createObjective(db, { objective: "parent" });
    const ids: string[] = [];

    for (let i = 0; i < 10; i++) {
      const child = createObjective(db, { objective: `child-${i}`, parent: parent.id });
      ids.push(child.id);
    }

    // Abandon 3 children
    updateStatus(db, ids[0], "abandoned");
    updateStatus(db, ids[1], "abandoned");
    updateStatus(db, ids[2], "abandoned");

    const count = getActiveChildCount(db, parent.id);
    expect(count).toBe(7);

    db.close();
  });
});
