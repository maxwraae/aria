import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  createObjective,
  getObjective,
  getChildren,
  insertMessage,
  getUnprocessedMessages,
  getConversation,
  updateStatus,
  setWaitingOn,
  clearWaitingOn,
  setResolutionSummary,
  cascadeAbandon,
  searchObjectives,
  getTree,
  createSchedule,
  listSchedules,
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

/** Seed a root objective so parent references work. */
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

// ── tests ──────────────────────────────────────────────────────────────────

describe("aria create", () => {
  it("creates a child objective with correct parent reference", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, {
      objective: "Deploy the new API",
      parent: "root",
    });

    expect(child.parent).toBe("root");
    expect(child.objective).toBe("Deploy the new API");
    expect(child.id).toBeTruthy();
    db.close();
  });

  it("child status starts as idle", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, {
      objective: "Write tests",
      parent: "root",
    });

    expect(child.status).toBe("idle");
    db.close();
  });

  it("uses specified model", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, {
      objective: "Heavy reasoning task",
      parent: "root",
      model: "opus",
    });

    expect(child.model).toBe("opus");
    db.close();
  });

  it("defaults model to sonnet", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, {
      objective: "Normal task",
      parent: "root",
    });

    expect(child.model).toBe("sonnet");
    db.close();
  });

  it("inserts instruction message in child inbox when instructions provided", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, {
      objective: "Fix the login bug",
      parent: "root",
    });

    // Simulate what the CLI does: insert message from parent to child
    const senderId = "root";
    insertMessage(db, {
      objective_id: child.id,
      message: "Check the auth middleware first",
      sender: senderId,
      type: "message",
    });

    const messages = getUnprocessedMessages(db, child.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toBe("Check the auth middleware first");
    expect(messages[0].sender).toBe("root");
    expect(messages[0].turn_id).toBeNull();
    db.close();
  });

  it("no instruction message when instructions not provided", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, {
      objective: "Simple task",
      parent: "root",
    });

    const messages = getUnprocessedMessages(db, child.id);
    expect(messages).toHaveLength(0);
    db.close();
  });

  it("parent-child relationship is correct via getChildren", () => {
    const db = createTestDb();
    seedRoot(db);

    const child1 = createObjective(db, { objective: "Child 1", parent: "root" });
    const child2 = createObjective(db, { objective: "Child 2", parent: "root" });

    const children = getChildren(db, "root");
    const childIds = children.map((c) => c.id);
    expect(childIds).toContain(child1.id);
    expect(childIds).toContain(child2.id);
    expect(children).toHaveLength(2);
    db.close();
  });
});

describe("aria tell", () => {
  it("message lands in target objective inbox", () => {
    const db = createTestDb();
    seedRoot(db);

    const target = createObjective(db, { objective: "Target obj", parent: "root" });

    insertMessage(db, {
      objective_id: target.id,
      message: "Hey, check this out",
      sender: "root",
    });

    const messages = getUnprocessedMessages(db, target.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toBe("Hey, check this out");
    db.close();
  });

  it("sender is set to calling objective ID", () => {
    const db = createTestDb();
    seedRoot(db);

    const sender = createObjective(db, { objective: "Sender obj", parent: "root" });
    const target = createObjective(db, { objective: "Target obj", parent: "root" });

    insertMessage(db, {
      objective_id: target.id,
      message: "Cross-talk message",
      sender: sender.id,
    });

    const messages = getUnprocessedMessages(db, target.id);
    expect(messages[0].sender).toBe(sender.id);
    db.close();
  });

  it("message has turn_id = NULL (unprocessed)", () => {
    const db = createTestDb();
    seedRoot(db);

    const target = createObjective(db, { objective: "Target", parent: "root" });

    insertMessage(db, {
      objective_id: target.id,
      message: "Unprocessed message",
      sender: "root",
    });

    const messages = getUnprocessedMessages(db, target.id);
    expect(messages[0].turn_id).toBeNull();
    db.close();
  });

  it("can message any objective, not just parent/children", () => {
    const db = createTestDb();
    seedRoot(db);

    const objA = createObjective(db, { objective: "Obj A", parent: "root" });
    const objB = createObjective(db, { objective: "Obj B", parent: "root" });
    const childOfA = createObjective(db, { objective: "Child of A", parent: objA.id });

    // B messages child of A (no direct relationship)
    insertMessage(db, {
      objective_id: childOfA.id,
      message: "Message from unrelated objective",
      sender: objB.id,
    });

    const messages = getUnprocessedMessages(db, childOfA.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].sender).toBe(objB.id);
    db.close();
  });
});

