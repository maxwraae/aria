# Prompt Engineering Workflow

How Max and Jarvis iterate on Aria's behaviour together.

## The files that control behaviour

| File | What it does | Tokens |
|------|-------------|--------|
| `contract/contract.md` | The ARIA loop. How agents think, observe/analyze/act, all CLI commands, tree philosophy. The main behavioural document. | ~4,500 |
| `focus/focus.md` | Last thing the agent reads before responding. The kicker — "do I have the knowledge to act?" | Small |
| `persona/persona.md` | Identity. "You are Aria." | ~20 |
| `never/never.md` | Hard prohibitions. No rm, no push, no external messages, no installs. | ~100 |
| `environment/environment.md` | Shared infrastructure — accounts, vault paths, NAS, tools. | ~300 |
| `environment/environment-macbook.md` | MacBook-specific context. | ~100 |
| `objective/objective.md` | Template for the objective block. Placeholders filled from DB. | Small |

Dynamic bricks (parents, siblings, children, similar, memories, conversation) are code-only in their `index.ts` — no .md to edit. To change their format, edit the code.

## Assembly order

```
PERSONA → CONTRACT → ENVIRONMENT → OBJECTIVE → PARENTS → SIBLINGS → CHILDREN → SIMILAR_RESOLVED → MEMORIES → CONVERSATION → NEVER → FOCUS
```

Separated by `\n\n---\n\n`. Null bricks are silently dropped.

## The loop

1. Max triggers something in Aria (create objective, send message, use the surface UI)
2. Max sees the response and tells Jarvis the objective ID + what felt off
3. Jarvis reads what happened:
   - `aria inbox <id>` — full conversation
   - `aria context <id>` — the assembled prompt it would see now
   - `/tmp/aria-engine.log` — engine log (spawns, model selection, CLI calls)
4. We discuss what to change
5. Jarvis edits the `.md` file — Max sees it update in Obsidian
6. Max tests again with a fresh objective: `aria create "same objective" "same instructions"`

## Why fresh objectives for each test

No prior conversation contaminating the result. Clean slate = clean A/B comparison of prompt changes. Same objective text, same instructions, different prompt behind it.

## Where responses live

- `inbox` table in macbook.db — agent responses stored with `type = "reply"`, `sender = objective's own ID`
- `aria inbox <id>` to read from CLI
- Surface UI shows it live

## Config dials

`~/.aria/context.json` controls token budgets per brick. Key ones:
- `conversation.max_tokens.{opus|sonnet|haiku}` — how much conversation history
- `memories.max_results` / `memories.max_tokens` — memory retrieval
- `children.max_tokens` / `children.max_tokens_per_child` — subtree visibility

## Model selection

- Objective has explicit model set → use that
- Any unprocessed message from Max → opus
- Otherwise → sonnet

---

## Simulation (`aria sim`)

Test how an agent behaves against a scenario without touching the real DB.

**Code:** `engine/src/sim.ts`

**Run:**
```bash
aria sim --objective "..." --message "max: ..."
aria sim --scenario path/to/scenario.json
```

**Output:** Clean markdown report saved to:
```
engine/src/context/bricks/sim/<objective-slug>.md
```

Override with `--output path/to/file.md`.

**Report structure:**
- **Message** — the agent's actual reply text (what it said)
- **Decision** — final status + what it's waiting on
- **Children spawned** — each child numbered, with the full instructions the parent wrote for it

**Scenario file format:**
```json
{
  "objective": "Find a cure for cancer",
  "description": "optional context",
  "messages": [
    { "role": "max", "message": "go" },
    { "role": "child", "name": "Research child name", "message": "[resolved] Found X..." },
    { "role": "parent", "message": "Keep me updated." },
    { "role": "sibling", "name": "Sibling name", "message": "FYI..." }
  ]
}
```

**What it tests:** The full loop — same prompt as production (all bricks assembled), same model selection, real aria CLI calls against an isolated temp DB. Nothing persists after the run.

**Use it to:** Test contract changes, verify orient/act behavior at different abstraction levels, check how the agent handles specific child results, run the same scenario multiple times to see variance.
