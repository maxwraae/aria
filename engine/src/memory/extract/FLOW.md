# Memory Extraction Pipeline

This is the flow of what happens when you run `python run.py run --type world --parallel 4`.

## Startup and state initialization

`run.py` is the entry point. `main()` parses the command and dispatches to `cmd_run()`. The first thing `cmd_run()` does is open `batch.db` (the SQLite tracking database sitting next to `run.py` in the extract directory), call `setup_db()` to create the `sessions` and `runs` tables if they don't exist, then immediately call `populate_sessions()`.

`populate_sessions()` scans `~/.claude/projects/-Users-maxwraae/*.jsonl` — every Claude Code conversation session file on disk — and inserts any new filenames into the `sessions` table with status `pending`. Sessions already in the table are left alone (INSERT OR IGNORE). If there's a legacy `batch_state.json` from the old tracking system, it gets migrated now: sessions marked done or skipped in the JSON get their status updated in SQLite, and the file is renamed to `batch_state.json.migrated` so migration only runs once.

Back in `cmd_run()`, the prompt template is loaded. `load_prompt("world")` reads `prompts/world.txt` into a string. If the file doesn't exist, it exits immediately with an error message. The template is a plain text prompt that will wrap each conversation chunk before it gets sent to Haiku.

A SIGINT handler is installed. If you press Ctrl-C, a threading Event (`shutdown_flag`) gets set rather than killing the process immediately. The pipeline finishes whatever session it's currently writing to the database, then stops cleanly.

A row is inserted into the `runs` table to record this run — prompt type, parallelism level, start time. The run ID is saved so results can be written back later.

## Building the work queue

`cmd_run()` queries `sessions` for all rows with `status='pending'` (or also `error` if `--retry-errors` was passed). It gets a list of filenames. Those filenames are then sorted by the modification time of the corresponding `.jsonl` file on disk, newest first. This means recent sessions get processed before old ones, which is useful when you're running incrementally.

If `--limit N` was passed, the list is sliced to the first N entries.

A `ThreadPoolExecutor` is created with `max_workers=4` (the `--parallel` argument). All sessions are submitted to the pool at once. The main thread then iterates over futures as they complete, collecting results.

## Processing a single session

Each worker thread runs `process_one_session(filename, prompt_template, prompt_type)`. This function opens its own database connection to `batch.db` — important because SQLite connections are not thread-safe. The first thing it does is mark the session `running` in the database with a start timestamp.

The session file is handed to `parse_session()` in `parse_session.py`. This opens the `.jsonl` file and reads it line by line. Each line is a JSON object representing a single event from a Claude Code session. The parser skips a set of noise types entirely — progress events, queue operations, file history snapshots, system messages, summaries. For messages that are type `user` or `assistant`, it extracts the text content.

User messages get stripped of `<system-reminder>` blocks (the injected memory context that gets added to every message). Tool result blocks within user messages are included if they look like useful information — email content, calendar data, reminder lists — but skipped if they look like code output. The heuristic: if more than half the first ten lines match a `digits→` pattern (Read tool output with line numbers), it's file content and gets dropped. Results over 5000 characters are also dropped. Assistant messages go through a boilerplate filter — if two or more of a set of noise patterns match (agent launch confirmation text, run_in_background markers, etc.), the message is discarded as system plumbing rather than conversation.

What comes back from `parse_session()` is a dict with a `messages` list (each entry has `role` and `text`), total character count, and some metadata. If the total character count is under 500, the session is too small to be worth extracting from. It gets marked `skipped` and the function returns early.

## Chunking

Conversations that pass the size threshold get chunked. `chunk_conversation()` in `pipeline.py` takes the messages list and splits it into overlapping windows of 750 words each, with 100 words of overlap between adjacent chunks. The chunking is word-based and message-boundary-elastic: it counts words until it reaches the 750-word target, then extends to the end of whatever message was in progress rather than cutting mid-message. The step size between chunk starts is 650 words (750 minus the 100-word overlap), so adjacent chunks share roughly the last 100 words of context. If the entire conversation fits in one chunk, the list of chunks has a single entry.

## Calling Haiku

