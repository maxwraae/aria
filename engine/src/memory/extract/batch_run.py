#!/usr/bin/env python3
"""Batch runner for Aria memory extraction across all sessions."""

import argparse
import concurrent.futures
import glob
import json
import os
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

from parse_session import parse_session
from pipeline import chunk_conversation, run_extraction, insert_memories, load_prompt, extract_chunk

STATE_FILE = Path(__file__).parent / "batch_state.json"


def save_state(state: dict, path: Path):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(state, indent=2))
    os.replace(tmp, path)


def load_state(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {
        "processed": {},
        "started_at": datetime.now().isoformat(),
        "last_updated": datetime.now().isoformat(),
    }


def process_session(session_path: str, prompt_template: str, db_path: str, prompt_type: str) -> dict:
    """Process one session. Returns result dict for state tracking."""
    start = time.time()
    try:
        session = parse_session(session_path)
        char_count = session["char_count"]

        if char_count < 500:
            return {"status": "skipped", "reason": f"too small ({char_count} chars)"}

        created_at = int(os.path.getmtime(session_path))
        filename = session["filename"]

        chunks = chunk_conversation(session["messages"], 750, 100)

        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            futures = [pool.submit(extract_chunk, (i, chunk_msgs, prompt_template)) for i, chunk_msgs in enumerate(chunks)]
            results_list = [f.result() for f in futures]

        results_list.sort(key=lambda x: x[0])

        all_memories = []
        chunks_empty = 0

        for i, memories, stats in results_list:
            chunk_memories = []
            for mem in memories:
                if isinstance(mem, str):
                    chunk_memories.append({"content": mem.strip(), "type": prompt_type})
                elif isinstance(mem, dict):
                    if "type" not in mem:
                        mem["type"] = prompt_type
                    chunk_memories.append(mem)
                else:
                    chunk_memories.append({"content": str(mem).strip(), "type": prompt_type})

            if len(chunk_memories) == 0:
                chunks_empty += 1

            all_memories.extend(chunk_memories)

        insert_memories(db_path, all_memories, f"session:{filename}", created_at)

        elapsed = time.time() - start
        return {
            "status": "done",
            "memories": len(all_memories),
            "chunks": len(chunks),
            "chunks_empty": chunks_empty,
            "time": elapsed,
        }

    except Exception:
        elapsed = time.time() - start
        return {
            "status": "error",
            "error": traceback.format_exc(),
            "time": elapsed,
        }


def main():
    parser = argparse.ArgumentParser(description="Batch runner for Aria memory extraction across all sessions")
    parser.add_argument("--parallel", type=int, default=2, help="Max concurrent sessions (default: 2)")
    parser.add_argument("--type", default="world", choices=["world", "preference", "both"],
                        help="Extraction type (default: world)")
    parser.add_argument("--db", default=str(Path.home() / "Library/Mobile Documents/com~apple~CloudDocs/Aria/data/memories.db"),
                        help="SQLite database path (default: Aria's memories.db)")
    parser.add_argument("--limit", type=int, default=None, help="Process only first N sessions (for testing)")
    parser.add_argument("--retry-errors", action="store_true", help="Re-process sessions that previously errored")
    args = parser.parse_args()

    # Load state
    state = load_state(STATE_FILE)
    if "processed" not in state:
        state["processed"] = {}
    if "started_at" not in state:
        state["started_at"] = datetime.now().isoformat()

    # Discover sessions
    sessions_dir = Path.home() / ".claude/projects/-Users-maxwraae"
    session_files = sorted(glob.glob(str(sessions_dir / "*.jsonl")), key=os.path.getmtime)

    if args.limit:
        session_files = session_files[:args.limit]

    # Filter already processed
    sessions_to_process = []
    already_done = 0
    for path in session_files:
        filename = os.path.basename(path)
        existing = state["processed"].get(filename)
        if existing is None:
            sessions_to_process.append(path)
        elif existing.get("status") in ("done", "skipped"):
            already_done += 1
        elif existing.get("status") == "error":
            if args.retry_errors:
                sessions_to_process.append(path)
            else:
                already_done += 1

    if already_done > 0:
        print(f"Resuming: {already_done} sessions already processed, {len(sessions_to_process)} remaining", file=sys.stderr)

    if not sessions_to_process:
        print("No sessions to process.", file=sys.stderr)
        return

    # Determine prompt type
    if args.type == "world":
        prompt_key = "world"
        prompt_type = "world"
    elif args.type == "preference":
        prompt_key = "preference"
        prompt_type = "preference"
    else:
        # "both" — default to world for batch mode
        prompt_key = "world"
        prompt_type = "world"

    # Load prompt once before the pool
    prompt_template = load_prompt(prompt_key)

    print(f"Processing {len(sessions_to_process)} sessions (parallel={args.parallel}, type={args.type}, db={args.db})", file=sys.stderr)

    # Process sessions with ThreadPoolExecutor at session level
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.parallel) as pool:
        future_to_filename = {}
        for path in sessions_to_process:
            filename = os.path.basename(path)
            future = pool.submit(process_session, path, prompt_template, args.db, prompt_type)
            future_to_filename[future] = (filename, path)

        completed = 0
        total = len(sessions_to_process)
        total_memories = 0
        total_errors = 0
        total_skipped = 0

        for future in concurrent.futures.as_completed(future_to_filename):
            filename, path = future_to_filename[future]
            try:
                result = future.result()
            except Exception as e:
                result = {"status": "error", "error": str(e)}

            state["processed"][filename] = result
            state["last_updated"] = datetime.now().isoformat()
            save_state(state, STATE_FILE)

            completed += 1
            status = result["status"]

            if status == "done":
                mems = result.get("memories", 0)
                total_memories += mems
                elapsed = result.get("time", 0)
                chunks = result.get("chunks", 0)
                print(f"[{completed}/{total}] {filename} — {chunks} chunks, {mems} memories, {elapsed:.0f}s", file=sys.stderr, flush=True)
            elif status == "skipped":
                total_skipped += 1
                print(f"[{completed}/{total}] {filename} — skipped ({result.get('reason', '')})", file=sys.stderr, flush=True)
            elif status == "error":
                total_errors += 1
                print(f"[{completed}/{total}] {filename} — ERROR: {result.get('error', '')[:100]}", file=sys.stderr, flush=True)

            # Progress summary every 50
            if completed % 50 == 0:
                print(f"\nProgress: {completed}/{total} done, {total_skipped} skipped, {total_errors} errors, {total_memories} memories total\n", file=sys.stderr, flush=True)

    # Final summary
    print(f"\n{'='*60}", file=sys.stderr)
    print(f"COMPLETE: {completed} sessions processed", file=sys.stderr)
    print(f"  Done: {completed - total_skipped - total_errors}", file=sys.stderr)
    print(f"  Skipped: {total_skipped}", file=sys.stderr)
    print(f"  Errors: {total_errors}", file=sys.stderr)
    print(f"  Total memories: {total_memories}", file=sys.stderr)
    print(f"  State saved to: {STATE_FILE}", file=sys.stderr)


if __name__ == "__main__":
    main()
