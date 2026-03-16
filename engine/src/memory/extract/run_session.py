#!/usr/bin/env python3
"""Run extraction on a single session and output JSON result to stdout.

Usage: python run_session.py <session_path> <label>
"""

import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from parse_session import parse_session

PROMPTS_DIR = Path(__file__).parent / "prompts"
MODEL_ID = "mlx-community/Qwen3-8B-4bit"
MAX_CHARS = 40000


def load_prompt(prompt_type):
    return (PROMPTS_DIR / f"{prompt_type}.txt").read_text()


def run_extraction(conversation_text, prompt_template, max_retries=2):
    from mlx_lm import load, stream_generate
    import mlx.core as mx

    print(f"  Loading model...", file=sys.stderr, flush=True)
    model, tokenizer = load(MODEL_ID)
    print(f"  Model loaded.", file=sys.stderr, flush=True)

    if len(conversation_text) > MAX_CHARS:
        print(f"  Truncating {len(conversation_text):,} -> {MAX_CHARS:,} chars", file=sys.stderr, flush=True)
        conversation_text = conversation_text[:MAX_CHARS] + "\n\n[TRUNCATED]"

    full_prompt = prompt_template + conversation_text
    messages = [{"role": "user", "content": full_prompt}]
    prompt = tokenizer.apply_chat_template(
        messages, add_generation_prompt=True, enable_thinking=False, tokenize=False
    )

    input_tokens = len(full_prompt) // 4

    for attempt in range(max_retries):
        start = time.time()
        first_token_time = None
        chunks = []

        try:
            for chunk in stream_generate(model, tokenizer, prompt=prompt, max_tokens=2000, prefill_step_size=8192):
                if first_token_time is None:
                    first_token_time = time.time()
                chunks.append(chunk.text if hasattr(chunk, 'text') else str(chunk))
        except Exception as e:
            print(f"  Generation error: {e}", file=sys.stderr, flush=True)
            return [], {"error": str(e), "attempt": attempt+1, "raw_response": "", "input_tokens": input_tokens, "output_tokens": 0, "prefill_time": 0, "gen_time": 0, "gen_tok_s": 0, "elapsed": time.time()-start}

        response = "".join(chunks)
        end = time.time()
        prefill_time = (first_token_time - start) if first_token_time else 0
        gen_time = (end - first_token_time) if first_token_time else 0
        output_tokens = len(chunks)
        gen_tok_s = output_tokens / gen_time if gen_time > 0 else 0

        stats = {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "prefill_time": prefill_time,
            "gen_time": gen_time,
            "gen_tok_s": gen_tok_s,
            "elapsed": end - start,
            "attempt": attempt + 1,
            "raw_response": response,
        }

        clean = response.strip()
        if clean.startswith("```"):
            clean = clean.split("\n", 1)[1] if "\n" in clean else clean[3:]
            clean = clean.rsplit("```", 1)[0]
        clean = clean.strip()

        try:
            memories = json.loads(clean)
            if isinstance(memories, list):
                mx.clear_cache()
                return memories, stats
        except json.JSONDecodeError:
            pass

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
            mx.clear_cache()
            return all_memories, stats

        if attempt < max_retries - 1:
            print(f"  JSON parse failed (attempt {attempt+1}), retrying...", file=sys.stderr, flush=True)
            mx.clear_cache()
            continue

        mx.clear_cache()
        return [], stats

    return [], stats


def main():
    session_path = sys.argv[1]
    label = sys.argv[2] if len(sys.argv) > 2 else "Unknown"

    session = parse_session(session_path)
    created_at = int(os.path.getmtime(session_path))

    result = {
        "label": label,
        "filename": session["filename"],
        "created_at": created_at,
        "user_count": session["user_count"],
        "assistant_count": session["assistant_count"],
        "char_count": session["char_count"],
        "token_estimate": session["token_estimate"],
        "extractions": []
    }

    for prompt_type in ["world", "preference"]:
        print(f"\n--- Extracting {prompt_type} ---", file=sys.stderr, flush=True)
        template = load_prompt(prompt_type)
        memories, stats = run_extraction(session["text"], template)
        print(f"  Got {len(memories)} memories", file=sys.stderr, flush=True)
        result["extractions"].append({
            "type": prompt_type,
            "memories": memories,
            "stats": stats
        })

    print(json.dumps(result))


if __name__ == "__main__":
    main()
