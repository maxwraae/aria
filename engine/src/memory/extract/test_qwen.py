#!/usr/bin/env python3
"""Quick test of Qwen3 8B extraction on a real conversation chunk."""

from mlx_lm import load, generate
import json
import time

model, tokenizer = load("mlx-community/Qwen3-8B-4bit")

conversation = (
    "User: ive been making something i call flow documents which basically "
    "describe in words very specifically the logic behind code. it could be "
    "how let us say for messenger describing the full way of how messages "
    "are sent in words the logic and what and where files are etc. because "
    "that is easier for me to understand as i am not native in code but i "
    "am in logic\n\n"
    "Assistant: A few formal names for this depending on the angle. Technical "
    "Design Documents is the broadest match. Literate Programming is the "
    "closest intellectual ancestor, coined by Donald Knuth in 1984. The core "
    "idea: write the logic for humans first, code second.\n\n"
    "User: i want something where i can tell an ai system like you what i "
    "want to make and then you instantly know what i mean without me having "
    "to explain it\n\n"
    "Assistant: So you want a reference doc that defines what a flow document "
    "is, so when you say write a flow doc for the messaging system, I already "
    "know the structure, depth, and style you expect.\n\n"
    "User: Max is working on the Aria project which is an autonomous objective "
    "engine. It uses SQLite and runs on two machines, a MacBook Pro and a Mac "
    "mini. Henrik is his advisor at Copenhagen University. The Knud Hoejgaard "
    "grant was approved for 30000 DKK."
)

prompt_text = (
    "Extract facts and preferences from this conversation.\n"
    "Each observation must be a complete, self-contained sentence.\n"
    "No pronouns (he, she, they). No relative time (yesterday, tomorrow).\n"
    "Only extract from what the USER (Max) said, not the assistant.\n"
    "Return ONLY a valid JSON array.\n\n"
    '[{"content": "", "type": "world|identity|preference"}]\n\n'
    "CONVERSATION:\n" + conversation
)

messages = [{"role": "user", "content": prompt_text}]
prompt = tokenizer.apply_chat_template(
    messages, add_generation_prompt=True, enable_thinking=False, tokenize=False
)

start = time.time()
response = generate(model, tokenizer, prompt=prompt, max_tokens=500)
elapsed = time.time() - start

print(f"Time: {elapsed:.1f}s")
print(f"Response:\n{response}")

# Try to parse JSON
try:
    # Strip markdown fences if present
    clean = response.strip()
    if clean.startswith("```"):
        clean = clean.split("\n", 1)[1]
        clean = clean.rsplit("```", 1)[0]
    memories = json.loads(clean)
    print(f"\nParsed {len(memories)} memories:")
    for m in memories:
        print(f"  [{m.get('type', '?')}] {m.get('content', '?')}")
except json.JSONDecodeError as e:
    print(f"\nJSON parse failed: {e}")
