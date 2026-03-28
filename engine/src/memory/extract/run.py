#!/usr/bin/env python3
"""Aria memory extraction runner — batch processing with SQLite tracking."""

import argparse
import concurrent.futures
import glob
import json
import os
import signal
import sqlite3
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

from pipeline import load_prompt, chunk_conversation, extract_chunk, insert_memories, RateLimitError
from parse_session import parse_session

SCRIPT_DIR = Path(__file__).parent
BATCH_DB = SCRIPT_DIR / "batch.db"
MEMORIES_DB = Path.home() / "Library/Mobile Documents/com~apple~CloudDocs/Aria/data/memories.db"
SESSIONS_DIR = Path.home() / ".claude/projects/-Users-maxwraae"
ALL_TYPES = ["world", "max", "people", "friction", "biology"]


def get_db() -> sqlite3.Connection:
    db = sqlite3.connect(BATCH_DB)
    db.row_factory = sqlite3.Row
    return db


def setup_db(db: sqlite3.Connection) -> None:
    db.executescript("""
        CREATE TABLE IF NOT EXISTS sessions (
          filename TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'pending',
          prompt_type TEXT,
          chunks INTEGER,
          chunks_empty INTEGER,
          memories_extracted INTEGER DEFAULT 0,
          error_message TEXT,
          started_at TEXT,
          finished_at TEXT,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          cost_usd REAL DEFAULT 0.0
        );

        CREATE TABLE IF NOT EXISTS runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prompt_type TEXT NOT NULL,
          parallel INTEGER,
          started_at TEXT NOT NULL,
          stopped_at TEXT,
          stop_reason TEXT,
          sessions_processed INTEGER DEFAULT 0,
          sessions_skipped INTEGER DEFAULT 0,
          sessions_errored INTEGER DEFAULT 0,
          total_memories INTEGER DEFAULT 0,
          total_input_tokens INTEGER DEFAULT 0,
          total_output_tokens INTEGER DEFAULT 0,
          total_cost_usd REAL DEFAULT 0.0
        );

        CREATE TABLE IF NOT EXISTS session_types (
          filename TEXT NOT NULL,
          prompt_type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          chunks INTEGER,
          chunks_empty INTEGER,
          memories_extracted INTEGER DEFAULT 0,
          error_message TEXT,
          started_at TEXT,
          finished_at TEXT,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          cost_usd REAL DEFAULT 0.0,
          PRIMARY KEY (filename, prompt_type)
        );
    """)
    db.commit()
    migrate_to_session_types(db)


def migrate_batch_state(db: sqlite3.Connection) -> None:
    """One-time migration: import already-processed sessions from batch_state.json into batch.db."""
    batch_state_path = SCRIPT_DIR / "batch_state.json"
    migrated_path = SCRIPT_DIR / "batch_state.json.migrated"

    if migrated_path.exists():
        return  # Already migrated

    if not batch_state_path.exists():
        return  # Nothing to migrate

    with open(batch_state_path, "r") as f:
        data = json.load(f)

    processed = data.get("processed", {})
    done_count = 0
    skipped_count = 0

    for filename, info in processed.items():
        status = info.get("status")
        if status == "done":
            memories = info.get("memories", 0)
            chunks = info.get("chunks", 0)
            db.execute(
                """UPDATE sessions SET status='done', memories_extracted=?, chunks=?
                   WHERE filename=? AND status='pending'""",
                (memories, chunks, filename)
            )
            done_count += 1
        elif status == "skipped":
            db.execute(
                "UPDATE sessions SET status='skipped' WHERE filename=? AND status='pending'",
                (filename,)
            )
            skipped_count += 1

    total_migrated = done_count + skipped_count
    if total_migrated:
        print(f"Migrated {total_migrated} session(s) from batch_state.json "
              f"({done_count} done, {skipped_count} skipped).")

    batch_state_path.rename(migrated_path)


def migrate_to_session_types(db: sqlite3.Connection) -> None:
    """One-time migration: seed session_types from existing sessions data."""
    count = db.execute("SELECT COUNT(*) FROM session_types").fetchone()[0]
    if count > 0:
        return  # already migrated

    # Done sessions -> world/done (all existing extractions are world type)
    db.execute("""
        INSERT INTO session_types (filename, prompt_type, status, chunks, chunks_empty,
            memories_extracted, started_at, finished_at, input_tokens, output_tokens, cost_usd)
        SELECT filename, 'world', 'done', chunks, chunks_empty,
            memories_extracted, started_at, finished_at, input_tokens, output_tokens, cost_usd
        FROM sessions WHERE status = 'done'
    """)

    # Skipped sessions -> skipped for ALL types (too small for any extraction)
    for t in ALL_TYPES:
        db.execute("""
            INSERT OR IGNORE INTO session_types (filename, prompt_type, status)
            SELECT filename, ?, 'skipped'
            FROM sessions WHERE status = 'skipped'
        """, (t,))

    db.commit()
    migrated = db.execute("SELECT COUNT(*) FROM session_types").fetchone()[0]
    if migrated:
        print(f"Migrated {migrated} rows to session_types table.")


