import Database from "better-sqlite3";

export function initMemoryTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      type TEXT NOT NULL,
      source TEXT,
      embedding BLOB,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memory_created ON memories(created_at);
  `);

  // FTS5 virtual tables don't support IF NOT EXISTS, so check manually
  const ftsExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'"
    )
    .get();
  if (!ftsExists) {
    db.exec(
      "CREATE VIRTUAL TABLE memories_fts USING fts5(content, type)"
    );
  }
}
