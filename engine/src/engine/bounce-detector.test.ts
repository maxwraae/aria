import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import {
  createObjective,
  insertMessage,
  getObjective,
  getUnprocessedMessages,
  updateStatus,
} from "../db/queries.js";

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

describe("bounce detector", () => {
  it("4 exchanges between pair in window → not bouncing", () => {
    const db = createTestDb();

    const A = createObjective(db, { objective: "objective A" });
    const B = createObjective(db, { objective: "objective B" });

    insertMessage(db, { objective_id: B.id, message: "msg 1", sender: A.id });
    insertMessage(db, { objective_id: A.id, message: "msg 2", sender: B.id });
    insertMessage(db, { objective_id: B.id, message: "msg 3", sender: A.id });
    insertMessage(db, { objective_id: A.id, message: "msg 4", sender: B.id });

    expect(isBouncing(db, A.id, B.id, 1800, 5)).toBe(false);

    db.close();
  });

  it("5 exchanges between pair in window → bouncing", () => {
    const db = createTestDb();

    const A = createObjective(db, { objective: "objective A" });
    const B = createObjective(db, { objective: "objective B" });

    insertMessage(db, { objective_id: B.id, message: "msg 1", sender: A.id });
    insertMessage(db, { objective_id: A.id, message: "msg 2", sender: B.id });
    insertMessage(db, { objective_id: B.id, message: "msg 3", sender: A.id });
    insertMessage(db, { objective_id: A.id, message: "msg 4", sender: B.id });
    insertMessage(db, { objective_id: B.id, message: "msg 5", sender: A.id });

    expect(isBouncing(db, A.id, B.id, 1800, 5)).toBe(true);

    db.close();
  });

  it("5 exchanges but Max messaged one → not bouncing", () => {
    const db = createTestDb();

    const A = createObjective(db, { objective: "objective A" });
    const B = createObjective(db, { objective: "objective B" });

    insertMessage(db, { objective_id: B.id, message: "msg 1", sender: A.id });
    insertMessage(db, { objective_id: A.id, message: "msg 2", sender: B.id });
    insertMessage(db, { objective_id: B.id, message: "msg 3", sender: A.id });
    insertMessage(db, { objective_id: A.id, message: "msg 4", sender: B.id });
    insertMessage(db, { objective_id: B.id, message: "msg 5", sender: A.id });

    insertMessage(db, { objective_id: A.id, message: "check", sender: "max" });

    expect(isBouncing(db, A.id, B.id, 1800, 5)).toBe(false);

    db.close();
  });

  it("5 exchanges outside window → not bouncing", () => {
    const db = createTestDb();

    const A = createObjective(db, { objective: "objective A" });
    const B = createObjective(db, { objective: "objective B" });

    const timestamp = Math.floor(Date.now() / 1000) - 2700;
    const insert = db.prepare(
      "INSERT INTO inbox (id, objective_id, message, sender, type, created_at) VALUES (?, ?, ?, ?, 'message', ?)"
    );

    insert.run(randomUUID(), B.id, "msg 1", A.id, timestamp);
    insert.run(randomUUID(), A.id, "msg 2", B.id, timestamp);
    insert.run(randomUUID(), B.id, "msg 3", A.id, timestamp);
    insert.run(randomUUID(), A.id, "msg 4", B.id, timestamp);
    insert.run(randomUUID(), B.id, "msg 5", A.id, timestamp);

    expect(isBouncing(db, A.id, B.id, 1800, 5)).toBe(false);

    db.close();
  });

  it("independent pairs don't interfere", () => {
    const db = createTestDb();

    const A = createObjective(db, { objective: "objective A" });
    const B = createObjective(db, { objective: "objective B" });
    const C = createObjective(db, { objective: "objective C" });

    insertMessage(db, { objective_id: B.id, message: "msg 1", sender: A.id });
    insertMessage(db, { objective_id: A.id, message: "msg 2", sender: B.id });
    insertMessage(db, { objective_id: B.id, message: "msg 3", sender: A.id });
    insertMessage(db, { objective_id: A.id, message: "msg 4", sender: B.id });
    insertMessage(db, { objective_id: B.id, message: "msg 5", sender: A.id });

    insertMessage(db, { objective_id: C.id, message: "msg 1", sender: A.id });
    insertMessage(db, { objective_id: A.id, message: "msg 2", sender: C.id });

    expect(isBouncing(db, A.id, B.id, 1800, 5)).toBe(true);
    expect(isBouncing(db, A.id, C.id, 1800, 5)).toBe(false);

    db.close();
  });

  it("integration: bounce blocks routing and sets needs-input with system message", () => {
    const db = createTestDb();

    const parent = createObjective(db, { objective: "parent" });
    const child = createObjective(db, { objective: "child", parent: parent.id });

    // Build up 5 exchanges between the pair (existing bounce history)
    insertMessage(db, { objective_id: child.id, message: "status update 1", sender: parent.id });
    insertMessage(db, { objective_id: parent.id, message: "confirmed 1", sender: child.id });
    insertMessage(db, { objective_id: child.id, message: "status update 2", sender: parent.id });
    insertMessage(db, { objective_id: parent.id, message: "confirmed 2", sender: child.id });
    insertMessage(db, { objective_id: child.id, message: "status update 3", sender: parent.id });

    // Now simulate what output.ts does at routing time:
    // child's turn just finished, it would normally route its reply to parent
    expect(isBouncing(db, child.id, parent.id, 1800, 5)).toBe(true);

    // Simulate the bounce handler: set child to needs-input, insert system msg, DON'T route
    updateStatus(db, child.id, "needs-input");
    insertMessage(db, {
      objective_id: child.id,
      message: `[system] Bounce detected: 5+ exchanges with ${parent.id.slice(0, 8)} in 30 min without Max involvement. Paused to prevent loop.`,
      sender: "system",
      type: "message",
    });

    // Verify: child is needs-input
    const updatedChild = getObjective(db, child.id)!;
    expect(updatedChild.status).toBe("needs-input");

    // Verify: parent did NOT receive a new message (routing was blocked)
    // Parent should only have the 2 "confirmed" messages from before, no new one
    const parentMessages = db.prepare(
      "SELECT * FROM inbox WHERE objective_id = ? AND sender = ?"
    ).all(parent.id, child.id) as { message: string }[];
    expect(parentMessages.length).toBe(2); // only the old ones, no new routing

    // Verify: child got the system bounce message
    const childSystemMsgs = db.prepare(
      "SELECT * FROM inbox WHERE objective_id = ? AND sender = 'system'"
    ).all(child.id) as { message: string }[];
    expect(childSystemMsgs.length).toBe(1);
    expect(childSystemMsgs[0].message).toContain("Bounce detected");

    db.close();
  });

  it("integration: below threshold routes normally", () => {
    const db = createTestDb();

    const parent = createObjective(db, { objective: "parent" });
    const child = createObjective(db, { objective: "child", parent: parent.id });

    // Only 4 exchanges — below threshold
    insertMessage(db, { objective_id: child.id, message: "update 1", sender: parent.id });
    insertMessage(db, { objective_id: parent.id, message: "reply 1", sender: child.id });
    insertMessage(db, { objective_id: child.id, message: "update 2", sender: parent.id });
    insertMessage(db, { objective_id: parent.id, message: "reply 2", sender: child.id });

    // Not bouncing — routing should proceed
    expect(isBouncing(db, child.id, parent.id, 1800, 5)).toBe(false);

    // Simulate normal routing: child's reply goes to parent
    updateStatus(db, child.id, "idle");
    insertMessage(db, {
      objective_id: parent.id,
      message: "child's turn output",
      sender: child.id,
      type: "reply",
    });

    // Parent got the routed message
    const parentMessages = db.prepare(
      "SELECT * FROM inbox WHERE objective_id = ? AND sender = ?"
    ).all(parent.id, child.id) as { message: string }[];
    expect(parentMessages.length).toBe(3); // 2 old replies + 1 new routed

    // Child stays idle, not needs-input
    const updatedChild = getObjective(db, child.id)!;
    expect(updatedChild.status).toBe("idle");

    db.close();
  });
});