def populate_sessions(db: sqlite3.Connection) -> int:
    pattern = str(SESSIONS_DIR / "*.jsonl")
    files = glob.glob(pattern)
    added = 0
    for filepath in files:
        filename = Path(filepath).name
        cur = db.execute(
            "INSERT OR IGNORE INTO sessions (filename, status) VALUES (?, 'pending')",
            (filename,)
        )
        added += cur.rowcount
    migrate_batch_state(db)
    db.commit()
    if added:
        print(f"Added {added} new session(s) to tracking DB.")
    return added


def get_pending_sessions(db: sqlite3.Connection) -> list[tuple[str, list[str]]]:
    """Return [(filename, [missing_types])] ordered by file mtime newest-first.

    A type is 'missing' if there's no session_types row with status in ('done', 'skipped').
    Only includes sessions where sessions.status != 'skipped'.
    """
    rows = db.execute(
        "SELECT filename FROM sessions WHERE status != 'skipped'"
    ).fetchall()
    filenames = [r["filename"] for r in rows]

    filenames.sort(
        key=lambda f: os.path.getmtime(str(SESSIONS_DIR / f)) if (SESSIONS_DIR / f).exists() else 0,
        reverse=True,
    )

    result = []
    for fn in filenames:
        done = db.execute(
            "SELECT prompt_type FROM session_types WHERE filename = ? AND status IN ('done', 'skipped')",
            (fn,)
        ).fetchall()
        done_types = {r["prompt_type"] for r in done}
        missing = [t for t in ALL_TYPES if t not in done_types]
        if missing:
            result.append((fn, missing))

    return result


def process_one_type(filename: str, chunks: list, prompt_template: str, prompt_type: str, created_at: int) -> dict:
    """Extract memories of one type from pre-chunked session data. Returns result dict."""
    start_time = time.time()

    db = sqlite3.connect(BATCH_DB, timeout=30)
    db.row_factory = sqlite3.Row

    try:
        now = datetime.now(timezone.utc).isoformat()
        db.execute(
            "INSERT OR REPLACE INTO session_types (filename, prompt_type, status, started_at) VALUES (?, ?, 'running', ?)",
            (filename, prompt_type, now)
        )
        db.commit()

        all_memories = []
        chunks_empty = 0

        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            futures = [pool.submit(extract_chunk, (i, chunk_msgs, prompt_template)) for i, chunk_msgs in enumerate(chunks)]
            chunk_results = [f.result() for f in concurrent.futures.as_completed(futures)]

        chunk_results.sort(key=lambda x: x[0])

        total_input_tokens = 0
        total_output_tokens = 0
        total_cost_usd = 0.0

        for i, memories, stats in chunk_results:
            if not memories:
                chunks_empty += 1
            for mem in memories:
                if isinstance(mem, str):
                    all_memories.append({"content": mem.strip(), "type": prompt_type})
                elif isinstance(mem, dict):
                    if "type" not in mem:
                        mem["type"] = prompt_type
                    all_memories.append(mem)
                else:
                    all_memories.append({"content": str(mem).strip(), "type": prompt_type})
            total_input_tokens += (
                stats.get("input_tokens", 0)
                + stats.get("cache_creation_tokens", 0)
                + stats.get("cache_read_tokens", 0)
            )
            total_output_tokens += stats.get("output_tokens", 0)
            total_cost_usd += stats.get("cost_usd", 0.0)

        if all_memories:
            insert_memories(str(MEMORIES_DB), all_memories, f"session:{filename}", created_at)

        elapsed = time.time() - start_time
        db.execute(
            """UPDATE session_types SET status='done', chunks=?, chunks_empty=?,
               memories_extracted=?, finished_at=?, input_tokens=?, output_tokens=?, cost_usd=?
               WHERE filename=? AND prompt_type=?""",
            (len(chunks), chunks_empty, len(all_memories),
             datetime.now(timezone.utc).isoformat(),
             total_input_tokens, total_output_tokens, total_cost_usd,
             filename, prompt_type)
        )
        db.commit()

        return {
            "status": "done", "filename": filename, "prompt_type": prompt_type,
            "memories": len(all_memories), "chunks": len(chunks), "elapsed": elapsed,
            "input_tokens": total_input_tokens, "output_tokens": total_output_tokens,
            "cost_usd": total_cost_usd,
        }

    except RateLimitError:
        db.close()
        raise

    except Exception:
        tb = traceback.format_exc()
        elapsed = time.time() - start_time
        try:
            db.execute(
                "UPDATE session_types SET status='error', error_message=?, finished_at=? WHERE filename=? AND prompt_type=?",
                (tb, datetime.now(timezone.utc).isoformat(), filename, prompt_type)
            )
            db.commit()
        except Exception:
            pass
        return {"status": "error", "filename": filename, "prompt_type": prompt_type,
                "memories": 0, "chunks": 0, "elapsed": elapsed, "error": tb}

    finally:
        db.close()


