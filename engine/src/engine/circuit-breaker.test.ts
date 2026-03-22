import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  createObjective,
  updateStatus,
  insertMessage,
  incrementFailCount,
  resetFailCount,
  getObjective,
  getPendingObjectives,
} from "../db/queries.js";

// ── helpers ────────────────────────────────────────────────────────────────

const MAX_FAIL_COUNT = 2; // mirrors engine/loop.ts

/**
 * In-memory DB with the same schema as concurrency.test.ts.
 * No filesystem, no seeds — pure isolation.
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

// ── tests ──────────────────────────────────────────────────────────────────

describe("circuit breaker", () => {
  it("single failure increments fail_count to 1, objective stays eligible", () => {
    const db = createTestDb();

    const obj = createObjective(db, { objective: "flaky task" });
    // Simulate the engine detecting a stuck objective
    updateStatus(db, obj.id, "thinking");

    const failCount = incrementFailCount(db, obj.id);
    expect(failCount).toBe(1);

    // Below threshold → engine resets to idle
    updateStatus(db, obj.id, "idle");

    // Add an unprocessed message so it shows up in pending
    insertMessage(db, {
      objective_id: obj.id,
      message: "retry this",
      sender: "max",
    });

    const pending = getPendingObjectives(db);
    expect(pending.some((o) => o.id === obj.id)).toBe(true);

    const updated = getObjective(db, obj.id)!;
    expect(updated.fail_count).toBe(1);
    expect(updated.status).toBe("idle");

    db.close();
  });

  it("hitting the threshold (2 failures) sets status to needs-input", () => {
    const db = createTestDb();

    const obj = createObjective(db, { objective: "doomed task" });
    updateStatus(db, obj.id, "thinking");

    // Simulate 2 consecutive stuck recoveries
    let failCount = 0;
    for (let i = 0; i < MAX_FAIL_COUNT; i++) {
      failCount = incrementFailCount(db, obj.id);
    }

    expect(failCount).toBe(MAX_FAIL_COUNT);
    expect(failCount >= MAX_FAIL_COUNT).toBe(true);

    // Engine would set to needs-input at this point
    updateStatus(db, obj.id, "needs-input");

    // Insert the system diagnostic message (mirrors loop.ts behavior)
    insertMessage(db, {
      objective_id: obj.id,
      message: `[system] This objective has failed ${failCount} times and needs your attention.`,
      sender: "system",
    });

    const updated = getObjective(db, obj.id)!;
    expect(updated.status).toBe("needs-input");
    expect(updated.fail_count).toBe(2);

    db.close();
  });

  it("fail_count resets after success, so a new failure starts from 0", () => {
    const db = createTestDb();

    const obj = createObjective(db, { objective: "intermittent task" });
    updateStatus(db, obj.id, "thinking");

    // First failure
    const first = incrementFailCount(db, obj.id);
    expect(first).toBe(1);

    // Engine resets to idle (below threshold)
    updateStatus(db, obj.id, "idle");

    // Simulate a successful turn: reset fail_count to 0
    resetFailCount(db, obj.id);

    const afterReset = getObjective(db, obj.id)!;
    expect(afterReset.fail_count).toBe(0);

    // Another failure after the reset — starts from 1, not 2
    updateStatus(db, obj.id, "thinking");
    const second = incrementFailCount(db, obj.id);
    expect(second).toBe(1);

    // Still below threshold → eligible
    updateStatus(db, obj.id, "idle");
    insertMessage(db, {
      objective_id: obj.id,
      message: "keep going",
      sender: "max",
    });

    const pending = getPendingObjectives(db);
    expect(pending.some((o) => o.id === obj.id)).toBe(true);

    const final = getObjective(db, obj.id)!;
    expect(final.fail_count).toBe(1);
    expect(final.status).toBe("idle");

    db.close();
  });

  it("needs-input objective is EXCLUDED from getPendingObjectives (waits for human intervention)", () => {
    const db = createTestDb();

    const obj = createObjective(db, { objective: "broken task" });
    updateStatus(db, obj.id, "thinking");

    // Trip the circuit breaker
    for (let i = 0; i < MAX_FAIL_COUNT; i++) {
      incrementFailCount(db, obj.id);
    }
    updateStatus(db, obj.id, "needs-input");

    // System message from the circuit breaker (unprocessed)
    insertMessage(db, {
      objective_id: obj.id,
      message: `[system] This objective has failed 2 times and needs your attention.`,
      sender: "system",
    });

    // needs-input should NOT appear in pending — it requires human intervention
    const pending = getPendingObjectives(db);
    expect(pending.some((o) => o.id === obj.id)).toBe(false);

    const updated = getObjective(db, obj.id)!;
    expect(updated.status).toBe("needs-input");
    expect(updated.fail_count).toBe(2);

    db.close();
  });

  it("fail-succeed-fail cycle: fail_count resets on success, so second failure starts at 1", () => {
    const db = createTestDb();

    const obj = createObjective(db, { objective: "flaky but recoverable" });

    // First failure
    updateStatus(db, obj.id, "thinking");
    const first = incrementFailCount(db, obj.id);
    expect(first).toBe(1);
    updateStatus(db, obj.id, "idle");

    // Successful turn — reset fail_count
    resetFailCount(db, obj.id);
    const afterSuccess = getObjective(db, obj.id)!;
    expect(afterSuccess.fail_count).toBe(0);

    // Second failure after success — starts from 1, not 2
    updateStatus(db, obj.id, "thinking");
    const second = incrementFailCount(db, obj.id);
    expect(second).toBe(1);

    // Confirm it's 1, not cumulative 2
    const final = getObjective(db, obj.id)!;
    expect(final.fail_count).toBe(1);

    db.close();
  });
});
