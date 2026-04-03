import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  createObjective,
  getObjective,
  getStuckObjectives,
  updateStatus,
  incrementFailCount,
  resetFailCount,
  insertMessage,
} from "../db/queries.js";
import { now } from "../db/utils.js";

// ── Constants matching loop.ts ──────────────────────────────────────────────
const STUCK_THRESHOLD = 10 * 60; // 10 minutes (seconds)
const MAX_FAIL_COUNT = 2;

// ── helpers ─────────────────────────────────────────────────────────────────

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

/**
 * Set an objective's updated_at to a specific timestamp directly in the DB.
 * This simulates time passing without waiting.
 */
function setUpdatedAt(db: Database.Database, id: string, timestamp: number): void {
  db.prepare("UPDATE objectives SET updated_at = ? WHERE id = ?").run(timestamp, id);
}

/**
 * Simulate the stuck recovery logic from loop.ts (lines 162-196).
 * Extracted here so we can test it without spawning the full engine poll loop.
 */
function recoverStuckObjectives(db: Database.Database): void {
  const stuck = getStuckObjectives(db, STUCK_THRESHOLD);
  for (const obj of stuck) {
    const failCount = incrementFailCount(db, obj.id);
    if (failCount >= MAX_FAIL_COUNT) {
      updateStatus(db, obj.id, "needs-input");

      const latest = getObjective(db, obj.id);
      const lastError = latest?.last_error ?? "";
      const errorSnippet = lastError
        ? lastError.slice(0, 300).replace(/\n/g, " ").trim()
        : "No diagnostic info captured.";

      insertMessage(db, {
        objective_id: obj.id,
        message: `[system] This objective has failed ${failCount} times and needs your attention.\n\nLast error: ${errorSnippet}`,
        sender: "system",
      });
    } else {
      updateStatus(db, obj.id, "idle");
    }
  }
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("stuck timeout recovery", () => {
  it("does NOT recover an objective that is within the threshold", () => {
    const db = createTestDb();

    const obj = createObjective(db, {
      objective: "recent thinking task",
      parent: undefined,
    });
    updateStatus(db, obj.id, "thinking");

    // Set updated_at to 5 minutes ago — well within the 10-minute threshold
    const fiveMinAgo = now() - 5 * 60;
    setUpdatedAt(db, obj.id, fiveMinAgo);

    recoverStuckObjectives(db);

    const after = getObjective(db, obj.id)!;
    expect(after.status).toBe("thinking");
    expect(after.fail_count).toBe(0);

    db.close();
  });

  it("recovers a stuck objective beyond the threshold (reset to idle, fail_count incremented)", () => {
    const db = createTestDb();

    const obj = createObjective(db, {
      objective: "stuck thinking task",
      parent: undefined,
    });
    updateStatus(db, obj.id, "thinking");

    // Set updated_at to 15 minutes ago — beyond the 10-minute threshold
    const thirtyFiveMinAgo = now() - 15 * 60;
    setUpdatedAt(db, obj.id, thirtyFiveMinAgo);

    recoverStuckObjectives(db);

    const after = getObjective(db, obj.id)!;
    expect(after.status).toBe("idle");
    expect(after.fail_count).toBe(1);

    db.close();
  });

  it("sets objective to needs-input after reaching MAX_FAIL_COUNT", () => {
    const db = createTestDb();

    const obj = createObjective(db, {
      objective: "repeatedly stuck task",
      parent: undefined,
    });
    updateStatus(db, obj.id, "thinking");

    // Pre-set fail_count to MAX_FAIL_COUNT - 1 (= 1), so the next increment hits 2
    db.prepare("UPDATE objectives SET fail_count = ? WHERE id = ?").run(
      MAX_FAIL_COUNT - 1,
      obj.id
    );

    // Push updated_at beyond the threshold
    const thirtyFiveMinAgo = now() - 35 * 60;
    setUpdatedAt(db, obj.id, thirtyFiveMinAgo);

    recoverStuckObjectives(db);

    const after = getObjective(db, obj.id)!;
    expect(after.status).toBe("needs-input");
    expect(after.fail_count).toBe(MAX_FAIL_COUNT);

    // Verify a system message was inserted
    const messages = db
      .prepare(
        "SELECT * FROM inbox WHERE objective_id = ? AND sender = 'system'"
      )
      .all(obj.id) as { message: string }[];
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[messages.length - 1].message).toContain(
      `failed ${MAX_FAIL_COUNT} times`
    );

    db.close();
  });

  it("objective stuck once then succeeds — fail_count resets to 0, next failure starts at 1", () => {
    const db = createTestDb();

    const obj = createObjective(db, {
      objective: "recoverable task",
      parent: undefined,
    });
    updateStatus(db, obj.id, "thinking");

    // First stuck recovery: push updated_at beyond threshold
    const thirtyFiveMinAgo = now() - 35 * 60;
    setUpdatedAt(db, obj.id, thirtyFiveMinAgo);

    recoverStuckObjectives(db);

    // After first recovery: idle with fail_count = 1
    let after = getObjective(db, obj.id)!;
    expect(after.status).toBe("idle");
    expect(after.fail_count).toBe(1);

    // Simulate a successful next turn: objective goes back to thinking
    // and completes normally (output.ts calls resetFailCount on success)
    updateStatus(db, obj.id, "thinking");
    updateStatus(db, obj.id, "idle");
    resetFailCount(db, obj.id);

    after = getObjective(db, obj.id)!;
    expect(after.status).toBe("idle");
    // Success resets fail_count to 0 — circuit breaker tracks consecutive failures only
    expect(after.fail_count).toBe(0);

    // A second stuck recovery increments to 1 (not 2), proving the reset worked
    updateStatus(db, obj.id, "thinking");
    setUpdatedAt(db, obj.id, now() - 35 * 60);
    recoverStuckObjectives(db);

    after = getObjective(db, obj.id)!;
    expect(after.status).toBe("idle");
    expect(after.fail_count).toBe(1);

    db.close();
  });
});