describe("aria succeed", () => {
  it("status changes to resolved", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, { objective: "Do the thing", parent: "root" });
    updateStatus(db, child.id, "resolved");

    const updated = getObjective(db, child.id)!;
    expect(updated.status).toBe("resolved");
    db.close();
  });

  it("resolved_at is set when status becomes resolved", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, { objective: "Do the thing", parent: "root" });
    updateStatus(db, child.id, "resolved");

    const updated = getObjective(db, child.id)!;
    expect(updated.resolved_at).toBeTruthy();
    expect(typeof updated.resolved_at).toBe("number");
    db.close();
  });

  it("resolution summary is stored", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, { objective: "Deploy API", parent: "root" });
    updateStatus(db, child.id, "resolved");
    setResolutionSummary(db, child.id, "Deployed v2.1 to production successfully");

    const updated = getObjective(db, child.id)!;
    expect(updated.resolution_summary).toBe("Deployed v2.1 to production successfully");
    db.close();
  });

  it("reply message is sent to parent on succeed", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, { objective: "Fix bug", parent: "root" });
    const summary = "Fixed the null pointer in auth flow";

    // Simulate what cmdSucceed does
    updateStatus(db, child.id, "resolved");
    setResolutionSummary(db, child.id, summary);

    insertMessage(db, {
      objective_id: child.id,
      message: summary,
      sender: "system",
      type: "reply",
    });

    const resultMsg = `[resolved] ${child.objective}: ${summary}`;
    insertMessage(db, {
      objective_id: "root",
      message: resultMsg,
      sender: child.id,
      type: "reply",
    });

    // Parent (root) should have the notification
    const parentMessages = getConversation(db, "root");
    const notification = parentMessages.find((m) => m.sender === child.id);
    expect(notification).toBeTruthy();
    expect(notification!.message).toContain("[resolved]");
    expect(notification!.message).toContain(summary);
    db.close();
  });

  it("cascadeAbandon abandons active children on succeed", () => {
    const db = createTestDb();
    seedRoot(db);

    const parent = createObjective(db, { objective: "Parent task", parent: "root" });
    const activeChild = createObjective(db, { objective: "Active child", parent: parent.id });
    const idleChild = createObjective(db, { objective: "Idle child", parent: parent.id });

    // activeChild is idle (default), idleChild is also idle
    // Both should get abandoned
    updateStatus(db, parent.id, "resolved");
    cascadeAbandon(db, parent.id);

    const updatedActive = getObjective(db, activeChild.id)!;
    const updatedIdle = getObjective(db, idleChild.id)!;
    expect(updatedActive.status).toBe("abandoned");
    expect(updatedIdle.status).toBe("abandoned");
    db.close();
  });

  it("cascadeAbandon does not touch already-resolved children", () => {
    const db = createTestDb();
    seedRoot(db);

    const parent = createObjective(db, { objective: "Parent task", parent: "root" });
    const resolvedChild = createObjective(db, { objective: "Done child", parent: parent.id });
    updateStatus(db, resolvedChild.id, "resolved");

    cascadeAbandon(db, parent.id);

    const updated = getObjective(db, resolvedChild.id)!;
    expect(updated.status).toBe("resolved");
    db.close();
  });
});

describe("aria fail", () => {
  it("status changes to failed", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, { objective: "Flaky task", parent: "root" });
    updateStatus(db, child.id, "failed");

    const updated = getObjective(db, child.id)!;
    expect(updated.status).toBe("failed");
    db.close();
  });

  it("notifies parent on fail", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, { objective: "Broken task", parent: "root" });
    const reason = "Dependency service is down";

    // Simulate cmdFail behavior
    updateStatus(db, child.id, "failed");

    insertMessage(db, {
      objective_id: "root",
      message: `[failed] ${child.objective}: ${reason}`,
      sender: child.id,
      type: "reply",
    });

    const parentMessages = getConversation(db, "root");
    const notification = parentMessages.find((m) => m.sender === child.id);
    expect(notification).toBeTruthy();
    expect(notification!.message).toContain("[failed]");
    expect(notification!.message).toContain(reason);
    db.close();
  });
});

