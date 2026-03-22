import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

// ── helpers ────────────────────────────────────────────────────────────────

const tmpFiles: string[] = [];

function tmpDbPath(): string {
  const p = path.join(os.tmpdir(), `aria-test-${randomUUID()}.db`);
  tmpFiles.push(p);
  return p;
}

/**
 * Create a file-backed DB with the same schema as schema.ts,
 * minus seed data and filesystem side-effects.
 */
function createTestDb(filePath: string): Database.Database {
  const db = new Database(filePath);
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

/**
 * Replicate the sync logic from syncFromPeer (queries.ts) by manually
 * attaching the peer DB file. We can't call syncFromPeer directly because
 * it relies on getPeerDbPath() which is hardcoded to machine hostnames.
 */
function syncFromPeerDirect(
  localDb: Database.Database,
  peerDbPath: string
): void {
  localDb.exec(`ATTACH DATABASE '${peerDbPath}' AS peer`);
  try {
    // Copy new objectives from peer
    localDb.exec(`
      INSERT OR IGNORE INTO objectives (id, objective, description, parent, status, waiting_on, resolution_summary, important, urgent, model, cwd, machine, fail_count, created_at, updated_at)
      SELECT id, objective, description, parent, status, waiting_on, resolution_summary, important, urgent, model, cwd, machine, fail_count, created_at, updated_at
      FROM peer.objectives
    `);

    // Update local objectives with newer peer data
    localDb.exec(`
      UPDATE objectives SET
        status = peer.status,
        waiting_on = peer.waiting_on,
        resolution_summary = peer.resolution_summary,
        important = peer.important,
        urgent = peer.urgent,
        fail_count = peer.fail_count,
        updated_at = peer.updated_at
      FROM peer.objectives AS peer
      WHERE objectives.id = peer.id
        AND peer.updated_at > objectives.updated_at
    `);

    // Copy new inbox messages from peer
    localDb.exec(`
      INSERT OR IGNORE INTO inbox (id, objective_id, sender, type, message, turn_id, processed_by, created_at)
      SELECT id, objective_id, sender, type, message, turn_id, processed_by, created_at
      FROM peer.inbox
    `);

    // Copy new turns from peer
    localDb.exec(`
      INSERT OR IGNORE INTO turns (id, objective_id, turn_number, user_message, session_id, created_at)
      SELECT id, objective_id, turn_number, user_message, session_id, created_at
      FROM peer.turns
    `);

    // Copy new schedules from peer
    localDb.exec(`
      INSERT OR IGNORE INTO schedules (id, objective_id, message, interval, next_at, created_at)
      SELECT id, objective_id, message, interval, next_at, created_at
      FROM peer.schedules
    `);
  } finally {
    try {
      localDb.exec("DETACH DATABASE peer");
    } catch {}
  }
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

// ── cleanup ────────────────────────────────────────────────────────────────

afterEach(() => {
  for (const f of tmpFiles) {
    try {
      fs.unlinkSync(f);
    } catch {}
    // Also clean up WAL/SHM files that SQLite may leave behind
    try {
      fs.unlinkSync(f + "-wal");
    } catch {}
    try {
      fs.unlinkSync(f + "-shm");
    } catch {}
  }
  tmpFiles.length = 0;
});

// ── tests ──────────────────────────────────────────────────────────────────

describe("syncFromPeer", () => {
  it("syncs a new objective from peer to local", () => {
    const localPath = tmpDbPath();
    const peerPath = tmpDbPath();
    const localDb = createTestDb(localPath);
    const peerDb = createTestDb(peerPath);

    const objId = randomUUID();
    const ts = now();

    // Insert objective into peer only
    peerDb
      .prepare(
        `INSERT INTO objectives (id, objective, description, parent, status, model, fail_count, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'idle', 'sonnet', 0, ?, ?)`
      )
      .run(objId, "peer objective", "peer desc", ts, ts);

    // Verify local doesn't have it
    expect(
      localDb.prepare("SELECT * FROM objectives WHERE id = ?").get(objId)
    ).toBeUndefined();

    // Sync
    syncFromPeerDirect(localDb, peerPath);

    // Verify local now has the objective
    const synced = localDb
      .prepare("SELECT * FROM objectives WHERE id = ?")
      .get(objId) as any;
    expect(synced).toBeDefined();
    expect(synced.objective).toBe("peer objective");
    expect(synced.description).toBe("peer desc");

    peerDb.close();
    localDb.close();
  });

  it("syncs a new inbox message from peer to local", () => {
    const localPath = tmpDbPath();
    const peerPath = tmpDbPath();
    const localDb = createTestDb(localPath);
    const peerDb = createTestDb(peerPath);

    const objId = randomUUID();
    const msgId = randomUUID();
    const ts = now();

    // Create the objective in both DBs (message has a FK to objective)
    const insertObj = `INSERT INTO objectives (id, objective, parent, status, model, fail_count, created_at, updated_at)
                       VALUES (?, 'shared objective', NULL, 'idle', 'sonnet', 0, ?, ?)`;
    localDb.prepare(insertObj).run(objId, ts, ts);
    peerDb.prepare(insertObj).run(objId, ts, ts);

    // Add a message only in the peer
    peerDb
      .prepare(
        `INSERT INTO inbox (id, objective_id, message, sender, type, created_at)
         VALUES (?, ?, ?, 'max', 'message', ?)`
      )
      .run(msgId, objId, "hello from peer", ts);

    // Verify local doesn't have the message
    expect(
      localDb.prepare("SELECT * FROM inbox WHERE id = ?").get(msgId)
    ).toBeUndefined();

    // Sync
    syncFromPeerDirect(localDb, peerPath);

    // Verify local now has the message
    const synced = localDb
      .prepare("SELECT * FROM inbox WHERE id = ?")
      .get(msgId) as any;
    expect(synced).toBeDefined();
    expect(synced.message).toBe("hello from peer");
    expect(synced.sender).toBe("max");
    expect(synced.objective_id).toBe(objId);

    peerDb.close();
    localDb.close();
  });

  it("updates a local objective when peer has newer data", () => {
    const localPath = tmpDbPath();
    const peerPath = tmpDbPath();
    const localDb = createTestDb(localPath);
    const peerDb = createTestDb(peerPath);

    const objId = randomUUID();
    const ts = now();

    // Create same objective in both DBs
    const insertObj = `INSERT INTO objectives (id, objective, description, parent, status, model, fail_count, created_at, updated_at)
                       VALUES (?, 'the objective', 'original desc', NULL, 'idle', 'sonnet', 0, ?, ?)`;
    localDb.prepare(insertObj).run(objId, ts, ts);
    peerDb.prepare(insertObj).run(objId, ts, ts);

    // Update the peer's copy with newer data
    const laterTs = ts + 60;
    peerDb
      .prepare(
        `UPDATE objectives SET description = 'updated by peer', status = 'needs-input', updated_at = ? WHERE id = ?`
      )
      .run(laterTs, objId);

    // Sync
    syncFromPeerDirect(localDb, peerPath);

    // Verify local was updated (sync updates status, updated_at — description is NOT in the UPDATE SET)
    const synced = localDb
      .prepare("SELECT * FROM objectives WHERE id = ?")
      .get(objId) as any;
    expect(synced.status).toBe("needs-input");
    expect(synced.updated_at).toBe(laterTs);

    peerDb.close();
    localDb.close();
  });

  it("does NOT overwrite local data when local is newer than peer", () => {
    const localPath = tmpDbPath();
    const peerPath = tmpDbPath();
    const localDb = createTestDb(localPath);
    const peerDb = createTestDb(peerPath);

    const objId = randomUUID();
    const ts = now();

    // Create same objective in both DBs
    const insertObj = `INSERT INTO objectives (id, objective, description, parent, status, model, fail_count, created_at, updated_at)
                       VALUES (?, 'the objective', 'original', NULL, 'idle', 'sonnet', 0, ?, ?)`;
    localDb.prepare(insertObj).run(objId, ts, ts);
    peerDb.prepare(insertObj).run(objId, ts, ts);

    // Update LOCAL to be newer
    const localTs = ts + 120;
    localDb
      .prepare(
        `UPDATE objectives SET status = 'thinking', updated_at = ? WHERE id = ?`
      )
      .run(localTs, objId);

    // Update peer with an older timestamp (still newer than original, but older than local)
    const peerTs = ts + 60;
    peerDb
      .prepare(
        `UPDATE objectives SET status = 'needs-input', updated_at = ? WHERE id = ?`
      )
      .run(peerTs, objId);

    // Sync — peer is stale relative to local
    syncFromPeerDirect(localDb, peerPath);

    // Verify local kept its own version
    const synced = localDb
      .prepare("SELECT * FROM objectives WHERE id = ?")
      .get(objId) as any;
    expect(synced.status).toBe("thinking");
    expect(synced.updated_at).toBe(localTs);

    peerDb.close();
    localDb.close();
  });
});
