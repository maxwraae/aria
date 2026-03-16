#!/usr/bin/env python3
"""Test 3 chunk size configurations on a session, output comparison to Obsidian."""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from parse_session import parse_session
from pipeline import chunk_conversation

SCRIPT_DIR = Path(__file__).parent
OBSIDIAN_OUTPUT = Path.home() / "Library/Mobile Documents/iCloud~md~obsidian/Documents/Cortex/Aria/chunk-size-test.md"

CHUNK_CONFIGS = [
    {"name": "Small",  "chunk_words": 750,  "overlap_words": 200},
    {"name": "Medium", "chunk_words": 1500, "overlap_words": 400},
    {"name": "Large",  "chunk_words": 3000, "overlap_words": 750},
]


def load_prompt_template() -> str:
    path = SCRIPT_DIR / "prompts" / "world-v2.txt"
    if not path.exists():
        print(f"Prompt file not found: {path}", file=sys.stderr)
        sys.exit(1)
    return path.read_text()


def call_haiku(full_prompt: str) -> tuple[list, float]:
    """Call Haiku with full_prompt. Returns (facts_list, elapsed_seconds)."""
    start = time.time()
    result = subprocess.run(
        ["claude", "-p", "--model", "haiku", "--allowedTools", ""],
        input=full_prompt,
        capture_output=True,
        text=True,
        timeout=120,
    )
    elapsed = time.time() - start
    response = result.stdout

    facts = parse_json_response(response)
    return facts, elapsed


def parse_json_response(response: str) -> list:
    """Parse JSON array of strings from model response. Returns list of strings."""
    clean = response.strip()

    # Strip code fences
    if clean.startswith("```"):
        clean = clean.split("\n", 1)[1] if "\n" in clean else clean[3:]
        clean = clean.rsplit("```", 1)[0]
    clean = clean.strip()

    # Direct parse
    try:
        parsed = json.loads(clean)
        if isinstance(parsed, list):
            return [str(item) if not isinstance(item, str) else item for item in parsed]
    except json.JSONDecodeError:
        pass

    # Line-by-line fallback
    all_facts = []
    for line in clean.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
            if isinstance(parsed, list):
                all_facts.extend(str(item) if not isinstance(item, str) else item for item in parsed)
            elif isinstance(parsed, str):
                all_facts.append(parsed)
        except json.JSONDecodeError:
            continue

    return all_facts


def run_config(config: dict, messages: list, prompt_template: str) -> dict:
    """Run extraction for one chunk config. Returns result dict."""
    name = config["name"]
    chunk_words = config["chunk_words"]
    overlap_words = config["overlap_words"]

    chunks = chunk_conversation(messages, chunk_words, overlap_words)
    print(f"\n[{name}] {len(chunks)} chunk(s) ({chunk_words}w chunk, {overlap_words}w overlap)", file=sys.stderr, flush=True)

    chunk_results = []
    total_start = time.time()

    for i, chunk_msgs in enumerate(chunks):
        chunk_text = "\n\n".join(m["text"] for m in chunk_msgs)
        wc = len(chunk_text.split())
        print(f"  Chunk {i+1}/{len(chunks)} ({wc}w)...", file=sys.stderr, flush=True)

        full_prompt = prompt_template + chunk_text + "\n</conversation>"
        facts, elapsed = call_haiku(full_prompt)

        print(f"  -> {len(facts)} facts in {elapsed:.1f}s", file=sys.stderr, flush=True)
        chunk_results.append({
            "index": i + 1,
            "word_count": wc,
            "elapsed": elapsed,
            "facts": facts,
        })

    total_elapsed = time.time() - total_start

    return {
        "name": name,
        "chunk_words": chunk_words,
        "overlap_words": overlap_words,
        "chunks": chunk_results,
        "total_elapsed": total_elapsed,
    }


def format_output(session: dict, config_results: list) -> str:
    lines = []
    lines.append("# Chunk Size Test")
    lines.append("")
    lines.append(f"**Session:** `{session['filename']}`")
    lines.append(f"**Messages:** {session['user_count']} user, {session['assistant_count']} assistant")
    lines.append(f"**Clean text:** {session['char_count']:,} chars")
    lines.append("")

    summary_rows = []

    for res in config_results:
        name = res["name"]
        chunk_words = res["chunk_words"]
        overlap_words = res["overlap_words"]
        chunks = res["chunks"]
        total_facts = sum(len(c["facts"]) for c in chunks)
        total_time = res["total_elapsed"]
        facts_per_chunk = total_facts / len(chunks) if chunks else 0.0

        lines.append("---")
        lines.append("")
        lines.append(f"## {name} ({chunk_words}w chunk, {overlap_words}w overlap)")
        lines.append("")
        lines.append(f"**Chunks:** {len(chunks)} | **Total facts:** {total_facts} | **Time:** {total_time:.0f}s")
        lines.append("")

        for chunk in chunks:
            lines.append(f"### Chunk {chunk['index']} ({chunk['word_count']}w, {chunk['elapsed']:.1f}s)")
            if chunk["facts"]:
                for j, fact in enumerate(chunk["facts"], 1):
                    lines.append(f"{j}. {fact}")
            else:
                lines.append("*No facts extracted.*")
            lines.append("")

        summary_rows.append({
            "name": name,
            "chunks": len(chunks),
            "facts": total_facts,
            "time": total_time,
            "facts_per_chunk": facts_per_chunk,
        })

    lines.append("---")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append("| Config | Chunks | Facts | Time | Facts/chunk |")
    lines.append("|--------|--------|-------|------|-------------|")
    for row in summary_rows:
        lines.append(
            f"| {row['name']} | {row['chunks']} | {row['facts']} | {row['time']:.0f}s | {row['facts_per_chunk']:.1f} |"
        )

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Test chunk size configurations on a session")
    parser.add_argument("--session", required=True, help="Path to .jsonl session file")
    args = parser.parse_args()

    print(f"Parsing session: {args.session}", file=sys.stderr)
    session = parse_session(args.session)

    if session["char_count"] < 500:
        print(f"Session too small ({session['char_count']} chars), skipping.", file=sys.stderr)
        sys.exit(0)

    print(f"Session: {session['filename']}", file=sys.stderr)
    print(f"Messages: {session['user_count']} user, {session['assistant_count']} assistant", file=sys.stderr)
    print(f"Clean text: {session['char_count']:,} chars", file=sys.stderr)

    prompt_template = load_prompt_template()

    config_results = []
    for config in CHUNK_CONFIGS:
        result = run_config(config, session["messages"], prompt_template)
        config_results.append(result)

    output = format_output(session, config_results)

    OBSIDIAN_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OBSIDIAN_OUTPUT.write_text(output)
    print(f"\nOutput written to: {OBSIDIAN_OUTPUT}", file=sys.stderr)

    os.system('open "obsidian://open?vault=Cortex&file=Aria/chunk-size-test"')


if __name__ == "__main__":
    main()