describe("aria reject", () => {
  it("sets status back to idle", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, { objective: "Needs revision", parent: "root" });
    // Simulate child was thinking/needs-input, then gets rejected
    updateStatus(db, child.id, "thinking");

    // cmdReject behavior
    updateStatus(db, child.id, "idle");
    clearWaitingOn(db, child.id);

    const updated = getObjective(db, child.id)!;
    expect(updated.status).toBe("idle");
    expect(updated.waiting_on).toBeNull();
    db.close();
  });

  it("clears waiting_on field", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, { objective: "Blocked task", parent: "root" });
    setWaitingOn(db, child.id, "waiting for API key");

    // Reject clears the waiting_on
    updateStatus(db, child.id, "idle");
    clearWaitingOn(db, child.id);

    const updated = getObjective(db, child.id)!;
    expect(updated.waiting_on).toBeNull();
    db.close();
  });

  it("sends feedback message to the rejected objective", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, { objective: "Draft email", parent: "root" });
    const feedback = "Tone is too formal, make it more casual";
    const callerId = "root";

    // cmdReject behavior
    updateStatus(db, child.id, "idle");
    clearWaitingOn(db, child.id);
    insertMessage(db, {
      objective_id: child.id,
      message: feedback,
      sender: callerId,
      type: "message",
    });

    const messages = getUnprocessedMessages(db, child.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toBe(feedback);
    expect(messages[0].sender).toBe(callerId);
    db.close();
  });
});

describe("aria wait", () => {
  it("sets waiting_on field", () => {
    const db = createTestDb();
    seedRoot(db);

    const obj = createObjective(db, { objective: "Need external input", parent: "root" });

    setWaitingOn(db, obj.id, "Waiting for Max's approval");
    // cmdWait also sets status to idle (stays idle)
    updateStatus(db, obj.id, "idle");

    const updated = getObjective(db, obj.id)!;
    expect(updated.waiting_on).toBe("Waiting for Max's approval");
    expect(updated.status).toBe("idle");
    db.close();
  });

  it("updates FTS index for waiting_on", () => {
    const db = createTestDb();
    seedRoot(db);

    const obj = createObjective(db, { objective: "Blocked on review", parent: "root" });

    setWaitingOn(db, obj.id, "code review from team lead");

    // Search should find it via FTS
    const results = searchObjectives(db, "code review");
    expect(results.some((r) => r.id === obj.id)).toBe(true);
    db.close();
  });
});

describe("aria schedule", () => {
  it("creates a row in the schedules table", () => {
    const db = createTestDb();
    seedRoot(db);

    const obj = createObjective(db, { objective: "Recurring check", parent: "root" });
    const nextAt = Math.floor(Date.now() / 1000) + 3600;

    const schedule = createSchedule(db, obj.id, "Check status", "1h", nextAt);

    expect(schedule.id).toBeTruthy();
    expect(schedule.objective_id).toBe(obj.id);
    expect(schedule.message).toBe("Check status");
    db.close();
  });

  it("next_at is set correctly", () => {
    const db = createTestDb();
    seedRoot(db);

    const obj = createObjective(db, { objective: "Timed task", parent: "root" });
    const expectedNextAt = Math.floor(Date.now() / 1000) + 600;

    const schedule = createSchedule(db, obj.id, "Ping", "10m", expectedNextAt);

    expect(schedule.next_at).toBe(expectedNextAt);
    db.close();
  });

  it("recurring schedules have the right interval", () => {
    const db = createTestDb();
    seedRoot(db);

    const obj = createObjective(db, { objective: "Daily check", parent: "root" });
    const nextAt = Math.floor(Date.now() / 1000) + 86400;

    const schedule = createSchedule(db, obj.id, "Daily report", "1d", nextAt);

    expect(schedule.interval).toBe("1d");
    db.close();
  });

  it("one-shot schedules have null interval", () => {
    const db = createTestDb();
    seedRoot(db);

    const obj = createObjective(db, { objective: "One time thing", parent: "root" });
    const nextAt = Math.floor(Date.now() / 1000) + 60;

    const schedule = createSchedule(db, obj.id, "Do it once", null, nextAt);

    expect(schedule.interval).toBeNull();
    db.close();
  });

  it("listSchedules returns schedules for a specific objective", () => {
    const db = createTestDb();
    seedRoot(db);

    const obj1 = createObjective(db, { objective: "Obj 1", parent: "root" });
    const obj2 = createObjective(db, { objective: "Obj 2", parent: "root" });
    const nextAt = Math.floor(Date.now() / 1000) + 600;

    createSchedule(db, obj1.id, "Msg for obj1", "1h", nextAt);
    createSchedule(db, obj2.id, "Msg for obj2", "1h", nextAt);

    const schedules = listSchedules(db, obj1.id);
    expect(schedules).toHaveLength(1);
    expect(schedules[0].objective_id).toBe(obj1.id);
    db.close();
  });
});

describe("aria find", () => {
  it("returns objectives matching the search query via FTS", () => {
    const db = createTestDb();
    seedRoot(db);

    createObjective(db, { objective: "Deploy production API server", parent: "root" });
    createObjective(db, { objective: "Write unit tests for auth", parent: "root" });
    createObjective(db, { objective: "Fix database migration script", parent: "root" });

    const results = searchObjectives(db, "deploy production");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.objective.includes("Deploy production"))).toBe(true);
    db.close();
  });

  it("returns empty array for no matches", () => {
    const db = createTestDb();
    seedRoot(db);

    createObjective(db, { objective: "Write docs", parent: "root" });

    const results = searchObjectives(db, "xyznonexistent");
    expect(results).toHaveLength(0);
    db.close();
  });
});