Each chunk is submitted to another `ThreadPoolExecutor`, this one with up to 5 workers, running `extract_chunk()`. The worker flattens the chunk's messages into a single text string with blank lines between them, then calls `run_extraction()` with that text and the prompt template.

`run_extraction()` constructs the full prompt by prepending the template to the conversation text and appending `\n</conversation>` (the template ends with an open `<conversation>` tag that the conversation text fills). It then calls `claude -p --model haiku --allowedTools "" --output-format json` as a subprocess with the full prompt piped to stdin. The `--allowedTools ""` flag means Haiku gets no tools — it just reads and responds. The `--output-format json` flag makes the CLI return a JSON envelope wrapping the model's response along with token counts and cost.

If the subprocess exits with a non-zero return code and the combined stdout/stderr contains rate limit signals (the strings "rate limit", "overloaded", "429", "too many requests", "rate_limit"), a `RateLimitError` is raised. This propagates up through the chunk pool, through `process_one_session()`, and back to the main thread where it stops the whole run.

If the call succeeds, the JSON envelope is parsed. The `result` field contains Haiku's response text. Any `<think>...</think>` blocks are stripped out (some models emit thinking tags). The remaining text is cleaned of markdown code fences if present, then parsed as JSON. The expected format is a JSON array — either an array of strings or an array of objects with `content` and `type` fields, depending on the prompt. If direct JSON parsing fails, the function tries parsing each line of the response as a separate JSON array and concatenating them (the model occasionally splits its output across lines). On a failed parse, the function retries up to 5 times total before returning an empty list.

Usage statistics — input tokens, output tokens, cache read/creation tokens, cost in USD — are extracted from the envelope and returned with the memories.

## Collecting chunk results

Back in `process_one_session()`, the chunk futures are gathered and sorted by chunk index to restore the original conversation order. Each chunk's results are normalized: strings become `{"content": str, "type": "world"}` dicts, dicts get a `type` field added if missing, anything else gets stringified. Token counts and costs accumulate into session-level totals.

If any memories were extracted, `insert_memories()` is called with the path to `memories.db` (in `~/Library/Mobile Documents/com~apple~CloudDocs/Aria/data/`), the normalized memory list, a source string (`session:<filename>`), and a `created_at` timestamp taken from the session file's modification time on disk. This timestamp matters: a memory extracted from a conversation that happened in January gets a January timestamp, not today's date. Recency-based retrieval depends on this being accurate.

`insert_memories()` opens `memories.db` with WAL journal mode and a 30-second timeout (safe for concurrent writes). For each memory, it generates a random 12-character hex ID prefixed with `m_`, inserts the row into the `memories` table, then inserts the same content and type into `memories_fts` using the row ID as the FTS5 link.

After insertion, the session row in `batch.db` is updated: status set to `done`, prompt type recorded, chunk counts, memory count, timestamps, and token/cost totals all written in a single UPDATE.

## Main thread accounting

The main thread receives each completed future. If a `RateLimitError` bubbles up, it cancels all pending futures, sets `stop_reason` to `rate_limit`, and breaks out of the loop. If `shutdown_flag` is set (Ctrl-C was pressed), it similarly cancels pending futures and breaks with `stop_reason` of `interrupted`. Otherwise, it increments the appropriate counter (processed, skipped, errored), adds to the running memory and token totals, and prints a progress line to stderr.

When the loop finishes, any sessions still in `running` status in the database get reset back to `pending`. This handles the case where a session was started in a thread that didn't finish before the run stopped. Those sessions will be picked up on the next run without needing `--retry-errors`.

The `runs` row is updated with final totals: sessions processed, skipped, errored, total memories, token counts, cost, stop reason, and stop time. A summary line is printed to stdout.

## What ends up where

`batch.db` in the extract directory holds the full tracking record: every session that has ever been seen, its current status, how many chunks and memories it produced, the cost in tokens and USD, and error messages for anything that failed. The `runs` table logs each invocation with aggregated totals.

`memories.db` in `Aria/data/` grows with every run. Each new memory gets a random ID, its content, type (`world` for this run), source, and the session's original timestamp. The FTS5 virtual table (`memories_fts`) is kept in sync row by row so keyword search works immediately after insertion.

The session `.jsonl` files in `~/.claude/projects/-Users-maxwraae/` are never modified.
