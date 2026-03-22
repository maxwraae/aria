import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import environmentBrick from "./index.js";
import { createObjective, insertMessage, createTurn } from "../../../db/queries.js";

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
  `);

  return db;
}

describe("environment brick — This cycle section", () => {
  it("includes This cycle section when db and objectiveId are provided", () => {
    const db = createTestDb();
    const obj = createObjective(db, { objective: "Test objective" });
    insertMessage(db, { objective_id: obj.id, message: "Do the thing", sender: "max" });

    const result = environmentBrick.render({ db, objectiveId: obj.id, budget: 200_000, config: {} });

    expect(result).not.toBeNull();
    expect(result!.content).toContain("## This cycle");
    expect(result!.content).toContain("Turn: 1");
    expect(result!.content).toContain("Triggered by: max");
  });

  it("computes turn number as previous turns + 1", () => {
    const db = createTestDb();
    const obj = createObjective(db, { objective: "Multi-turn objective" });

    // Create 3 previous turns
    createTurn(db, { objective_id: obj.id });
    createTurn(db, { objective_id: obj.id });
    createTurn(db, { objective_id: obj.id });

    insertMessage(db, { objective_id: obj.id, message: "Next task", sender: "max" });

    const result = environmentBrick.render({ db, objectiveId: obj.id, budget: 200_000, config: {} });

    expect(result!.content).toContain("Turn: 4");
  });

  it("shows correct sender labels for child triggers", () => {
    const db = createTestDb();
    const parent = createObjective(db, { objective: "Parent objective" });
    const child = createObjective(db, { objective: "Test suite covers edge cases", parent: parent.id });

    insertMessage(db, { objective_id: parent.id, message: "Work complete", sender: child.id });

    const result = environmentBrick.render({ db, objectiveId: parent.id, budget: 200_000, config: {} });

    const shortId = child.id.slice(0, 7);
    expect(result!.content).toContain(`Triggered by: child:${shortId} "Test suite covers edge cases"`);
  });

  it("deduplicates multiple messages from same sender", () => {
    const db = createTestDb();
    const obj = createObjective(db, { objective: "Test dedup" });
    insertMessage(db, { objective_id: obj.id, message: "First message", sender: "max" });
    insertMessage(db, { objective_id: obj.id, message: "Second message", sender: "max" });

    const result = environmentBrick.render({ db, objectiveId: obj.id, budget: 200_000, config: {} });

    // "max" should appear only once in Triggered by
    const triggeredLine = result!.content.split("\n").find((l: string) => l.startsWith("Triggered by:"));
    expect(triggeredLine).toBe("Triggered by: max");
  });

  it("shows multiple unique senders", () => {
    const db = createTestDb();
    const parent = createObjective(db, { objective: "Multi-trigger parent" });
    const child1 = createObjective(db, { objective: "First child task", parent: parent.id });
    const child2 = createObjective(db, { objective: "Second child task", parent: parent.id });

    insertMessage(db, { objective_id: parent.id, message: "Done part 1", sender: child1.id });
    insertMessage(db, { objective_id: parent.id, message: "Done part 2", sender: child2.id });

    const result = environmentBrick.render({ db, objectiveId: parent.id, budget: 200_000, config: {} });

    const triggeredLine = result!.content.split("\n").find((l: string) => l.startsWith("Triggered by:"));
    expect(triggeredLine).toContain(child1.id.slice(0, 7));
    expect(triggeredLine).toContain(child2.id.slice(0, 7));
  });

  it("renders important/urgent from objective", () => {
    const db = createTestDb();
    const obj = createObjective(db, { objective: "Important task" });
    // Set important=1, urgent=1 directly
    db.prepare("UPDATE objectives SET important = 1, urgent = 1 WHERE id = ?").run(obj.id);
    insertMessage(db, { objective_id: obj.id, message: "Go", sender: "max" });

    const result = environmentBrick.render({ db, objectiveId: obj.id, budget: 200_000, config: {} });

    expect(result!.content).toContain("Important: yes");
    expect(result!.content).toContain("Urgent: yes");
  });

  it("renders important/urgent as no when false", () => {
    const db = createTestDb();
    const obj = createObjective(db, { objective: "Normal task" });
    insertMessage(db, { objective_id: obj.id, message: "Go", sender: "max" });

    const result = environmentBrick.render({ db, objectiveId: obj.id, budget: 200_000, config: {} });

    expect(result!.content).toContain("Important: no");
    expect(result!.content).toContain("Urgent: no");
  });

  it("renders depth from objective", () => {
    const db = createTestDb();
    const root = createObjective(db, { objective: "Root" });
    const mid = createObjective(db, { objective: "Mid", parent: root.id });
    const deep = createObjective(db, { objective: "Deep task", parent: mid.id });
    insertMessage(db, { objective_id: deep.id, message: "Go", sender: "max" });

    const result = environmentBrick.render({ db, objectiveId: deep.id, budget: 200_000, config: {} });

    expect(result!.content).toContain("Depth: 2");
  });

  it("shows Failures line only when fail_count > 0", () => {
    const db = createTestDb();
    const obj = createObjective(db, { objective: "Failing task" });
    db.prepare("UPDATE objectives SET fail_count = 3 WHERE id = ?").run(obj.id);
    insertMessage(db, { objective_id: obj.id, message: "Retry", sender: "system" });

    const result = environmentBrick.render({ db, objectiveId: obj.id, budget: 200_000, config: {} });

    expect(result!.content).toContain("Failures: 3");
  });

  it("omits Failures line when fail_count is 0", () => {
    const db = createTestDb();
    const obj = createObjective(db, { objective: "Clean task" });
    insertMessage(db, { objective_id: obj.id, message: "Go", sender: "max" });

    const result = environmentBrick.render({ db, objectiveId: obj.id, budget: 200_000, config: {} });

    expect(result!.content).not.toContain("Failures:");
  });

  it("renders without This cycle section when db is null", () => {
    const result = environmentBrick.render({ db: null, objectiveId: null, budget: 200_000, config: {} });

    expect(result).not.toBeNull();
    expect(result!.content).toContain("# ENVIRONMENT");
    expect(result!.content).not.toContain("## This cycle");
  });
});
