#!/usr/bin/env python3
"""Test thinking budget approaches for Qwen3 8B extraction.

Compares three approaches on the same conversation chunk:
A) No thinking (enable_thinking=False)
B) Full thinking (enable_thinking=True, unlimited)
C) Budget thinking (think for N tokens, then re-prompt without thinking)

Outputs timing and quality for each.
"""

import time
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from parse_session import parse_session
from pipeline import chunk_conversation, CHUNK_CONFIGS, load_prompt

# Use a real session
SESSION = Path.home() / ".claude/projects/-Users-maxwraae/0c03732d-292c-49b3-84d4-5b6472d1d901.jsonl"
THINKING_BUDGET_TOKENS = 200  # how many tokens of thinking to allow in approach C

def get_chunk():
    session = parse_session(str(SESSION))
    cfg = CHUNK_CONFIGS["a"]
    chunks = chunk_conversation(session["messages"], cfg["chunk_words"], cfg["overlap_words"])
    # Pick chunk 3 (usually has some substance)
    chunk = chunks[min(2, len(chunks)-1)]
    text = "\n\n".join(
        f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['text']}" for m in chunk
    )
    return text

def parse_memories(response):
    """Extract memories from model response, stripping think tags and markdown."""
    # Strip thinking
    clean = re.sub(r"<think>.*?</think>", "", response, flags=re.DOTALL).strip()
    # Strip markdown fences
    if clean.startswith("```"):
        clean = clean.split("\n", 1)[1] if "\n" in clean else clean[3:]
        clean = clean.rsplit("```", 1)[0]
    clean = clean.strip()
    try:
        result = json.loads(clean)
        if isinstance(result, list):
            return result
    except json.JSONDecodeError:
        pass
    # Try line-by-line
    all_mems = []
    for line in clean.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
            if isinstance(parsed, list):
                all_mems.extend(parsed)
            elif isinstance(parsed, dict):
                all_mems.append(parsed)
        except json.JSONDecodeError:
            continue
    return all_mems

def run_approach_a(chunk_text, template, model, tokenizer):
    """No thinking."""
    from mlx_lm import stream_generate

    messages = [{"role": "user", "content": template + chunk_text}]
    prompt = tokenizer.apply_chat_template(messages, add_generation_prompt=True, enable_thinking=False, tokenize=False)

    start = time.time()
    first_tok = None
    tokens = []
    for tok in stream_generate(model, tokenizer, prompt=prompt, max_tokens=2000, prefill_step_size=8192):
        if first_tok is None:
            first_tok = time.time()
        tokens.append(tok.text if hasattr(tok, 'text') else str(tok))

    response = "".join(tokens)
    elapsed = time.time() - start
    prefill = (first_tok - start) if first_tok else 0
    gen = elapsed - prefill

    memories = parse_memories(response)
    return {
        "approach": "A: No thinking",
        "memories": memories,
        "count": len(memories),
        "prefill": prefill,
        "gen": gen,
        "total": elapsed,
        "tok_s": len(tokens) / gen if gen > 0 else 0,
        "thinking_text": "",
    }

def run_approach_b(chunk_text, template, model, tokenizer):
    """Full thinking (unlimited)."""
    from mlx_lm import stream_generate

    messages = [{"role": "user", "content": template + chunk_text}]
    prompt = tokenizer.apply_chat_template(messages, add_generation_prompt=True, enable_thinking=True, tokenize=False)

    start = time.time()
    first_tok = None
    tokens = []
    for tok in stream_generate(model, tokenizer, prompt=prompt, max_tokens=4000, prefill_step_size=8192):
        if first_tok is None:
            first_tok = time.time()
        tokens.append(tok.text if hasattr(tok, 'text') else str(tok))

    response = "".join(tokens)
    elapsed = time.time() - start
    prefill = (first_tok - start) if first_tok else 0
    gen = elapsed - prefill

    # Extract thinking
    think_match = re.search(r"<think>(.*?)</think>", response, re.DOTALL)
    thinking_text = think_match.group(1).strip() if think_match else ""

    memories = parse_memories(response)
    return {
        "approach": "B: Full thinking",
        "memories": memories,
        "count": len(memories),
        "prefill": prefill,
        "gen": gen,
        "total": elapsed,
        "tok_s": len(tokens) / gen if gen > 0 else 0,
        "thinking_text": thinking_text,
        "thinking_tokens": len(thinking_text.split()),
    }

