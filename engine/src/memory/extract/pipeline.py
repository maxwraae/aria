#!/usr/bin/env python3
"""Aria memory extraction pipeline.

Usage:
    python pipeline.py --session <path> [--type world|preference|both] [--db <path>]

Extracts memories from a Claude Code conversation session using Haiku
and writes them to Aria's SQLite database. Output goes to an Obsidian
markdown file for review.
"""

import argparse
import concurrent.futures
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path

from parse_session import parse_session


class RateLimitError(Exception):
    """Raised when the API returns a rate limit error."""
    pass


# Paths
SCRIPT_DIR = Path(__file__).parent
PROMPTS_DIR = SCRIPT_DIR / "prompts"
ARIA_DATA = Path.home() / "Library/Mobile Documents/com~apple~CloudDocs/Aria/data"
OBSIDIAN_OUTPUT = Path.home() / "Library/Mobile Documents/iCloud~md~obsidian/Documents/Cortex/Aria/memory-extraction-output.md"

# Chunk configs
CHUNK_CONFIGS = {
    "default": {"chunk_words": 750, "overlap_words": 100},
}


def load_prompt(prompt_type: str) -> str:
    path = PROMPTS_DIR / f"{prompt_type}.txt"
    if not path.exists():
        print(f"Prompt file not found: {path}", file=sys.stderr)
        sys.exit(1)
    return path.read_text()


