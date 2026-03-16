#!/usr/bin/env python3
"""Create the memories table and FTS5 index."""

import argparse
import sqlite3
from pathlib import Path


def create_tables(db_path: str):
    conn = sqlite3.connect(db_path, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            type TEXT,
            source TEXT,
            embedding BLOB,
            created_at INTEGER NOT NULL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at)")

    # Check if FTS5 table exists (can't use IF NOT EXISTS with virtual tables)
    existing = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'"
    ).fetchone()
    if not existing:
        conn.execute("CREATE VIRTUAL TABLE memories_fts USING fts5(content, type)")

    conn.commit()
    conn.close()
    print(f"Tables created in {db_path}")


def main():
    parser = argparse.ArgumentParser(description="Create memories tables")
    parser.add_argument("--db", default=str(Path.home() / "Documents" / "aria-memories.db"),
                        help="Path to SQLite database")
    args = parser.parse_args()
    create_tables(args.db)


if __name__ == "__main__":
    main()
