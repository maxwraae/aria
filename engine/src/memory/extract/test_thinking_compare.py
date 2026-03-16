#!/usr/bin/env python3
"""Compare thinking vs no-thinking extraction, output to Obsidian for review."""

import time
import json
import re
import sys
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent))
from parse_session import parse_session
from pipeline import chunk_conversation, CHUNK_CONFIGS, load_prompt

SESSION = Path.home() / ".claude/projects/-Users-maxwraae/0c03732d-292c-49b3-84d4-5b6472d1d901.jsonl"
THINKING_BUDGET = 1000  # tokens
OBSIDIAN_OUT = Path.home() / "Library/Mobile Documents/iCloud~md~obsidian/Documents/Cortex/Aria/thinking-comparison.md"

import os


def parse_mems(resp):
    clean = re.sub(r"<think>.*?</think>", "", resp, flags=re.DOTALL).strip()
    if clean.startswith("```"):
        clean = clean.split("\n", 1)[1] if "\n" in clean else clean[3:]
        clean = clean.rsplit("```", 1)[0]
    clean = clean.strip()
    try:
        r = json.loads(clean)
        if isinstance(r, list):
            return r
    except:
        pass
    mems = []
    for line in clean.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            p = json.loads(line)
            if isinstance(p, list):
                mems.extend(p)
            elif isinstance(p, dict):
                mems.append(p)
        except:
            continue
    return mems


def run_no_thinking(model, tokenizer, full_prompt):
    from mlx_lm import stream_generate

    msgs = [{"role": "user", "content": full_prompt}]
    p = tokenizer.apply_chat_template(msgs, add_generation_prompt=True, enable_thinking=False, tokenize=False)

    t0 = time.time()
    first = None
    toks = []
    for tok in stream_generate(model, tokenizer, prompt=p, max_tokens=2000, prefill_step_size=8192):
        if first is None:
            first = time.time()
        toks.append(tok.text if hasattr(tok, "text") else str(tok))

    resp = "".join(toks)
    elapsed = time.time() - t0
    prefill = (first - t0) if first else 0
    gen = elapsed - prefill

    return {
        "response": resp,
        "memories": parse_mems(resp),
        "prefill": prefill,
        "gen": gen,
        "total": elapsed,
        "tok_s": len(toks) / gen if gen > 0 else 0,
        "thinking": "",
    }


def run_budget_thinking(model, tokenizer, full_prompt):
    from mlx_lm import stream_generate

    msgs = [{"role": "user", "content": full_prompt}]
    p = tokenizer.apply_chat_template(msgs, add_generation_prompt=True, enable_thinking=True, tokenize=False)

    # Phase 1: think
    t0 = time.time()
    toks = []
    for tok in stream_generate(model, tokenizer, prompt=p, max_tokens=THINKING_BUDGET + 100, prefill_step_size=8192):
        toks.append(tok.text if hasattr(tok, "text") else str(tok))

    phase1 = "".join(toks)
    phase1_time = time.time() - t0

    think_match = re.search(r"<think>(.*?)</think>", phase1, re.DOTALL)
    if think_match:
        thinking = think_match.group(1).strip()
    else:
        idx = phase1.find("<think>")
        thinking = phase1[idx + 7 :].strip() if idx >= 0 else ""

    # Phase 2: extract with thinking injected
    aug = f"Here are your initial thoughts:\n{thinking}\n\nNow extract the facts.\n{full_prompt}"
    msgs2 = [{"role": "user", "content": aug}]
    p2 = tokenizer.apply_chat_template(msgs2, add_generation_prompt=True, enable_thinking=False, tokenize=False)

    t0 = time.time()
    toks2 = []
    for tok in stream_generate(model, tokenizer, prompt=p2, max_tokens=2000, prefill_step_size=8192):
        toks2.append(tok.text if hasattr(tok, "text") else str(tok))

    resp = "".join(toks2)
    phase2_time = time.time() - t0

    return {
        "response": resp,
        "memories": parse_mems(resp),
        "phase1_time": phase1_time,
        "phase2_time": phase2_time,
        "total": phase1_time + phase2_time,
        "tok_s": len(toks2) / phase2_time if phase2_time > 0 else 0,
        "thinking": thinking,
        "thinking_words": len(thinking.split()),
    }


