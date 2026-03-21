import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { assembleContext } from "./assembler.js";
import { createObjective, insertMessage, updateStatus, setResolutionSummary } from "../db/queries.js";
import personaBrick from "./bricks/persona/index.js";
import contractBrick from "./bricks/contract/index.js";
import environmentBrick from "./bricks/environment/index.js";
import objectiveBrick from "./bricks/objective/index.js";
import parentsBrick from "./bricks/parents/index.js";
import siblingsBrick from "./bricks/siblings/index.js";
import childrenBrick from "./bricks/children/index.js";
import similarBrick from "./bricks/similar/index.js";
import memoryBrick from "./bricks/memory/index.js";
import conversationBrick from "./bricks/conversation/index.js";
import neverBrick from "./bricks/never/index.js";
import focusBrick from "./bricks/focus/index.js";

const BRICKS = [
  personaBrick, contractBrick, environmentBrick, objectiveBrick,
  parentsBrick, siblingsBrick, childrenBrick, similarBrick,
  memoryBrick, conversationBrick, neverBrick, focusBrick,
];

const config = {
  bricks: {
    siblings:         { max_items: 15, max_tokens: 2000 },
    children:         { max_detailed: 5, max_oneliner: 15, max_tokens: 5000 },
    similar_resolved: { max_results: 3, max_tokens: 3000 },
    skills:           { max_tokens: 3000 },
    memories:         { max_results: 20, max_tokens: 3000 },
    conversation:     { per_message_max: 2000, max_tokens: { opus: 200000, sonnet: 80000, haiku: 80000 } },
  },
};

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

function seedTestTree(db: Database.Database) {
  // Root
  const root = createObjective(db, { objective: "Help Max thrive and succeed" });

  // Parent
  const parent = createObjective(db, { objective: "Complete the grant application package", parent: root.id });

  // Target (what we assemble for)
  const target = createObjective(db, { objective: "Draft the statement of purpose", parent: parent.id });

  // Siblings
  const sibActive = createObjective(db, { objective: "Collect recommendation letters", parent: parent.id });
  insertMessage(db, { objective_id: sibActive.id, message: "Waiting for Prof reply", sender: "max" });

  const sibResolved = createObjective(db, { objective: "Research program requirements", parent: parent.id });
  updateStatus(db, sibResolved.id, "resolved");
  setResolutionSummary(db, sibResolved.id, "Requirements documented in program-reqs.md");

  // Children of target
  const child1 = createObjective(db, { objective: "Write opening paragraph", parent: target.id });
  insertMessage(db, { objective_id: child1.id, message: "Opening paragraph drafted", sender: child1.id });

  createObjective(db, { objective: "Research faculty", parent: target.id });

  // Similar resolved (different branch, overlapping keywords)
  const similar = createObjective(db, { objective: "Write the statement of purpose for Oxford", parent: root.id });
  updateStatus(db, similar.id, "resolved");
  setResolutionSummary(db, similar.id, "Completed Oxford SOP, submitted Dec 2025");

  // Conversation on target with staggered timestamps
  db.prepare(
    "INSERT INTO inbox (id, objective_id, message, sender, type, created_at) VALUES (?, ?, ?, ?, 'message', ?)"
  ).run("msg-1", target.id, "Focus on the research narrative", "max", 1000);
  db.prepare(
    "INSERT INTO inbox (id, objective_id, message, sender, type, created_at) VALUES (?, ?, ?, ?, 'message', ?)"
  ).run("msg-2", target.id, "Child objective created", "system", 2000);
  db.prepare(
    "INSERT INTO inbox (id, objective_id, message, sender, type, created_at) VALUES (?, ?, ?, ?, 'message', ?)"
  ).run("msg-3", target.id, "Opening paragraph drafted", child1.id, 3000);

  return { root, parent, target, sibActive, sibResolved, child1 };
}

describe("Context assembly integration", () => {
  const db = createTestDb();
  const { target } = seedTestTree(db);

  const result = assembleContext(BRICKS, {
    db,
    objectiveId: target.id,
    budget: 200_000,
    config: config as unknown as Record<string, unknown>,
  });

  it("renders all expected bricks in correct order", () => {
    const expectedOrder = [
      "PERSONA", "ARIA", "ENVIRONMENT", "OBJECTIVE",
      "PARENTS", "SIBLINGS", "CHILDREN", "SIMILAR_RESOLVED",
      "MEMORIES", "CONVERSATION", "NEVER DO THIS", "FOCUS",
    ];
    const actualNames = result.sections.map((s) => s.name);
    expect(actualNames).toEqual(expectedOrder);
  });

  it("every section has tokens > 0", () => {
    for (const section of result.sections) {
      expect(section.tokens, `${section.name} should have tokens`).toBeGreaterThan(0);
    }
  });

  it("persona contains identity", () => {
    const s = result.sections.find((s) => s.name === "PERSONA")!;
    expect(s.content).toContain("You are Aria");
  });

  it("contract contains Aria Loop", () => {
    const s = result.sections.find((s) => s.name === "ARIA")!;
    expect(s.content).toContain("Aria Loop");
  });

  it("objective contains target text", () => {
    const s = result.sections.find((s) => s.name === "OBJECTIVE")!;
    expect(s.content).toContain("Draft the statement of purpose");
  });

  it("parents contains parent and root", () => {
    const s = result.sections.find((s) => s.name === "PARENTS")!;
    expect(s.content).toContain("Complete the grant application package");
    expect(s.content).toContain("Help Max thrive and succeed");
  });

  it("siblings contains both siblings", () => {
    const s = result.sections.find((s) => s.name === "SIBLINGS")!;
    expect(s.content).toContain("Collect recommendation letters");
    expect(s.content).toContain("Research program requirements");
  });

  it("children contains both children", () => {
    const s = result.sections.find((s) => s.name === "CHILDREN")!;
    expect(s.content).toContain("Write opening paragraph");
    expect(s.content).toContain("Research faculty");
  });

  it("similar resolved found matching objective", () => {
    const s = result.sections.find((s) => s.name === "SIMILAR_RESOLVED")!;
    expect(s.content).toContain("Oxford");
  });

  it("conversation is in chronological order (oldest first)", () => {
    const s = result.sections.find((s) => s.name === "CONVERSATION")!;
    const oldestIdx = s.content.indexOf("Focus on the research narrative");
    const newestIdx = s.content.indexOf("Opening paragraph drafted");
    expect(oldestIdx).toBeGreaterThan(-1);
    expect(newestIdx).toBeGreaterThan(-1);
    expect(oldestIdx).toBeLessThan(newestIdx);
  });

  it("never do this contains deny rules", () => {
    const s = result.sections.find((s) => s.name === "NEVER DO THIS")!;
    expect(s.content).toContain("Never delete files");
  });

  it("focus restates objective with two questions", () => {
    const s = result.sections.find((s) => s.name === "FOCUS")!;
    expect(s.content).toContain("Draft the statement of purpose");
    expect(s.content).toContain("Do I have the knowledge to act?");
  });

  it("memory brick renders when memories.db exists", () => {
    const memSection = result.sections.find((s) => s.name === "MEMORIES");
    // On machines with memories.db, this renders. On CI without it, it's skipped.
    // Either way, the assembler handles it gracefully.
    if (memSection) {
      expect(memSection.tokens).toBeGreaterThan(0);
    }
  });
});
