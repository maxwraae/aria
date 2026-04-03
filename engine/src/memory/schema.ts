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

  // WAL mode for safe concurrent reads/writes
  db.pragma("journal_mode = WAL");

  // Co-occurrence graph for contextuality
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_edges (
      memory_a TEXT NOT NULL,
      memory_b TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      last_turn INTEGER,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (memory_a, memory_b),
      CHECK (memory_a < memory_b)
    );

    CREATE INDEX IF NOT EXISTS idx_edges_a ON memory_edges(memory_a);
    CREATE INDEX IF NOT EXISTS idx_edges_b ON memory_edges(memory_b);
  `);

  // node_weight: prep for V2 usage attribution — not read/written in V1
  const hasNodeWeight = db
    .prepare("SELECT COUNT(*) as c FROM pragma_table_info('memories') WHERE name = 'node_weight'")
    .get() as { c: number };
  if (hasNodeWeight.c === 0) {
    db.exec("ALTER TABLE memories ADD COLUMN node_weight INTEGER DEFAULT 0");
  }
}