def run_approach_c(chunk_text, template, model, tokenizer):
    """Budget thinking: think for N tokens, then re-prompt without thinking."""
    from mlx_lm import stream_generate

    # Phase 1: Let model think, capture first N tokens
    messages = [{"role": "user", "content": template + chunk_text}]
    prompt = tokenizer.apply_chat_template(messages, add_generation_prompt=True, enable_thinking=True, tokenize=False)

    start_phase1 = time.time()
    tokens = []
    for tok in stream_generate(model, tokenizer, prompt=prompt, max_tokens=THINKING_BUDGET_TOKENS + 100, prefill_step_size=8192):
        tokens.append(tok.text if hasattr(tok, 'text') else str(tok))

    phase1_response = "".join(tokens)
    phase1_time = time.time() - start_phase1

    # Extract whatever thinking we got
    think_match = re.search(r"<think>(.*?)</think>", phase1_response, re.DOTALL)
    if think_match:
        thinking_text = think_match.group(1).strip()
    else:
        # Thinking didn't close, take everything after <think>
        think_start = phase1_response.find("<think>")
        if think_start >= 0:
            thinking_text = phase1_response[think_start + 7:].strip()
        else:
            thinking_text = ""

    # Phase 2: Re-prompt with thinking injected, no thinking mode
    augmented_prompt = f"""Here are some initial thoughts about what facts are in this conversation:
{thinking_text}

Now extract the facts. {template}{chunk_text}"""

    messages2 = [{"role": "user", "content": augmented_prompt}]
    prompt2 = tokenizer.apply_chat_template(messages2, add_generation_prompt=True, enable_thinking=False, tokenize=False)

    start_phase2 = time.time()
    tokens2 = []
    for tok in stream_generate(model, tokenizer, prompt=prompt2, max_tokens=2000, prefill_step_size=8192):
        tokens2.append(tok.text if hasattr(tok, 'text') else str(tok))

    response2 = "".join(tokens2)
    phase2_time = time.time() - start_phase2

    total = phase1_time + phase2_time

    memories = parse_memories(response2)
    return {
        "approach": f"C: Budget thinking ({THINKING_BUDGET_TOKENS} tok)",
        "memories": memories,
        "count": len(memories),
        "phase1_time": phase1_time,
        "phase2_time": phase2_time,
        "total": total,
        "tok_s": len(tokens2) / phase2_time if phase2_time > 0 else 0,
        "thinking_text": thinking_text,
        "thinking_tokens": len(thinking_text.split()),
    }


def main():
    from mlx_lm import load

    print("Loading model...", flush=True)
    model, tokenizer = load("mlx-community/Qwen3-8B-4bit")
    print("Model loaded.", flush=True)

    chunk_text = get_chunk()
    template = load_prompt("world")
    word_count = len(chunk_text.split())
    print(f"\nChunk: {word_count} words")
    print(f"Preview: {chunk_text[:200]}...")
    print()

    # Run all three
    results = []

    print("=" * 60)
    print("Approach A: No thinking")
    print("=" * 60)
    r = run_approach_a(chunk_text, template, model, tokenizer)
    results.append(r)
    print(f"Time: {r['total']:.1f}s | Memories: {r['count']} | Speed: {r['tok_s']:.0f} tok/s")
    for m in r["memories"][:5]:
        content = m.get("content", m) if isinstance(m, dict) else m
        print(f"  - {content}")
    print()

    print("=" * 60)
    print("Approach B: Full thinking (unlimited)")
    print("=" * 60)
    r = run_approach_b(chunk_text, template, model, tokenizer)
    results.append(r)
    print(f"Time: {r['total']:.1f}s | Memories: {r['count']} | Speed: {r['tok_s']:.0f} tok/s")
    print(f"Thinking: {r.get('thinking_tokens', 0)} words")
    if r["thinking_text"]:
        print(f"Thinking preview: {r['thinking_text'][:200]}...")
    for m in r["memories"][:5]:
        content = m.get("content", m) if isinstance(m, dict) else m
        print(f"  - {content}")
    print()

    print("=" * 60)
    print(f"Approach C: Budget thinking ({THINKING_BUDGET_TOKENS} tokens)")
    print("=" * 60)
    r = run_approach_c(chunk_text, template, model, tokenizer)
    results.append(r)
    print(f"Time: {r['total']:.1f}s (phase1: {r.get('phase1_time',0):.1f}s + phase2: {r.get('phase2_time',0):.1f}s)")
    print(f"Memories: {r['count']} | Speed: {r['tok_s']:.0f} tok/s")
    print(f"Thinking captured: {r.get('thinking_tokens', 0)} words")
    if r["thinking_text"]:
        print(f"Thinking preview: {r['thinking_text'][:200]}...")
    for m in r["memories"][:5]:
        content = m.get("content", m) if isinstance(m, dict) else m
        print(f"  - {content}")
    print()

    # Summary
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"{'Approach':<35} {'Time':>6} {'Memories':>8} {'tok/s':>6}")
    print("-" * 60)
    for r in results:
        print(f"{r['approach']:<35} {r['total']:>5.1f}s {r['count']:>8} {r['tok_s']:>5.0f}")


if __name__ == "__main__":
    main()
