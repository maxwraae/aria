import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  createObjective,
  insertMessage,
  resolveCascadeId,
  stampMessages,
  createTurn,
  getCascadeTurnCount,
  stopCascade,
  getObjective,
  updateStatus,
} from "../db/queries.js";
import { generateId } from "../db/utils.js";

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
      cascade_id TEXT,
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

describe("cascade tracking", () => {
  it("insertMessage with explicit cascade_id stores it correctly", () => {
    const db = createTestDb();
    const obj = createObjective(db, { objective: "test" });
    const cascadeId = generateId();

    const msg = insertMessage(db, {
      objective_id: obj.id,
      message: "hello",
      sender: "max",
      cascade_id: cascadeId,
    });

    expect(msg.cascade_id).toBe(cascadeId);
    db.close();
  });

  it("insertMessage without cascade_id stores null", () => {
    const db = createTestDb();
    const obj = createObjective(db, { objective: "test" });

    const msg = insertMessage(db, {
      objective_id: obj.id,
      message: "hello",
      sender: "max",
    });

    expect(msg.cascade_id).toBeNull();
    db.close();
  });

  it("resolveCascadeId returns Max message's cascade_id when both Max and child messages pending", () => {
    const db = createTestDb();
    const parent = createObjective(db, { objective: "parent" });
    const child = createObjective(db, { objective: "child", parent: parent.id });

    const childCascade = generateId();
    const maxCascade = generateId();

    // Child reports back first
    insertMessage(db, {
      objective_id: parent.id,
      message: "child report",
      sender: child.id,
      cascade_id: childCascade,
    });

    // Max sends a message second
    insertMessage(db, {
      objective_id: parent.id,
      message: "Max says do this",
      sender: "max",
      cascade_id: maxCascade,
    });

    const resolved = resolveCascadeId(db, parent.id);
    expect(resolved).toBe(maxCascade);
    db.close();
  });

  it("resolveCascadeId returns most recent message's cascade_id when no Max message", () => {
    const db = createTestDb();
    const parent = createObjective(db, { objective: "parent" });
    const child1 = createObjective(db, { objective: "child1", parent: parent.id });
    const child2 = createObjective(db, { objective: "child2", parent: parent.id });

    const cascade1 = generateId();
    const cascade2 = generateId();

    insertMessage(db, {
      objective_id: parent.id,
      message: "child1 report",
      sender: child1.id,
      cascade_id: cascade1,
    });

    insertMessage(db, {
      objective_id: parent.id,
      message: "child2 report",
      sender: child2.id,
      cascade_id: cascade2,
    });

    const resolved = resolveCascadeId(db, parent.id);
    expect(resolved).toBe(cascade2); // most recent
    db.close();
  });

  it("resolveCascadeId returns null when no unprocessed messages", () => {
    const db = createTestDb();
    const obj = createObjective(db, { objective: "lonely" });

    const resolved = resolveCascadeId(db, obj.id);
    expect(resolved).toBeNull();
    db.close();
  });

  it("resolveCascadeId returns null when messages have no cascade_id", () => {
    const db = createTestDb();
    const obj = createObjective(db, { objective: "no cascade" });

    insertMessage(db, {
      objective_id: obj.id,
      message: "old message",
      sender: "system",
    });

    const resolved = resolveCascadeId(db, obj.id);
    expect(resolved).toBeNull();
    db.close();
  });

  it("resolveCascadeId ignores already-stamped messages", () => {
    const db = createTestDb();
    const obj = createObjective(db, { objective: "stamped" });

    const oldCascade = generateId();
    const newCascade = generateId();

    // Old message that's already been processed
    insertMessage(db, {
      objective_id: obj.id,
      message: "old",
      sender: "max",
      cascade_id: oldCascade,
    });

    // Stamp it (simulate a previous turn)
    const turn = createTurn(db, { objective_id: obj.id });
    stampMessages(db, obj.id, turn.id);

    // New message arrives
    insertMessage(db, {
      objective_id: obj.id,
      message: "new",
      sender: "system",
      cascade_id: newCascade,
    });

    const resolved = resolveCascadeId(db, obj.id);
    expect(resolved).toBe(newCascade); // only looks at unprocessed
    db.close();
  });

  it("can count turns per cascade via GROUP BY on stamped messages", () => {
    const db = createTestDb();
    const obj = createObjective(db, { objective: "multi-turn" });
    const cascadeId = generateId();

    // Simulate 3 turns in the same cascade
    for (let i = 0; i < 3; i++) {
      insertMessage(db, {
        objective_id: obj.id,
        message: `turn ${i}`,
        sender: "system",
        cascade_id: cascadeId,
      });
      const turn = createTurn(db, { objective_id: obj.id });
      stampMessages(db, obj.id, turn.id);
    }

    // Query: how many turns in this cascade?
    const result = db.prepare(`
      SELECT cascade_id, COUNT(DISTINCT turn_id) as turn_count
      FROM inbox
      WHERE cascade_id = ? AND turn_id IS NOT NULL
      GROUP BY cascade_id
    `).get(cascadeId) as { cascade_id: string; turn_count: number };

    expect(result.cascade_id).toBe(cascadeId);
    expect(result.turn_count).toBe(3);
    db.close();
  });

  it("createTurn stores cascade_id on the turn record", () => {
    const db = createTestDb();
    const obj = createObjective(db, { objective: "test" });
    const cascadeId = generateId();

    const turn = createTurn(db, { objective_id: obj.id, cascade_id: cascadeId });
    expect(turn.cascade_id).toBe(cascadeId);

    const count = getCascadeTurnCount(db, cascadeId);
    expect(count).toBe(1);
    db.close();
  });

  it("getCascadeTurnCount counts turns across multiple objectives", () => {
    const db = createTestDb();
    const parent = createObjective(db, { objective: "parent" });
    const child = createObjective(db, { objective: "child", parent: parent.id });
    const cascadeId = generateId();

    createTurn(db, { objective_id: parent.id, cascade_id: cascadeId });
    createTurn(db, { objective_id: child.id, cascade_id: cascadeId });
    createTurn(db, { objective_id: child.id, cascade_id: cascadeId });

    expect(getCascadeTurnCount(db, cascadeId)).toBe(3);
    db.close();
  });

  it("stopCascade stamps messages and sets objectives to stopped", () => {
    const db = createTestDb();
    const parent = createObjective(db, { objective: "parent" });
    const child1 = createObjective(db, { objective: "child1", parent: parent.id });
    const child2 = createObjective(db, { objective: "child2", parent: parent.id });
    const cascadeId = generateId();

    // Simulate unprocessed messages from this cascade
    insertMessage(db, { objective_id: parent.id, message: "msg", sender: "system", cascade_id: cascadeId });
    insertMessage(db, { objective_id: child1.id, message: "msg", sender: "system", cascade_id: cascadeId });
    insertMessage(db, { objective_id: child2.id, message: "msg", sender: "system", cascade_id: cascadeId });

    const stoppedIds = stopCascade(db, cascadeId);
    expect(stoppedIds).toHaveLength(3);

    // All objectives should be stopped
    expect(getObjective(db, parent.id)?.status).toBe("stopped");
    expect(getObjective(db, child1.id)?.status).toBe("stopped");
    expect(getObjective(db, child2.id)?.status).toBe("stopped");

    // All messages should be stamped
    const unprocessed = db.prepare(
      "SELECT COUNT(*) as count FROM inbox WHERE cascade_id = ? AND turn_id IS NULL"
    ).get(cascadeId) as { count: number };
    expect(unprocessed.count).toBe(0);

    db.close();
  });

  it("stopCascade skips already resolved objectives", () => {
    const db = createTestDb();
    const parent = createObjective(db, { objective: "parent" });
    const child = createObjective(db, { objective: "child", parent: parent.id });
    const cascadeId = generateId();

    // Child is already resolved
    updateStatus(db, child.id, "resolved");

    insertMessage(db, { objective_id: parent.id, message: "msg", sender: "system", cascade_id: cascadeId });
    insertMessage(db, { objective_id: child.id, message: "msg", sender: "system", cascade_id: cascadeId });

    const stoppedIds = stopCascade(db, cascadeId);
    expect(stoppedIds).toHaveLength(1);
    expect(stoppedIds[0]).toBe(parent.id);

    // Child stays resolved
    expect(getObjective(db, child.id)?.status).toBe("resolved");

    db.close();
  });
});
