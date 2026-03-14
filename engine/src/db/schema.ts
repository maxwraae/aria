import Database from "better-sqlite3";
import fs from "fs";
import { now } from "./utils.js";
import { getLocalDbPath, getDataDir } from "./node.js";

export const DB_DIR = getDataDir();
export const DB_PATH = getLocalDbPath();

export function initDb(): Database.Database {
  fs.mkdirSync(DB_DIR, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");

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

  // Migration: add resolution_summary column if missing
  const cols = db.pragma("table_info(objectives)") as { name: string }[];
  if (!cols.some((c) => c.name === "resolution_summary")) {
    db.exec("ALTER TABLE objectives ADD COLUMN resolution_summary TEXT");
  }

  // Migration: add machine column if missing
  if (!cols.some((c) => c.name === "machine")) {
    db.exec("ALTER TABLE objectives ADD COLUMN machine TEXT");
  }

  // FTS5 virtual tables don't support IF NOT EXISTS, so check manually
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
  `);

  // Migration: add processed_by column to inbox if missing
  const inboxCols = db.prepare(`PRAGMA table_info(inbox)`).all() as Array<{name: string}>;
  if (!inboxCols.some(c => c.name === 'processed_by')) {
    db.exec(`ALTER TABLE inbox ADD COLUMN processed_by TEXT`);
  }

  // Seed root objective if it doesn't exist
  const root = db
    .prepare("SELECT id FROM objectives WHERE id = 'root'")
    .get();
  if (!root) {
    const ts = now();
    db.prepare(
      `INSERT INTO objectives (id, objective, parent, status, created_at, updated_at)
       VALUES ('root', 'Help Max thrive and succeed', NULL, 'idle', ?, ?)`
    ).run(ts, ts);
    db.prepare(
      `INSERT INTO objectives_fts(rowid, objective, waiting_on, description, resolution_summary)
       SELECT rowid, objective, waiting_on, description, resolution_summary FROM objectives WHERE id = 'root'`
    ).run();
    console.log("Seeded root objective");
  }

  return db;
}

// Run directly
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("schema.ts") ||
    process.argv[1].endsWith("schema.js"));
if (isMain) {
  const db = initDb();
  db.close();
}
