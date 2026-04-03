import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";
import {
  createObjective,
  getObjective,
} from "../db/queries.js";
import objectiveBrick from "../context/bricks/objective/index.js";
import childrenBrick from "../context/bricks/children/index.js";
import siblingsBrick from "../context/bricks/siblings/index.js";
import parentsBrick from "../context/bricks/parents/index.js";
import focusBrick from "../context/bricks/focus/index.js";
import neverBrick from "../context/bricks/never/index.js";

// ── helpers ──────────────────────────────────────────────────────

const tmpDirs: string[] = [];

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

function seedRoot(db: Database.Database): void {
  const ts = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO objectives (id, objective, parent, status, created_at, updated_at)
     VALUES ('root', 'Help Max thrive and succeed', NULL, 'idle', ?, ?)`
  ).run(ts, ts);
  db.prepare(
    `INSERT INTO objectives_fts(rowid, objective, waiting_on, description, resolution_summary)
     SELECT rowid, objective, waiting_on, description, resolution_summary FROM objectives WHERE id = 'root'`
  ).run();
}

afterEach(() => {
  // Clean up any work files created during tests
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  tmpDirs.length = 0;
});

// ── createObjective creates work file ────────────────────────────

describe("work field — spawn", () => {
  it("creates a work file on disk when an objective is created", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, {
      objective: "Write the API docs",
      parent: "root",
    });

    // work_path should be set
    expect(child.work_path).toBeTruthy();
    expect(child.work_path).toContain(child.id);
    expect(child.work_path!.endsWith(".md")).toBe(true);

    // File should exist on disk
    expect(fs.existsSync(child.work_path!)).toBe(true);

    // File should be empty initially
    const content = fs.readFileSync(child.work_path!, "utf-8");
    expect(content).toBe("");

    // Clean up
    try { fs.unlinkSync(child.work_path!); } catch {}
    db.close();
  });

  it("work_path is stored in the database and retrievable", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, {
      objective: "Deploy staging",
      parent: "root",
    });

    const fetched = getObjective(db, child.id);
    expect(fetched).toBeTruthy();
    expect(fetched!.work_path).toBe(child.work_path);

    try { fs.unlinkSync(child.work_path!); } catch {}
    db.close();
  });
});

// ── Objective brick renders work content ─────────────────────────

describe("work field — objective brick", () => {
  it("renders work content and file path when work file has content", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, {
      objective: "Analyze the logs",
      description: "Check for error patterns",
      parent: "root",
    });

    // Write some content to the work file
    fs.writeFileSync(child.work_path!, "## Progress\n\n- Found 3 error patterns\n- Need to check rate limits");

    const result = objectiveBrick.render({ db, objectiveId: child.id, budget: 200_000, config: {} });
    expect(result).toBeTruthy();
    expect(result!.content).toContain("Found 3 error patterns");
    expect(result!.content).toContain("File:");
    expect(result!.content).toContain(child.work_path!);

    try { fs.unlinkSync(child.work_path!); } catch {}
    db.close();
  });

  it("shows empty prompt when work file is empty", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, {
      objective: "Draft the email",
      parent: "root",
    });

    const result = objectiveBrick.render({ db, objectiveId: child.id, budget: 200_000, config: {} });
    expect(result).toBeTruthy();
    expect(result!.content).toContain("empty");
    expect(result!.content).toContain("update this before you exit");

    try { fs.unlinkSync(child.work_path!); } catch {}
    db.close();
  });
});

// ── Children brick renders child work ────────────────────────────

describe("work field — children brick", () => {
  it("includes child work content in detailed view", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, {
      objective: "Build the feature",
      description: "New auth flow",
      parent: "root",
    });

    fs.writeFileSync(child.work_path!, "Auth flow is 80% complete. Login works, signup pending.");

    const result = childrenBrick.render({ db, objectiveId: "root", budget: 200_000, config: {} });
    expect(result).toBeTruthy();
    expect(result!.content).toContain("Auth flow is 80% complete");
    expect(result!.content).toContain("### Work");

    try { fs.unlinkSync(child.work_path!); } catch {}
    db.close();
  });
});

// ── Siblings brick renders sibling work ──────────────────────────

describe("work field — siblings brick", () => {
  it("includes sibling work content", () => {
    const db = createTestDb();
    seedRoot(db);

    const child1 = createObjective(db, {
      objective: "Task A",
      parent: "root",
    });
    const child2 = createObjective(db, {
      objective: "Task B",
      parent: "root",
    });

    fs.writeFileSync(child1.work_path!, "Task A is halfway done.");

    // Render siblings from child2's perspective
    const result = siblingsBrick.render({ db, objectiveId: child2.id, budget: 200_000, config: {} });
    expect(result).toBeTruthy();
    expect(result!.content).toContain("Task A is halfway done.");
    expect(result!.content).toContain("**Work:**");

    try { fs.unlinkSync(child1.work_path!); } catch {}
    try { fs.unlinkSync(child2.work_path!); } catch {}
    db.close();
  });
});

// ── Parents brick renders parent work ────────────────────────────

describe("work field — parents brick", () => {
  it("includes parent work content", () => {
    const db = createTestDb();
    seedRoot(db);

    // Give root a work_path manually since it's seeded without one
    const workDir = path.join(os.tmpdir(), `aria-test-${Date.now()}`);
    fs.mkdirSync(workDir, { recursive: true });
    tmpDirs.push(workDir);
    const rootWorkPath = path.join(workDir, "root.md");
    fs.writeFileSync(rootWorkPath, "Root objective is tracking 5 initiatives.");
    db.prepare("UPDATE objectives SET work_path = ? WHERE id = 'root'").run(rootWorkPath);

    const child = createObjective(db, {
      objective: "Sub-task",
      parent: "root",
    });

    const result = parentsBrick.render({ db, objectiveId: child.id, budget: 200_000, config: {} });
    expect(result).toBeTruthy();
    expect(result!.content).toContain("Root objective is tracking 5 initiatives.");
    expect(result!.content).toContain("## Work");

    try { fs.unlinkSync(child.work_path!); } catch {}
    db.close();
  });
});

// ── Focus brick includes reminder ────────────────────────────────

describe("work field — focus brick", () => {
  it("reminds agent to update work document with file path", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, {
      objective: "Do the thing",
      parent: "root",
    });

    const result = focusBrick.render({ db, objectiveId: child.id, budget: 200_000, config: {} });
    expect(result).toBeTruthy();
    expect(result!.content).toContain("update your work document");
    expect(result!.content).toContain(child.work_path!);

    try { fs.unlinkSync(child.work_path!); } catch {}
    db.close();
  });
});

// ── Never brick includes permissions ─────────────────────────────

describe("work field — never brick", () => {
  it("includes rule about not editing other objectives' work files", () => {
    const result = neverBrick.render({ db: null as any, objectiveId: "", budget: 200_000, config: {} });
    expect(result).toBeTruthy();
    expect(result!.content).toContain("Never edit another objective's work document");
  });

  it("includes rule about not editing objective or description", () => {
    const result = neverBrick.render({ db: null as any, objectiveId: "", budget: 200_000, config: {} });
    expect(result).toBeTruthy();
    expect(result!.content).toContain("Never edit objective or description fields");
  });
});
