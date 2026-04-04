import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { now } from "./utils.js";
import { getLocalDbPath, getDataDir } from "./node.js";
import { initMemoryTables } from "../memory/schema.js";

export const DB_DIR = getDataDir();
export const DB_PATH = getLocalDbPath();

/**
 * Open a database connection. No migrations, no schema changes.
 * Safe to call from any code path — reads or writes.
 *
 * Pass readonly=true for read-only commands (aria tree, aria active, etc.)
 * so they don't conflict with the engine's write lock under DELETE journal mode.
 */
export function openDb(dbPath?: string, readonly = false): Database.Database {
  const resolvedPath = dbPath ?? DB_PATH;
  if (!readonly) {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  const db = new Database(resolvedPath, readonly ? { readonly: true } : undefined);
  db.pragma("foreign_keys = ON");
  if (!readonly) {
    db.pragma("busy_timeout = 5000");
    // Enforce DELETE journal mode on every writable connection.
    // iCloud can sync in an older WAL-mode version of the DB between restarts,
    // which strands the engine with a 0-byte WAL and SQLITE_IOERR_SHORT_READ errors.
    // Setting DELETE here is idempotent — no-op if already in DELETE mode.
    db.pragma("journal_mode = DELETE");
  }

  return db;
}

/** Open a read-only connection. For CLI read commands. */
export function openDbReadonly(dbPath?: string): Database.Database {
  return openDb(dbPath, true);
}

/**
 * Retry a database operation on transient I/O errors (SQLITE_IOERR_SHORT_READ).
 * These happen under DELETE journal mode when reading while the engine is mid-write.
 */
export function withRetry<T>(fn: () => T, maxRetries = 3, delayMs = 100): T {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return fn();
    } catch (err: any) {
      if (i < maxRetries && err?.code?.startsWith?.('SQLITE_IOERR')) {
        const waitMs = delayMs * (i + 1);
        const start = Date.now();
        while (Date.now() - start < waitMs) {} // sync sleep
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

/**
 * Run schema migrations on an open database handle.
 * Called once at engine startup (`aria up`). Idempotent — safe to re-run.
 */
export function migrateDb(db: Database.Database): void {
  db.pragma("journal_mode = DELETE");

  db.exec(`
    CREATE TABLE IF NOT EXISTS objectives (
      id TEXT PRIMARY KEY,
      objective TEXT NOT NULL,
      description TEXT,
      parent TEXT,
      status TEXT DEFAULT 'idle',
      waiting_on TEXT,
      resolution_summary TEXT,
      important BOOLEAN DEFAULT FALSE,
      urgent BOOLEAN DEFAULT FALSE,
      model TEXT DEFAULT 'sonnet',
      cwd TEXT,
      fail_count INTEGER DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER,
      resolved_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_status ON objectives(status);
    CREATE INDEX IF NOT EXISTS idx_parent ON objectives(parent);
  `);

  // Column migrations — idempotent checks protect against re-runs
  const cols = db.pragma("table_info(objectives)") as { name: string }[];

  if (!cols.some((c) => c.name === "resolution_summary")) {
    db.exec("ALTER TABLE objectives ADD COLUMN resolution_summary TEXT");
  }

  if (!cols.some((c) => c.name === "machine")) {
    db.exec("ALTER TABLE objectives ADD COLUMN machine TEXT");
  }

  if (!cols.some((c) => c.name === "last_error")) {
    db.exec("ALTER TABLE objectives ADD COLUMN last_error TEXT");
  }

  if (!cols.some((c) => c.name === "depth")) {
    db.exec("ALTER TABLE objectives ADD COLUMN depth INTEGER DEFAULT 0");
    db.exec(`
      WITH RECURSIVE tree AS (
        SELECT id, 0 AS d FROM objectives WHERE parent IS NULL
        UNION ALL
        SELECT o.id, t.d + 1 FROM objectives o JOIN tree t ON o.parent = t.id
      )
      UPDATE objectives SET depth = (SELECT d FROM tree WHERE tree.id = objectives.id)
    `);
  }

  if (!cols.some((c) => c.name === "work_path")) {
    db.exec("ALTER TABLE objectives ADD COLUMN work_path TEXT");
  }

  // Backfill work files for objectives without one
  const needsWorkPath = db.prepare("SELECT id FROM objectives WHERE work_path IS NULL").all() as { id: string }[];
  if (needsWorkPath.length > 0) {
    const workDir = path.join(DB_DIR, "work");
    fs.mkdirSync(workDir, { recursive: true });
    const updateStmt = db.prepare("UPDATE objectives SET work_path = ? WHERE id = ?");
    const backfill = db.transaction(() => {
      for (const { id } of needsWorkPath) {
        const workPath = path.join(workDir, `${id}.md`);
        if (!fs.existsSync(workPath)) {
          fs.writeFileSync(workPath, "", "utf-8");
        }
        updateStmt.run(workPath, id);
      }
    });
    backfill();
  }

  // FTS5 virtual tables don't support IF NOT EXISTS
  const ftsExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='objectives_fts'"
    )
    .get();
  if (!ftsExists) {
    db.exec(
      "CREATE VIRTUAL TABLE objectives_fts USING fts5(objective, waiting_on, description, resolution_summary)"
    );
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox (
      id TEXT PRIMARY KEY,
      objective_id TEXT NOT NULL,
      message TEXT NOT NULL,
      sender TEXT NOT NULL,
      type TEXT DEFAULT 'message',
      turn_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (objective_id) REFERENCES objectives(id)
    );

    CREATE INDEX IF NOT EXISTS idx_unprocessed ON inbox(objective_id) WHERE turn_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_sender ON inbox(sender, created_at);
    CREATE INDEX IF NOT EXISTS idx_recent ON inbox(created_at);

    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      objective_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      user_message TEXT,
      session_id TEXT,
      created_at INTEGER,
      injected_memory_ids TEXT,
      FOREIGN KEY (objective_id) REFERENCES objectives(id)
    );

    CREATE INDEX IF NOT EXISTS idx_objective_turns ON turns(objective_id, turn_number);

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      objective_id TEXT NOT NULL,
      message TEXT NOT NULL,
      interval TEXT,
      next_at INTEGER NOT NULL,
      created_at INTEGER,
      FOREIGN KEY (objective_id) REFERENCES objectives(id)
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      keys_p256dh TEXT NOT NULL,
      keys_auth TEXT NOT NULL,
      label TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  // Inbox column migrations
  const inboxCols = db.prepare(`PRAGMA table_info(inbox)`).all() as Array<{name: string}>;
  if (!inboxCols.some(c => c.name === 'processed_by')) {
    db.exec(`ALTER TABLE inbox ADD COLUMN processed_by TEXT`);
  }
  if (!inboxCols.some(c => c.name === 'cascade_id')) {
    db.exec(`ALTER TABLE inbox ADD COLUMN cascade_id TEXT`);
  }

  // Turns column migrations
  const turnCols = db.prepare(`PRAGMA table_info(turns)`).all() as Array<{name: string}>;
  if (!turnCols.some(c => c.name === 'injected_memory_ids')) {
    db.exec(`ALTER TABLE turns ADD COLUMN injected_memory_ids TEXT`);
  }
  if (!turnCols.some(c => c.name === 'cascade_id')) {
    db.exec(`ALTER TABLE turns ADD COLUMN cascade_id TEXT`);
  }

  // Seed root objective
  const root = db
    .prepare("SELECT id FROM objectives WHERE id = 'root'")
    .get();
  if (!root) {
    const ts = now();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO objectives (id, objective, parent, status, created_at, updated_at)
         VALUES ('root', 'Help Max thrive and succeed', NULL, 'idle', ?, ?)`
      ).run(ts, ts);
      db.prepare(
        `INSERT INTO objectives_fts(rowid, objective, waiting_on, description, resolution_summary)
         SELECT rowid, objective, waiting_on, description, resolution_summary FROM objectives WHERE id = 'root'`
      ).run();
    })();
    console.log("Seeded root objective");
  }

  // Seed quick objective
  const quick = db
    .prepare("SELECT id FROM objectives WHERE id = 'quick'")
    .get();
  if (!quick) {
    const ts = now();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO objectives (id, objective, description, parent, status, created_at, updated_at)
         VALUES ('quick', 'Quick tasks', 'Catch-all for quick tasks from the search bar. This objective is permanent and protected.', 'root', 'idle', ?, ?)`
      ).run(ts, ts);
      db.prepare(
        `INSERT INTO objectives_fts(rowid, objective, waiting_on, description, resolution_summary)
         SELECT rowid, objective, waiting_on, description, resolution_summary FROM objectives WHERE id = 'quick'`
      ).run();
    })();
    console.log("Seeded quick objective");
  }

  // Initialize memory tables
  initMemoryTables(db);
}

// Run directly
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("schema.ts") ||
    process.argv[1].endsWith("schema.js"));
if (isMain) {
  const db = openDb();
  migrateDb(db);
  db.close();
}