def main():
    from mlx_lm import load

    print("Loading model...", flush=True)
    model, tokenizer = load("mlx-community/Qwen3-8B-4bit")
    print("Model loaded.", flush=True)

    # Get 3 chunks to test on
    session = parse_session(str(SESSION))
    cfg = CHUNK_CONFIGS["a"]
    chunks = chunk_conversation(session["messages"], cfg["chunk_words"], cfg["overlap_words"])
    template = load_prompt("world")

    test_chunks = [chunks[0], chunks[2], chunks[5]] if len(chunks) > 5 else chunks[:3]

    lines = []
    lines.append("# Thinking vs No-Thinking Comparison")
    lines.append("")
    lines.append(f"*{datetime.now().strftime('%Y-%m-%d %H:%M')}*")
    lines.append(f"**Model:** Qwen3 8B Q4 | **Thinking budget:** {THINKING_BUDGET} tokens | **Chunks tested:** {len(test_chunks)}")
    lines.append("")

    totals_a = {"time": 0, "mems": 0}
    totals_c = {"time": 0, "mems": 0}

    for i, chunk_msgs in enumerate(test_chunks):
        chunk_text = "\n\n".join(
            f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['text']}" for m in chunk_msgs
        )
        full = template + chunk_text
        words = len(chunk_text.split())

        print(f"\nChunk {i+1}/{len(test_chunks)} ({words} words)...", flush=True)

        lines.append("---")
        lines.append(f"## Chunk {i+1} ({words} words)")
        lines.append("")

        # Show input preview
        lines.append("<details><summary>Input preview (first 500 chars)</summary>")
        lines.append("")
        lines.append(f"```\n{chunk_text[:500]}\n```")
        lines.append("")
        lines.append("</details>")
        lines.append("")

        # Run A
        print("  Running A (no thinking)...", flush=True)
        a = run_no_thinking(model, tokenizer, full)
        totals_a["time"] += a["total"]
        totals_a["mems"] += len(a["memories"])

        # Run C
        print("  Running C (budget thinking)...", flush=True)
        c = run_budget_thinking(model, tokenizer, full)
        totals_c["time"] += c["total"]
        totals_c["mems"] += len(c["memories"])

        # Write comparison
        lines.append("### No Thinking")
        lines.append(f"*{a['total']:.1f}s | {a['tok_s']:.0f} tok/s*")
        lines.append("")
        for m in a["memories"]:
            content = m.get("content", m) if isinstance(m, dict) else m
            lines.append(f"- {content}")
        if not a["memories"]:
            lines.append("*(no memories)*")
        lines.append("")

        lines.append("### Budget Thinking")
        lines.append(f"*{c['total']:.1f}s (think: {c.get('phase1_time',0):.1f}s + extract: {c.get('phase2_time',0):.1f}s) | {c['tok_s']:.0f} tok/s*")
        lines.append("")

        if c.get("thinking"):
            lines.append(f"**Thinking ({c.get('thinking_words',0)} words):**")
            lines.append(f"> {c['thinking'][:500]}{'...' if len(c.get('thinking','')) > 500 else ''}")
            lines.append("")

        for m in c["memories"]:
            content = m.get("content", m) if isinstance(m, dict) else m
            lines.append(f"- {content}")
        if not c["memories"]:
            lines.append("*(no memories)*")
        lines.append("")

    # Summary
    lines.append("---")
    lines.append("## Summary")
    lines.append("")
    lines.append(f"| | No Thinking | Budget Thinking |")
    lines.append(f"|---|---|---|")
    lines.append(f"| Total time | {totals_a['time']:.1f}s | {totals_c['time']:.1f}s |")
    lines.append(f"| Total memories | {totals_a['mems']} | {totals_c['mems']} |")
    lines.append(f"| Avg per chunk | {totals_a['mems']/len(test_chunks):.1f} | {totals_c['mems']/len(test_chunks):.1f} |")
    speedup = totals_c["time"] / totals_a["time"] if totals_a["time"] > 0 else 0
    lines.append(f"| Speed ratio | 1x | {speedup:.1f}x slower |")

    output = "\n".join(lines)
    OBSIDIAN_OUT.write_text(output)
    print(f"\nOutput: {OBSIDIAN_OUT}")
    os.system('open "obsidian://open?vault=Cortex&file=Aria/thinking-comparison"')


if __name__ == "__main__":
    main()
