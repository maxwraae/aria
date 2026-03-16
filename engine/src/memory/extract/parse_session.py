#!/usr/bin/env python3
"""Parse a Claude Code .jsonl session into clean conversation text."""

import json
import re
import sys
import os


SYSTEM_REMINDER_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.DOTALL)

SKIP_TYPES = {"progress", "queue-operation", "file-history-snapshot", "system", "summary", "last-prompt"}

# Tool results from these tools are code operations — exclude them
CODE_TOOLS = {"Edit", "Write", "Bash", "Glob", "Grep"}

# Patterns in assistant text that indicate system boilerplate, not conversation
ASSISTANT_NOISE_PATTERNS = [
    re.compile(r"agent launched successfully", re.IGNORECASE),
    re.compile(r"agentId:", re.IGNORECASE),
    re.compile(r"output_file:", re.IGNORECASE),
    re.compile(r"run_in_background", re.IGNORECASE),
    re.compile(r"working in the background", re.IGNORECASE),
    re.compile(r"you will be notified automatically", re.IGNORECASE),
    re.compile(r"do not duplicate this agent", re.IGNORECASE),
]


def extract_tool_result_text(block: dict) -> str:
    """Extract useful text from a tool_result block, if it's from an information tool."""
    # The tool_result block has content (string or list) but no tool name directly.
    # We include it unless it looks like code output.
    result_content = block.get("content", "")
    if isinstance(result_content, str):
        text = result_content.strip()
    elif isinstance(result_content, list):
        parts = []
        for item in result_content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(item.get("text", ""))
        text = "\n".join(parts).strip()
    else:
        return ""

    if not text:
        return ""

    # Skip agent launch boilerplate in tool results
    if is_agent_boilerplate(text):
        return ""

    # Heuristic: skip results that look like code/command output
    # (starts with line numbers, contains lots of code patterns)
    lines = text.split("\n")
    if len(lines) > 3:
        # Check if most lines start with line numbers (Read tool output)
        numbered = sum(1 for l in lines[:10] if re.match(r'\s*\d+[→|│]', l))
        if numbered > len(lines[:10]) * 0.5:
            return ""  # This is file content with line numbers, skip

    # Skip very long results (probably file dumps or command output)
    if len(text) > 5000:
        return ""

    return text


def extract_user_text(content) -> str:
    """Extract text from a user message's content field."""
    if isinstance(content, str):
        return SYSTEM_REMINDER_RE.sub("", content).strip()

    if not isinstance(content, list):
        return ""

    parts = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            text = block.get("text", "")
            text = SYSTEM_REMINDER_RE.sub("", text).strip()
            if text:
                parts.append(text)
        elif block.get("type") == "tool_result":
            # Include tool results from information tools (mail, calendar, etc.)
            tool_text = extract_tool_result_text(block)
            if tool_text:
                parts.append(f"[Tool result]: {tool_text}")

    return "\n".join(parts)


def is_agent_boilerplate(text: str) -> bool:
    """Check if assistant text is mostly agent launch/system boilerplate."""
    matches = sum(1 for p in ASSISTANT_NOISE_PATTERNS if p.search(text))
    return matches >= 2  # Two or more noise patterns = boilerplate


def extract_assistant_text(content) -> str:
    """Extract text from an assistant message's content field."""
    if isinstance(content, str):
        if is_agent_boilerplate(content):
            return ""
        return content.strip()

    if not isinstance(content, list):
        return ""

    parts = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            text = block.get("text", "")
            if text.strip() and not is_agent_boilerplate(text):
                parts.append(text.strip())
        # Skip tool_use blocks (the calls themselves, not results)

    return "\n".join(parts)


def parse_session(jsonl_path: str) -> dict:
    """Parse a .jsonl session file into clean conversation text.

    Returns:
        {
            'filename': str,
            'messages': [{'role': 'user'|'assistant', 'text': str}],
            'text': str,
            'user_count': int,
            'assistant_count': int,
            'char_count': int,
            'token_estimate': int,
        }
    """
    messages = []
    user_count = 0
    assistant_count = 0

    with open(jsonl_path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue

            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            msg_type = obj.get("type", "")

            if msg_type in SKIP_TYPES:
                continue

            if msg_type == "user" and "message" in obj:
                content = obj["message"].get("content", "")
                text = extract_user_text(content)
                if text:
                    messages.append({"role": "user", "text": text})
                    user_count += 1

            elif msg_type == "assistant" and "message" in obj:
                content = obj["message"].get("content", "")
                text = extract_assistant_text(content)
                if text:
                    messages.append({"role": "assistant", "text": text})
                    assistant_count += 1

    # Build formatted text
    parts = []
    for msg in messages:
        label = "User" if msg["role"] == "user" else "Assistant"
        parts.append(f"{label}: {msg['text']}")

    text = "\n\n".join(parts)
    char_count = len(text)
    token_estimate = char_count // 4

    return {
        "filename": os.path.basename(jsonl_path),
        "messages": messages,
        "text": text,
        "user_count": user_count,
        "assistant_count": assistant_count,
        "char_count": char_count,
        "token_estimate": token_estimate,
    }


def main():
    if len(sys.argv) < 2:
        print("Usage: python parse_session.py <path_to_jsonl>", file=sys.stderr)
        sys.exit(1)

    path = sys.argv[1]
    if not os.path.exists(path):
        print(f"File not found: {path}", file=sys.stderr)
        sys.exit(1)

    result = parse_session(path)

    if result["char_count"] < 500:
        print(f"--- Session: {result['filename']} ---", file=sys.stderr)
        print(f"Skipped: too small ({result['char_count']} chars)", file=sys.stderr)
        sys.exit(0)

    print(f"--- Session: {result['filename']} ---")
    print(f"Messages: {result['user_count']} user, {result['assistant_count']} assistant")
    print(f"Clean text: {result['char_count']:,} chars (~{result['token_estimate']:,} tokens)")
    print()
    print(result["text"])


if __name__ == "__main__":
    main()
