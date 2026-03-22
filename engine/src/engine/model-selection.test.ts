import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { resolveModel } from "./spawn.js";
import {
  createObjective,
  insertMessage,
  updateObjective,
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

// ── tests ──────────────────────────────────────────────────────────────────

describe("model selection", () => {
  it("returns opus when Max has an unprocessed message", () => {
    const db = createTestDb();
    const obj = createObjective(db, { objective: "test task" });

    insertMessage(db, {
      objective_id: obj.id,
      message: "do this thing",
      sender: "max",
    });

    expect(resolveModel(db, obj.id)).toBe("opus");
    db.close();
  });

  it("returns sonnet when no Max message in unprocessed batch", () => {
    const db = createTestDb();
    const obj = createObjective(db, { objective: "system task" });

    insertMessage(db, {
      objective_id: obj.id,
      message: "spawned by parent",
      sender: "system",
    });

    expect(resolveModel(db, obj.id)).toBe("sonnet");
    db.close();
  });

  it("child of Max-messaged objective gets sonnet (no propagation)", () => {
    const db = createTestDb();
    const parent = createObjective(db, { objective: "parent task" });

    insertMessage(db, {
      objective_id: parent.id,
      message: "Max said something",
      sender: "max",
    });

    const child = createObjective(db, {
      objective: "child task",
      parent: parent.id,
    });

    insertMessage(db, {
      objective_id: child.id,
      message: "context from parent",
      sender: parent.id,
    });

    expect(resolveModel(db, child.id)).toBe("sonnet");
    db.close();
  });

  it("explicit model override wins over Max message", () => {
    const db = createTestDb();
    const obj = createObjective(db, { objective: "special task", model: "haiku" });

    insertMessage(db, {
      objective_id: obj.id,
      message: "do this",
      sender: "max",
    });

    expect(resolveModel(db, obj.id)).toBe("haiku");
    db.close();
  });
});