describe("aria show", () => {
  it("returns the correct objective with all fields", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, {
      objective: "Detailed task",
      description: "A very detailed description",
      parent: "root",
      model: "opus",
    });

    const fetched = getObjective(db, child.id);
    expect(fetched).toBeTruthy();
    expect(fetched!.id).toBe(child.id);
    expect(fetched!.objective).toBe("Detailed task");
    expect(fetched!.description).toBe("A very detailed description");
    expect(fetched!.parent).toBe("root");
    expect(fetched!.model).toBe("opus");
    expect(fetched!.status).toBe("idle");
    expect(fetched!.created_at).toBeTruthy();
    expect(fetched!.updated_at).toBeTruthy();
    db.close();
  });

  it("returns undefined for nonexistent objective", () => {
    const db = createTestDb();
    seedRoot(db);

    const fetched = getObjective(db, "nonexistent-id");
    expect(fetched).toBeUndefined();
    db.close();
  });
});

describe("aria tree", () => {
  it("returns objectives with parent-child relationships", () => {
    const db = createTestDb();
    seedRoot(db);

    const child = createObjective(db, { objective: "Child task", parent: "root" });
    const grandchild = createObjective(db, { objective: "Grandchild task", parent: child.id });

    const tree = getTree(db);

    // root, child, grandchild should all be in tree (all are idle = not resolved/abandoned)
    const ids = tree.map((o) => o.id);
    expect(ids).toContain("root");
    expect(ids).toContain(child.id);
    expect(ids).toContain(grandchild.id);
    db.close();
  });

  it("excludes resolved and abandoned objectives", () => {
    const db = createTestDb();
    seedRoot(db);

    const active = createObjective(db, { objective: "Active task", parent: "root" });
    const resolved = createObjective(db, { objective: "Done task", parent: "root" });
    const abandoned = createObjective(db, { objective: "Abandoned task", parent: "root" });

    updateStatus(db, resolved.id, "resolved");
    updateStatus(db, abandoned.id, "abandoned");

    const tree = getTree(db);
    const ids = tree.map((o) => o.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(resolved.id);
    expect(ids).not.toContain(abandoned.id);
    db.close();
  });
});

describe("aria inbox", () => {
  it("returns messages for the specified objective", () => {
    const db = createTestDb();
    seedRoot(db);

    const obj = createObjective(db, { objective: "Inbox target", parent: "root" });

    insertMessage(db, { objective_id: obj.id, message: "First message", sender: "max" });
    insertMessage(db, { objective_id: obj.id, message: "Second message", sender: "root" });

    const messages = getConversation(db, obj.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].message).toBe("First message");
    expect(messages[1].message).toBe("Second message");
    db.close();
  });

  it("returns empty array for objective with no messages", () => {
    const db = createTestDb();
    seedRoot(db);

    const obj = createObjective(db, { objective: "Silent obj", parent: "root" });

    const messages = getConversation(db, obj.id);
    expect(messages).toHaveLength(0);
    db.close();
  });

  it("messages are ordered by created_at", () => {
    const db = createTestDb();
    seedRoot(db);

    const obj = createObjective(db, { objective: "Ordered inbox", parent: "root" });

    insertMessage(db, { objective_id: obj.id, message: "Alpha", sender: "max" });
    insertMessage(db, { objective_id: obj.id, message: "Beta", sender: "max" });
    insertMessage(db, { objective_id: obj.id, message: "Gamma", sender: "root" });

    const messages = getConversation(db, obj.id);
    expect(messages).toHaveLength(3);
    // created_at should be monotonically increasing
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].created_at).toBeGreaterThanOrEqual(messages[i - 1].created_at);
    }
    db.close();
  });
});

describe("aria notify", () => {
  it("inserts a signal message to root objective", () => {
    const db = createTestDb();
    seedRoot(db);

    const senderId = "some-objective-id";

    // Simulate cmdNotify behavior: inserts message to root
    insertMessage(db, {
      objective_id: "root",
      message: "[notify] Something important happened",
      sender: senderId,
      type: "signal",
    });

    const messages = getConversation(db, "root");
    const signal = messages.find((m) => m.type === "signal");
    expect(signal).toBeTruthy();
    expect(signal!.message).toContain("[notify]");
    expect(signal!.sender).toBe(senderId);
    db.close();
  });
});