def chunk_conversation(messages: list, chunk_words: int, overlap_words: int) -> list:
    """Split conversation messages into overlapping word-based chunks.

    Never splits mid-message. If chunk target is reached mid-message,
    the chunk extends to include the full message (elasticity).

    Returns list of chunks, each chunk is a list of message dicts.
    """
    if not messages:
        return []

    # Calculate word count per message
    msg_words = []
    for msg in messages:
        wc = len(msg["text"].split())
        msg_words.append(wc)

    total_words = sum(msg_words)

    # If everything fits in one chunk, return as-is
    if total_words <= chunk_words + overlap_words:
        return [messages]

    chunks = []
    start_idx = 0

    while start_idx < len(messages):
        # Accumulate messages until we hit chunk_words
        end_idx = start_idx
        accumulated = 0

        while end_idx < len(messages) and accumulated < chunk_words:
            accumulated += msg_words[end_idx]
            end_idx += 1

        # end_idx is now one past the last message to include
        # This naturally respects message boundaries (elasticity)

        chunk = messages[start_idx:end_idx]
        chunks.append(chunk)

        # Calculate step size (chunk - overlap)
        step_words = chunk_words - overlap_words
        if step_words <= 0:
            step_words = max(1, chunk_words // 2)

        # Advance start_idx by step_words worth of messages
        advance = 0
        new_start = start_idx
        while new_start < len(messages) and advance < step_words:
            advance += msg_words[new_start]
            new_start += 1

        # Prevent infinite loop
        if new_start <= start_idx:
            new_start = start_idx + 1

        start_idx = new_start

    return chunks


def run_extraction(conversation_text: str, prompt_template: str, max_retries: int = 5) -> tuple:
    """Run extraction through Haiku via claude -p. Returns (memories_list, stats_dict)."""
    full_prompt = prompt_template + conversation_text + "\n</conversation>"

    for attempt in range(max_retries):
        start = time.time()

        result = subprocess.run(
            ["claude", "-p", "--model", "haiku", "--allowedTools", "", "--output-format", "json"],
            input=full_prompt,
            capture_output=True,
            text=True,
            timeout=120,
        )

        end = time.time()
        elapsed = end - start

        # If non-zero return code, stdout may not be valid JSON — check for rate limit first
        rate_limit_signals = ["rate limit", "overloaded", "429", "too many requests", "rate_limit"]
        if result.returncode != 0:
            combined_output = (result.stdout + result.stderr).lower()
            if any(signal in combined_output for signal in rate_limit_signals):
                raise RateLimitError(f"API rate limited on attempt {attempt + 1}: {result.stderr.strip()}")

        # Parse JSON envelope
        envelope = {}
        try:
            envelope = json.loads(result.stdout)
            response = envelope.get("result", "")
            usage = envelope.get("usage", {})
        except (json.JSONDecodeError, TypeError):
            # Fallback: treat stdout as raw text
            response = result.stdout
            usage = {}

        # Also check rate limit signals in parsed response (in case returncode was 0 but output signals limit)
        combined_output = (response + result.stderr).lower()
        is_rate_limited = (
            result.returncode != 0
            and any(signal in combined_output for signal in rate_limit_signals)
        )
        if is_rate_limited:
            raise RateLimitError(f"API rate limited on attempt {attempt + 1}: {result.stderr.strip()}")

        stats = {
            "input_tokens": usage.get("input_tokens", 0),
            "output_tokens": usage.get("output_tokens", 0),
            "cache_read_tokens": usage.get("cache_read_input_tokens", 0),
            "cache_creation_tokens": usage.get("cache_creation_input_tokens", 0),
            "cost_usd": envelope.get("total_cost_usd", 0) if isinstance(envelope, dict) else 0,
            "duration_ms": envelope.get("duration_ms", 0) if isinstance(envelope, dict) else 0,
            "prefill_time": 0,
            "gen_time": 0,
            "gen_tok_s": 0,
            "elapsed": elapsed,
            "attempt": attempt + 1,
            "stderr": result.stderr,
        }

        # Strip thinking tags if present
        thinking_text = ""
        if "<think>" in response:
            think_match = re.search(r"<think>(.*?)</think>", response, re.DOTALL)
            if think_match:
                thinking_text = think_match.group(1).strip()
            response_clean = re.sub(r"<think>.*?</think>", "", response, flags=re.DOTALL).strip()
        else:
            response_clean = response

        # Parse JSON
        clean = response_clean.strip()
        if clean.startswith("```"):
            clean = clean.split("\n", 1)[1] if "\n" in clean else clean[3:]
            clean = clean.rsplit("```", 1)[0]
        clean = clean.strip()

        stats["raw_response"] = response
        stats["thinking"] = thinking_text

        # Try direct parse first
        try:
            memories = json.loads(clean)
            if isinstance(memories, list):
                return memories, stats
        except json.JSONDecodeError:
            pass

        # Try concatenating multiple JSON arrays on separate lines
        # (model sometimes outputs one array per line)
        all_memories = []
        for line in clean.split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
                if isinstance(parsed, list):
                    all_memories.extend(parsed)
                elif isinstance(parsed, dict):
                    all_memories.append(parsed)
            except json.JSONDecodeError:
                continue

        if all_memories:
            return all_memories, stats

        if attempt < max_retries - 1:
            print(f"  JSON parse failed (attempt {attempt + 1}), retrying...", file=sys.stderr)
            continue

        return [], stats

    return [], stats


def insert_memories(db_path: str, memories: list, source: str, created_at: int):
    """Insert memories into SQLite."""
    conn = sqlite3.connect(db_path, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    cursor = conn.cursor()

    inserted = 0
    for mem in memories:
        content = mem.get("content", "").strip()
        mem_type = mem.get("type", "unknown").strip()
        if not content:
            continue

        mem_id = f"m_{uuid.uuid4().hex[:12]}"

        cursor.execute(
            "INSERT INTO memories (id, content, type, source, created_at) VALUES (?, ?, ?, ?, ?)",
            (mem_id, content, mem_type, source, created_at),
        )

        # Sync to FTS5
        rowid = cursor.execute(
            "SELECT rowid FROM memories WHERE id = ?", (mem_id,)
        ).fetchone()[0]
        cursor.execute(
            "INSERT INTO memories_fts (rowid, content, type) VALUES (?, ?, ?)",
            (rowid, content, mem_type),
        )
        inserted += 1

    conn.commit()
    conn.close()
    return inserted


def format_output(session_info: dict, results: list, db_path: str) -> str:
    """Format extraction results as markdown for Obsidian."""
    lines = []
    lines.append("# Memory Extraction Output")
    lines.append("")
    lines.append(f"**Session:** `{session_info['filename']}`")

    # Get date from file
    date_str = datetime.fromtimestamp(session_info["created_at"]).strftime("%Y-%m-%d %H:%M")
    lines.append(f"**Date:** {date_str}")
    lines.append(f"**Messages:** {session_info['user_count']} user, {session_info['assistant_count']} assistant")
    lines.append(f"**Clean text:** {session_info['char_count']:,} chars (~{session_info['token_estimate']:,} tokens)")
    lines.append(f"**Database:** `{db_path}`")
    lines.append("")

    total_memories = 0

    for r in results:
        lines.append(f"---")
        lines.append(f"## {r['type'].title()} Extraction")
        lines.append("")

        # Config and chunk info
        cfg_key = r.get("config", "a")
        cfg = CHUNK_CONFIGS[cfg_key]
        chunk_count = r.get("chunk_count", 1)
        lines.append(f"Config: {cfg_key.upper()} ({cfg['chunk_words']}w chunk, {cfg['overlap_words']}w overlap) | {chunk_count} chunks")
        lines.append("")

        # Per-chunk stats
        stats_list = r.get("stats", [])
        if not isinstance(stats_list, list):
            stats_list = [stats_list]

        total_prefill = 0
        total_gen = 0
        for s in stats_list:
            chunk_idx = s.get("chunk_index", 1)
            chunk_words = s.get("chunk_words", 0)
            prefill = s.get("prefill_time", 0)
            gen = s.get("gen_time", 0)
            tok_s = s.get("gen_tok_s", 0)
            lines.append(f"Chunk {chunk_idx} ({chunk_words} words): prefill {prefill:.1f}s + gen {gen:.1f}s ({tok_s:.0f} tok/s)")
            total_prefill += prefill
            total_gen += gen

        if len(stats_list) > 1:
            lines.append(f"Total: prefill {total_prefill:.1f}s + gen {total_gen:.1f}s")
        lines.append("")

        if r["memories"]:
            for mem in r["memories"]:
                if isinstance(mem, dict):
                    lines.append(f"- **[{mem.get('type', '?')}]** {mem.get('content', '?')}")
                else:
                    lines.append(f"- {mem}")
            lines.append("")
            lines.append(f"**Extracted: {len(r['memories'])} memories**")
            total_memories += len(r["memories"])
        else:
            lines.append("*No memories extracted.*")
        lines.append("")

        # Thinking and raw output per chunk
        for s in stats_list:
            chunk_idx = s.get("chunk_index", 1)
            if s.get("thinking"):
                lines.append(f"<details><summary>Chunk {chunk_idx} — model thinking</summary>")
                lines.append("")
                lines.append(s["thinking"])
                lines.append("")
                lines.append("</details>")
                lines.append("")

            lines.append(f"<details><summary>Chunk {chunk_idx} — raw model output</summary>")
            lines.append("")
            lines.append("```json")
            lines.append(s.get("raw_response", "(no response)"))
            lines.append("```")
            lines.append("</details>")
            lines.append("")

    lines.append("---")
    lines.append(f"**Total: {total_memories} memories inserted**")

    return "\n".join(lines)



def extract_chunk(args_tuple):
    """Worker for parallel extraction."""
    i, chunk_msgs, template = args_tuple
    chunk_text = "\n\n".join(m["text"] for m in chunk_msgs)
    chunk_words = len(chunk_text.split())
    memories, stats = run_extraction(chunk_text, template)
    stats["chunk_index"] = i + 1
    stats["chunk_words"] = chunk_words
    return i, memories, stats


def main():
    parser = argparse.ArgumentParser(description="Aria memory extraction pipeline")
    parser.add_argument("--session", required=True, help="Path to .jsonl session file")
    parser.add_argument("--type", default="both", choices=["world", "preference", "both"],
                        help="What to extract (default: both)")
    parser.add_argument("--db", default=None, help="Path to SQLite database (default: auto)")
    parser.add_argument("--dry-run", action="store_true", help="Don't insert into DB, just show output")
    parser.add_argument("--config", default="default", choices=["default"],
                        help="Chunk config (default: 750w chunk / 100w overlap)")
    parser.add_argument("--parallel", type=int, default=5,
                        help="Max parallel Haiku calls (default: 5)")
    args = parser.parse_args()

    # Resolve DB path
    db_path = args.db or str(ARIA_DATA / "memories.db")
    if not os.path.exists(db_path) and not args.dry_run:
        print(f"Database not found: {db_path}", file=sys.stderr)
        print("Run the Aria engine first to create it, or pass --db <path>", file=sys.stderr)
        sys.exit(1)

    # Parse session
    session = parse_session(args.session)
    if session["char_count"] < 500:
        print(f"Session too small ({session['char_count']} chars), skipping.", file=sys.stderr)
        sys.exit(0)

    # Get created_at from file mtime
    created_at = int(os.path.getmtime(args.session))
    session["created_at"] = created_at

    # Get chunk config
    cfg = CHUNK_CONFIGS[args.config]

    # Chunk the conversation
    chunks = chunk_conversation(session["messages"], cfg["chunk_words"], cfg["overlap_words"])

    # Determine which types to extract
    # Map "world" -> "world-v2" for prompt loading
    types_to_run = []
    if args.type in ("world", "both"):
        types_to_run.append(("world", "world"))
    if args.type in ("preference", "both"):
        types_to_run.append(("preference", "preference"))

    # Print run config summary
    print(f"\nRun config:", file=sys.stderr)
    print(f"  Model:    Haiku (cloud)", file=sys.stderr)
    print(f"  Prompt:   world-v2", file=sys.stderr)
    print(f"  Chunks:   {cfg['chunk_words']}w / {cfg['overlap_words']}w overlap", file=sys.stderr)
    print(f"  Parallel: {args.parallel}", file=sys.stderr)
    print(f"  Dedup:    at read time (cosine similarity)", file=sys.stderr)

    # Run extractions per chunk per type
    results = []
    for prompt_type, prompt_key in types_to_run:
        print(f"\n--- Extracting {prompt_type} (config {args.config}: {len(chunks)} chunks, parallel={args.parallel}) ---", file=sys.stderr)
        template = load_prompt(prompt_key)

        all_memories = []
        all_stats = []

        with concurrent.futures.ThreadPoolExecutor(max_workers=args.parallel) as pool:
            futures = [pool.submit(extract_chunk, (i, chunk_msgs, template)) for i, chunk_msgs in enumerate(chunks)]
            results_list = [f.result() for f in futures]

        # Sort by chunk index to maintain order
        results_list.sort(key=lambda x: x[0])

        for i, memories, stats in results_list:
            chunk_words = stats.get("chunk_words", 0)
            print(f"  Chunk {i+1}/{len(chunks)} ({chunk_words} words)... done", file=sys.stderr, flush=True)
            # Normalize: convert strings to dicts, add type from prompt
            for mem in memories:
                if isinstance(mem, str):
                    all_memories.append({"content": mem.strip(), "type": prompt_type})
                elif isinstance(mem, dict):
                    if "type" not in mem:
                        mem["type"] = prompt_type
                    all_memories.append(mem)
                else:
                    all_memories.append({"content": str(mem).strip(), "type": prompt_type})
            all_stats.append(stats)

        # Insert into DB
        if all_memories and not args.dry_run:
            source = f"session:{session['filename']}"
            inserted = insert_memories(db_path, all_memories, source, created_at)
            print(f"Inserted {inserted} memories into {db_path}", file=sys.stderr)

        results.append({
            "type": prompt_type,
            "memories": all_memories,
            "stats": all_stats,
            "chunk_count": len(chunks),
            "config": args.config,
        })

    # Write output to Obsidian
    output = format_output(session, results, db_path)
    OBSIDIAN_OUTPUT.write_text(output)
    print(f"\nOutput written to: {OBSIDIAN_OUTPUT}", file=sys.stderr)

    # Open in Obsidian
    os.system('open "obsidian://open?vault=Cortex&file=Aria/memory-extraction-output"')


if __name__ == "__main__":
    main()
