# Memory Extraction Pipeline

Batch pipeline that reads Claude Code conversation sessions from disk, sends them through Haiku for memory extraction, and writes the results to Aria's memories database. It tracks every session's processing state in a local SQLite database so runs are resumable and incremental — re-running only processes sessions that haven't been done yet.

---

## Running

```bash
# Activate the venv first
source .venv/bin/activate

# Run extraction (world type, 4 parallel sessions)
python run.py run --type world --parallel 4

# Run with a limit (useful for testing)
python run.py run --type world --parallel 4 --limit 20

# Retry sessions that errored on a previous run
python run.py run --type world --parallel 4 --retry-errors
```

The `--parallel` argument controls how many sessions are processed concurrently. Each session internally spawns up to 5 parallel Haiku calls (one per chunk). At `--parallel 4`, you can have up to 20 concurrent Haiku calls.

---

## Checking status

```bash
python run.py status
```

This shows session counts by status (pending / running / done / skipped / error), memory counts in `memories.db` broken down by type, and a summary of the last run including token counts and cost.

---

## Memory TUI

Terminal UI for browsing and searching the memory database. Shows extraction progress, memory counts by type, and lets you explore what Aria remembers.

```bash
python tui.py
```

**Views:**
- **Overview** — memory counts per type (world, max, people, friction, biology), extraction progress (sessions done/total), last run stats (cost, tokens)
- **Browse** — scroll through memories of a selected type, newest first. Enter on a memory shows full detail.
- **Search** — FTS5 search with the same BM25 + recency scoring Aria uses. See exactly what memories would surface for a given query.

**Key bindings:**

| Key | Overview | Browse | Search | Detail |
|-----|----------|--------|--------|--------|
| j/k or ↑↓ | Select type | Scroll | Scroll results | — |
| Enter | Browse type | View memory | Run search / View | — |
| s | Open search | — | — | — |
| q | Quit | Back | — | Back |
| Escape | — | — | Back to overview | — |
| Type | — | — | Build query | — |
| Backspace | — | — | Delete char | — |

---

## Resuming after rate limit

When the API rate limits, the pipeline stops immediately and prints `Rate limit hit. Stopping. Run again to resume.` Any sessions that were mid-flight get reset back to `pending`. Just run the same command again — it picks up where it left off.

```bash
python run.py run --type world --parallel 4
```

If you're consistently hitting rate limits, reduce `--parallel`.

---

## Prompts

Six prompts exist in `prompts/`. Each targets a different category of knowledge.

| Prompt | Status | What it extracts | Memory type |
|--------|--------|-----------------|-------------|
| `world.txt` | Active, tested | General facts about the world: grants, deadlines, organizations, technology, events. Things that were true before the conversation and will still be true after. | `world` |
| `max.txt` | Written, not tested | Facts about Max as a person: background, education, current situation, what he's working on and why. | (strings) |
| `people.txt` | Written, not tested | Facts about other people who appear in conversations: names, roles, relationships to Max, what they've done. | (strings) |
| `friction.txt` | Written, not tested | Moments where something went wrong: what the assistant did, why it landed badly, what the correct behavior would have been. | `friction` |
| `biology.txt` | Written, not tested | Biology and biotechnology knowledge: genes, proteins, techniques, experimental results, design decisions, mechanisms. | (strings) |
| `preference.txt` | Old, predates current system | — | — |

The `--type` argument passed to `run.py run` must match one of: `world`, `max`, `people`, `friction`, `biology`. Only `world` has been validated end-to-end.

---

## Where things live

| Path | What it is |
|------|-----------|
| `batch.db` | SQLite tracking database. Every session ever seen, its status, chunk/memory counts, token costs, error messages. Never deleted. |
| `~/Library/Mobile Documents/com~apple~CloudDocs/Aria/data/memories.db` | The output database. All extracted memories with content, type, source, and timestamp. Has an FTS5 virtual table (`memories_fts`) for keyword search. |
| `prompts/` | Prompt templates. One file per extraction type. |
| `~/.claude/projects/-Users-maxwraae/*.jsonl` | Source sessions. Claude Code conversation files. Never modified by this pipeline. |

---

## Dependencies

**Python virtual environment** — the pipeline uses the `anthropic` library indirectly via the CLI. Set up with:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt  # if present, otherwise just standard library
```

**Claude CLI** — Haiku is called via `claude -p --model haiku` as a subprocess. The CLI must be installed and authenticated. Test with:

```bash
claude -p --model haiku "hello"
```

**memories.db must exist** — the pipeline writes to the database but does not create it. Run `python create_tables.py` (or the Aria engine) to initialize the database before the first extraction run.
