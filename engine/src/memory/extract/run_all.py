#!/usr/bin/env python3
"""Orchestrator: run run_session.py for each session as separate subprocess.

Each subprocess gets a fresh Python + Metal context, avoiding OOM accumulation.
Between runs, clears MLX Metal cache by running a tiny import.
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
VENV_PYTHON = SCRIPT_DIR / ".venv/bin/python3"
RUN_SCRIPT = SCRIPT_DIR / "run_session.py"
OBSIDIAN_OUTPUT = Path.home() / "Library/Mobile Documents/iCloud~md~obsidian/Documents/Cortex/Aria/memory-extraction-samples.md"

SESSIONS = [
    (
        "~/.claude/projects/-Users-maxwraae/8722942a-936d-49bd-872f-7cf10647d4c6.jsonl",
        "Boston trip prep & J-1 insurance (51u 42a)"
    ),
    (
        "~/.claude/projects/-Users-maxwraae/fca86ec9-5424-4afe-966b-e2ceede70c7f.jsonl",
        "Knud Højgaard grant approved, finance (8u 12a)"
    ),
    (
        "~/.claude/projects/-Users-maxwraae/0b2812b9-eccb-4b17-9957-0f4d883e3426.jsonl",
        "iCloud migration / Jarvis setup (30u 43a)"
    ),
    (
        "~/.claude/projects/-Users-maxwraae/9a62df60-e255-45df-989e-861038705aef.jsonl",
        "Aria contract design thinking (31u 61a)"
    ),
    (
        "~/.claude/projects/-Users-maxwraae/5002d83a-54f6-47bc-ab57-7f018607a748.jsonl",
        "aiMessage product discussion (27u 53a)"
    ),
]


def clear_metal_cache():
    """Run a subprocess that imports MLX to trigger Metal cache release."""
    print("Clearing Metal cache...", file=sys.stderr, flush=True)
    result = subprocess.run(
        [str(VENV_PYTHON), "-c", "import mlx.core as mx; mx.clear_cache(); import gc; gc.collect(); print('cleared')"],
        capture_output=True, text=True, timeout=30
    )
    print(f"  {result.stdout.strip()} {result.stderr.strip()[:80]}", file=sys.stderr, flush=True)
    time.sleep(3)  # give OS time to reclaim pages


def get_memory_mb():
    """Return free+inactive memory in MB."""
    try:
        result = subprocess.run(["vm_stat"], capture_output=True, text=True)
        page_size = 16384
        free = inactive = 0
        for line in result.stdout.splitlines():
            if "Pages free" in line:
                val = int(line.split(":")[1].strip().rstrip("."))
                free = val * page_size / 1024 / 1024
            elif "Pages inactive" in line:
                val = int(line.split(":")[1].strip().rstrip("."))
                inactive = val * page_size / 1024 / 1024
        return free + inactive
    except Exception:
        return 0


def run_session(path_str, label):
    """Run run_session.py as subprocess and return parsed result."""
    path = os.path.expanduser(path_str)
    if not os.path.exists(path):
        print(f"  File not found: {path}", file=sys.stderr, flush=True)
        return None

    print(f"\nRunning: {label}", file=sys.stderr, flush=True)
    avail = get_memory_mb()
    print(f"Available memory: {avail:.0f} MB", file=sys.stderr, flush=True)

    start = time.time()
    result = subprocess.run(
        [str(VENV_PYTHON), str(RUN_SCRIPT), path, label],
        capture_output=True, text=True, timeout=600
    )
    elapsed = time.time() - start

    print(f"Subprocess stderr:\n{result.stderr}", file=sys.stderr, flush=True)

    if result.returncode != 0:
        print(f"  FAILED (exit {result.returncode}) after {elapsed:.0f}s", file=sys.stderr, flush=True)
        return {"error": f"exit code {result.returncode}", "label": label, "filename": os.path.basename(path)}

    try:
        data = json.loads(result.stdout.strip())
        print(f"  OK in {elapsed:.0f}s", file=sys.stderr, flush=True)
        return data
    except json.JSONDecodeError as e:
        print(f"  JSON decode error: {e}", file=sys.stderr, flush=True)
        print(f"  stdout: {result.stdout[:200]}", file=sys.stderr, flush=True)
        return {"error": f"json parse: {e}", "label": label, "filename": os.path.basename(path)}


def format_output(all_data):
    lines = []
    lines.append("# Memory Extraction Samples")
    lines.append("")
    lines.append("5 sessions tested with Qwen3 8B Q4. Review extracted memories — note what's good, what's missing, what's wrong.")
    lines.append("")
    lines.append(f"*Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}*")
    lines.append("")

    for i, data in enumerate(all_data, 1):
        lines.append("---")
        lines.append("")

        if data is None or "error" in data:
            err = data.get("error", "unknown") if data else "skipped"
            label = data.get("label", f"Session {i}") if data else f"Session {i}"
            lines.append(f"## Session {i}: {label}")
            lines.append(f"**Status:** ERROR — {err}")
            lines.append("")
            continue

        date_str = datetime.fromtimestamp(data["created_at"]).strftime("%Y-%m-%d %H:%M")
        total = sum(len(e["memories"]) for e in data.get("extractions", []))

        lines.append(f"## Session {i}: {data['label']}")
        lines.append(f"**File:** `{data['filename']}`  ")
        lines.append(f"**Date:** {date_str} | **Messages:** {data['user_count']} user, {data['assistant_count']} assistant | **Text:** {data['char_count']:,} chars (~{data['token_estimate']:,} tokens)  ")
        lines.append(f"**Total extracted:** {total} memories")
        lines.append("")

        for ext in data.get("extractions", []):
            ptype = ext["type"]
            memories = ext["memories"]
            stats = ext["stats"]

            lines.append(f"### {ptype.title()} Facts")

            if "error" in stats:
                lines.append(f"*Error: {stats['error']}*")
            else:
                lines.append(f"*{stats['input_tokens']:,} in + {stats['output_tokens']:,} out | prefill {stats.get('prefill_time',0):.1f}s + gen {stats.get('gen_time',0):.1f}s ({stats.get('gen_tok_s',0):.1f} tok/s) | total {stats['elapsed']:.1f}s | attempt {stats['attempt']}*")
            lines.append("")

            if memories:
                for mem in memories:
                    if isinstance(mem, dict):
                        lines.append(f"- **[{mem.get('type','?')}]** {mem.get('content','?')}")
                    else:
                        lines.append(f"- {mem}")
                lines.append("")
                lines.append(f"*{len(memories)} {ptype} memories extracted*")
            else:
                lines.append("*No memories extracted.*")
            lines.append("")

            lines.append("<details><summary>Raw model output</summary>")
            lines.append("")
            lines.append("```")
            lines.append(stats.get("raw_response", "(no response)")[:3000])
            lines.append("```")
            lines.append("</details>")
            lines.append("")

    lines.append("---")
    total_all = sum(
        sum(len(e["memories"]) for e in d.get("extractions", []))
        for d in all_data if d and "error" not in d
    )
    successful = sum(1 for d in all_data if d and "error" not in d)
    lines.append(f"**Grand total: {total_all} memories extracted across {successful}/{len(all_data)} sessions**")

    return "\n".join(lines)


if __name__ == "__main__":
    all_data = []

    for i, (path_str, label) in enumerate(SESSIONS):
        # Clear Metal memory between sessions
        if i > 0:
            clear_metal_cache()
            avail = get_memory_mb()
            print(f"Memory after clear: {avail:.0f} MB", file=sys.stderr, flush=True)

        data = run_session(path_str, label)
        all_data.append(data)

        # Write intermediate output
        output = format_output(all_data)
        OBSIDIAN_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OBSIDIAN_OUTPUT.write_text(output)
        print(f"\nOutput updated ({i+1}/{len(SESSIONS)})", file=sys.stderr, flush=True)

    print(f"\nAll done! Output: {OBSIDIAN_OUTPUT}", file=sys.stderr, flush=True)
    os.system('open "obsidian://open?vault=Cortex&file=Aria/memory-extraction-samples"')