def cmd_status() -> None:
    db = get_db()
    setup_db(db)

    # Auto-populate if empty
    count = db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    if count == 0:
        populate_sessions(db)
    else:
        migrate_batch_state(db)
        db.commit()

    # Per-type extraction progress
    total = db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    extractable = db.execute(
        "SELECT COUNT(*) FROM sessions WHERE status != 'skipped'"
    ).fetchone()[0]
    skipped_count = db.execute(
        "SELECT COUNT(*) FROM sessions WHERE status = 'skipped'"
    ).fetchone()[0]

    print(f"\nSessions: {total} total ({extractable} extractable, {skipped_count} skipped)")
    print()

    # Check if session_types table has data
    has_st = db.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='session_types'"
    ).fetchone()[0]

    if has_st:
        print(f"  {'Type':<12} {'Done':>6} {'Pending':>8} {'Error':>6} {'Progress'}")
        for t in ALL_TYPES:
            done = db.execute(
                "SELECT COUNT(*) FROM session_types WHERE prompt_type=? AND status='done'", (t,)
            ).fetchone()[0]
            error = db.execute(
                "SELECT COUNT(*) FROM session_types WHERE prompt_type=? AND status='error'", (t,)
            ).fetchone()[0]
            pending_t = extractable - done - error
            pct = (done / extractable * 100) if extractable else 0
            print(f"  {t:<12} {done:>6} {pending_t:>8} {error:>6} {pct:>5.1f}%")
        print()

    # Memories DB
    print()
    if MEMORIES_DB.exists():
        try:
            mdb = sqlite3.connect(MEMORIES_DB)
            mdb.row_factory = sqlite3.Row
            mem_total = mdb.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
            mem_rows = mdb.execute(
                "SELECT type, COUNT(*) as n FROM memories GROUP BY type ORDER BY n DESC"
            ).fetchall()
            mdb.close()
            print(f"Memories: {mem_total} total")
            for row in mem_rows:
                print(f"  {row['type']}: {row['n']}")
        except Exception as e:
            print(f"Memories: (error reading DB: {e})")
    else:
        print("Memories: (DB not found)")

    # Last run
    print()
    last_run = db.execute(
        "SELECT * FROM runs ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if last_run:
        cost = last_run["total_cost_usd"] or 0.0
        in_tok = last_run["total_input_tokens"] or 0
        out_tok = last_run["total_output_tokens"] or 0
        print(f"Last run: {last_run['started_at']}  type={last_run['prompt_type']}  "
              f"processed={last_run['sessions_processed']}  "
              f"errors={last_run['sessions_errored']}  "
              f"memories={last_run['total_memories']}")
        if in_tok or out_tok:
            total_tok = in_tok + out_tok
            print(f"  Tokens: {total_tok:,} total (input: {in_tok:,}, output: {out_tok:,})")
            if cost:
                print(f"  Cost: ${cost:.4f}")
    else:
        print("Last run: none")

    db.close()
    print()


def process_one_session(filename: str, prompt_template: str, prompt_type: str) -> dict:
    """Extract memories from a single session. Returns a result dict."""
    start_time = time.time()
    path = SESSIONS_DIR / filename

    # Each thread gets its own DB connection
    db = sqlite3.connect(BATCH_DB, timeout=30)
    db.row_factory = sqlite3.Row

    try:
        now = datetime.now(timezone.utc).isoformat()
        db.execute(
            "UPDATE sessions SET status='running', started_at=? WHERE filename=?",
            (now, filename)
        )
        db.commit()

        session = parse_session(str(path))

        if session["char_count"] < 500:
            db.execute(
                "UPDATE sessions SET status='skipped', finished_at=? WHERE filename=?",
                (datetime.now(timezone.utc).isoformat(), filename)
            )
            db.commit()
            return {"status": "skipped", "filename": filename, "memories": 0, "chunks": 0, "elapsed": time.time() - start_time}

        created_at = int(os.path.getmtime(str(path)))

        chunks = chunk_conversation(session["messages"], 750, 100)

        # Extract all chunks in parallel (up to 5 workers per session)
        all_memories = []
        chunks_empty = 0

        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            futures = [pool.submit(extract_chunk, (i, chunk_msgs, prompt_template)) for i, chunk_msgs in enumerate(chunks)]
            chunk_results = [f.result() for f in concurrent.futures.as_completed(futures)]

        chunk_results.sort(key=lambda x: x[0])

        total_input_tokens = 0
        total_output_tokens = 0
        total_cost_usd = 0.0

        for i, memories, stats in chunk_results:
            if not memories:
                chunks_empty += 1
            for mem in memories:
                if isinstance(mem, str):
                    all_memories.append({"content": mem.strip(), "type": prompt_type})
                elif isinstance(mem, dict):
                    if "type" not in mem:
                        mem["type"] = prompt_type
                    all_memories.append(mem)
                else:
                    all_memories.append({"content": str(mem).strip(), "type": prompt_type})
            total_input_tokens += (
                stats.get("input_tokens", 0)
                + stats.get("cache_creation_tokens", 0)
                + stats.get("cache_read_tokens", 0)
            )
            total_output_tokens += stats.get("output_tokens", 0)
            total_cost_usd += stats.get("cost_usd", 0.0)

        # Insert into memories DB
        if all_memories:
            insert_memories(str(MEMORIES_DB), all_memories, f"session:{filename}", created_at)

        elapsed = time.time() - start_time
        db.execute(
            """UPDATE sessions SET status='done', prompt_type=?, chunks=?, chunks_empty=?,
               memories_extracted=?, finished_at=?, input_tokens=?, output_tokens=?, cost_usd=?
               WHERE filename=?""",
            (prompt_type, len(chunks), chunks_empty, len(all_memories),
             datetime.now(timezone.utc).isoformat(),
             total_input_tokens, total_output_tokens, total_cost_usd,
             filename)
        )
        db.commit()

        return {
            "status": "done",
            "filename": filename,
            "memories": len(all_memories),
            "chunks": len(chunks),
            "elapsed": elapsed,
            "input_tokens": total_input_tokens,
            "output_tokens": total_output_tokens,
            "cost_usd": total_cost_usd,
        }

    except RateLimitError:
        db.close()
        raise

    except Exception:
        tb = traceback.format_exc()
        elapsed = time.time() - start_time
        try:
            db.execute(
                "UPDATE sessions SET status='error', error_message=?, finished_at=? WHERE filename=?",
                (tb, datetime.now(timezone.utc).isoformat(), filename)
            )
            db.commit()
        except Exception:
            pass
        return {
            "status": "error",
            "filename": filename,
            "memories": 0,
            "chunks": 0,
            "elapsed": elapsed,
            "error": tb,
        }

    finally:
        db.close()


def cmd_run(args) -> None:
    if args.type is not None:
        cmd_run_single(args)
    else:
        cmd_run_interleaved(args)


def cmd_run_single(args) -> None:
    db = get_db()
    setup_db(db)
    populate_sessions(db)

    template = load_prompt(args.type)

    # SIGINT handling
    shutdown_flag = threading.Event()
    original_sigint = signal.getsignal(signal.SIGINT)

    def _sigint_handler(signum, frame):
        print("\nShutting down gracefully...")
        shutdown_flag.set()

    signal.signal(signal.SIGINT, _sigint_handler)

    now = datetime.now(timezone.utc).isoformat()
    cur = db.execute(
        "INSERT INTO runs (prompt_type, parallel, started_at) VALUES (?, ?, ?)",
        (args.type, args.parallel, now)
    )
    run_id = cur.lastrowid
    db.commit()

    # Query pending (and optionally errored) sessions
    if args.retry_errors:
        rows = db.execute(
            "SELECT filename FROM sessions WHERE status IN ('pending', 'error')"
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT filename FROM sessions WHERE status='pending'"
        ).fetchall()

    # Sort by file modification time, newest first
    filenames = [r["filename"] for r in rows]
    filenames.sort(
        key=lambda f: os.path.getmtime(str(SESSIONS_DIR / f)) if (SESSIONS_DIR / f).exists() else 0,
        reverse=True,
    )

    if args.limit is not None:
        filenames = filenames[:args.limit]

    total = len(filenames)
    print(f"Processing {total} sessions (parallel={args.parallel}, type={args.type})")

    processed = 0
    skipped = 0
    errored = 0
    total_memories = 0
    run_input_tokens = 0
    run_output_tokens = 0
    run_cost_usd = 0.0
    stop_reason = "complete"

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.parallel) as pool:
        future_to_name = {
            pool.submit(process_one_session, fn, template, args.type): fn
            for fn in filenames
        }
        pending_futures = set(future_to_name.keys())

        for n, future in enumerate(concurrent.futures.as_completed(future_to_name), start=1):
            pending_futures.discard(future)

            try:
                result = future.result()
            except RateLimitError:
                print("Rate limit hit. Stopping. Run again to resume.")
                for f in pending_futures:
                    f.cancel()
                stop_reason = "rate_limit"
                break

            status = result["status"]
            elapsed = result["elapsed"]
            memories = result["memories"]
            chunks = result["chunks"]
            fn = result["filename"]

            if status == "done":
                processed += 1
                total_memories += memories
                run_input_tokens += result.get("input_tokens", 0)
                run_output_tokens += result.get("output_tokens", 0)
                run_cost_usd += result.get("cost_usd", 0.0)
                print(f"[{n}/{total}] {fn} — {chunks} chunks, {memories} memories, {elapsed:.1f}s  cost=${result.get('cost_usd', 0.0):.4f}", file=sys.stderr)
            elif status == "skipped":
                skipped += 1
                print(f"[{n}/{total}] {fn} — skipped (too small), {elapsed:.1f}s", file=sys.stderr)
            else:
                errored += 1
                print(f"[{n}/{total}] {fn} — ERROR, {elapsed:.1f}s", file=sys.stderr)

            if shutdown_flag.is_set():
                for f in pending_futures:
                    f.cancel()
                stop_reason = "interrupted"
                break

    # Restore original SIGINT handler
    signal.signal(signal.SIGINT, original_sigint)

    # Clean up any sessions left in 'running' state (interrupted or rate-limited)
    db.execute("UPDATE sessions SET status='pending' WHERE status='running'")
    db.commit()

    # Update run row with totals
    stopped_at = datetime.now(timezone.utc).isoformat()
    db.execute(
        """UPDATE runs SET stopped_at=?, stop_reason=?,
           sessions_processed=?, sessions_skipped=?, sessions_errored=?, total_memories=?,
           total_input_tokens=?, total_output_tokens=?, total_cost_usd=?
           WHERE id=?""",
        (stopped_at, stop_reason, processed, skipped, errored, total_memories,
         run_input_tokens, run_output_tokens, run_cost_usd, run_id)
    )
    db.commit()
    db.close()

    print(f"\nDone. processed={processed} skipped={skipped} errors={errored} memories={total_memories} "
          f"cost=${run_cost_usd:.4f} (in={run_input_tokens:,} out={run_output_tokens:,}) stop_reason={stop_reason}")


def cmd_run_interleaved(args) -> None:
    db = get_db()
    setup_db(db)
    populate_sessions(db)

    # Crash recovery: reset stale running states
    db.execute("UPDATE session_types SET status='pending' WHERE status='running'")
    db.commit()

    # SIGINT handling
    shutdown_flag = threading.Event()
    original_sigint = signal.getsignal(signal.SIGINT)
    def _sigint_handler(signum, frame):
        print("\nShutting down gracefully...")
        shutdown_flag.set()
    signal.signal(signal.SIGINT, _sigint_handler)

    max_cost = getattr(args, 'max_cost', None)

    pending = get_pending_sessions(db)
    if args.limit is not None:
        pending = pending[:args.limit]

    now = datetime.now(timezone.utc).isoformat()
    cur = db.execute(
        "INSERT INTO runs (prompt_type, parallel, started_at) VALUES (?, ?, ?)",
        ("interleaved", args.parallel, now)
    )
    run_id = cur.lastrowid
    db.commit()

    total_sessions = len(pending)
    print(f"Processing {total_sessions} sessions, interleaved across {len(ALL_TYPES)} types (parallel={args.parallel})")
    if max_cost:
        print(f"Budget cap: ${max_cost:.2f}")

    sessions_processed = 0
    sessions_skipped = 0
    types_processed = 0
    types_errored = 0
    run_memories = 0
    run_input_tokens = 0
    run_output_tokens = 0
    run_cost_usd = 0.0
    stop_reason = "complete"

    for session_n, (filename, missing_types) in enumerate(pending, start=1):
        if shutdown_flag.is_set():
            stop_reason = "interrupted"
            break
        if max_cost and run_cost_usd >= max_cost:
            stop_reason = "budget"
            print(f"Budget cap reached (${run_cost_usd:.4f} >= ${max_cost:.2f}). Stopping.")
            break

        path = SESSIONS_DIR / filename
        if not path.exists():
            continue

        session = parse_session(str(path))
        if session["char_count"] < 500:
            for t in missing_types:
                db.execute(
                    "INSERT OR REPLACE INTO session_types (filename, prompt_type, status) VALUES (?, ?, 'skipped')",
                    (filename, t)
                )
            db.commit()
            sessions_skipped += 1
            print(f"[{session_n}/{total_sessions}] {filename} — skipped (too small)", file=sys.stderr)
            continue

        created_at = int(os.path.getmtime(str(path)))
        chunks = chunk_conversation(session["messages"], 750, 100)

        session_results = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(missing_types), args.parallel)) as pool:
            future_to_type = {}
            for t in missing_types:
                template = load_prompt(t)
                future = pool.submit(process_one_type, filename, chunks, template, t, created_at)
                future_to_type[future] = t

            for future in concurrent.futures.as_completed(future_to_type):
                try:
                    result = future.result()
                    session_results.append(result)
                except RateLimitError:
                    print("Rate limit hit. Stopping. Run again to resume.")
                    stop_reason = "rate_limit"
                    break

        if stop_reason == "rate_limit":
            break

        type_summary_parts = []
        for result in session_results:
            if result["status"] == "done":
                types_processed += 1
                run_memories += result["memories"]
                run_input_tokens += result.get("input_tokens", 0)
                run_output_tokens += result.get("output_tokens", 0)
                run_cost_usd += result.get("cost_usd", 0.0)
                type_summary_parts.append(f"{result['prompt_type']}:{result['memories']}")
            else:
                types_errored += 1
                type_summary_parts.append(f"{result['prompt_type']}:ERR")

        sessions_processed += 1
        elapsed = sum(r.get("elapsed", 0) for r in session_results)
        session_cost = sum(r.get("cost_usd", 0) for r in session_results)
        type_summary = ", ".join(type_summary_parts)
        print(f"[{session_n}/{total_sessions}] {filename} — {len(chunks)} chunks, {type_summary}, {elapsed:.1f}s, ${session_cost:.4f}", file=sys.stderr)

    signal.signal(signal.SIGINT, original_sigint)

    db.execute("UPDATE session_types SET status='pending' WHERE status='running'")
    db.commit()

    stopped_at = datetime.now(timezone.utc).isoformat()
    db.execute(
        """UPDATE runs SET stopped_at=?, stop_reason=?,
           sessions_processed=?, sessions_skipped=?, sessions_errored=?, total_memories=?,
           total_input_tokens=?, total_output_tokens=?, total_cost_usd=?
           WHERE id=?""",
        (stopped_at, stop_reason, sessions_processed, sessions_skipped, types_errored, run_memories,
         run_input_tokens, run_output_tokens, run_cost_usd, run_id)
    )
    db.commit()
    db.close()

    print(f"\nDone. sessions={sessions_processed} skipped={sessions_skipped} types_done={types_processed} "
          f"type_errors={types_errored} memories={run_memories} "
          f"cost=${run_cost_usd:.4f} stop={stop_reason}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Aria memory extraction runner")
    subparsers = parser.add_subparsers(dest="command")

    # status
    subparsers.add_parser("status", help="Show extraction progress")

    # run
    run_parser = subparsers.add_parser("run", help="Run extraction")
    run_parser.add_argument("--type", required=False, default=None,
                            choices=["world", "max", "people", "friction", "biology"],
                            help="Extract one type only (omit for interleaved)")
    run_parser.add_argument("--max-cost", type=float, default=None,
                            help="Stop after spending this many USD")
    run_parser.add_argument("--parallel", type=int, default=4)
    run_parser.add_argument("--limit", type=int, default=None)
    run_parser.add_argument("--retry-errors", action="store_true")

    args = parser.parse_args()

    if args.command == "status":
        cmd_status()
    elif args.command == "run":
        cmd_run(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
