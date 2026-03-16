# Database

Aria's database layer is a SQLite store managed by `better-sqlite3`. Each machine that runs the engine has its own database file, named after the machine and stored in iCloud Drive (`~/Library/Mobile Documents/com~apple~CloudDocs/aria/data/`). The two known machines are `mini` and `macbook`, so on the Mac Mini the file is `mini.db` and on the MacBook it's `macbook.db`. Both files live in the same iCloud-synced folder, which is what makes cross-machine visibility possible without a network API.

## Schema

The schema has four tables: `objectives`, `inbox`, `turns`, and `schedules`. There's also a fifth structure — an FTS5 virtual table called `objectives_fts` — that shadows certain text columns from `objectives` for full-text search.

**Objectives** are the core entity. Everything else hangs off them. An objective has a short text name, an optional description, a parent pointer that makes the whole thing a tree, a status, and a handful of metadata fields: `important`, `urgent`, `model` (which Claude model to use), `cwd` (working directory for the agent), `machine` (which machine owns it), and `fail_count` (how many times the agent has failed). Timestamps are stored as Unix epoch integers in seconds. The `waiting_on` field is a freeform text note explaining what the objective is blocked on — it's not a foreign key, it's a human-readable annotation. `resolution_summary` is filled in when work completes, summarizing what happened.

**Inbox** is a message queue. Every piece of input directed at an objective — from Max, from a parent objective, from a child, from a sibling, from the system — lands here as an inbox message. Each message has a sender identifier, a type, and a `turn_id` field that starts as NULL. The `turn_id` is how the system knows whether a message has been consumed: NULL means unprocessed, a populated value means it was picked up during a specific turn. This is the primary trigger mechanism — the engine polls for objectives that have inbox messages with NULL `turn_id` and activates them.

**Turns** record each time an agent was invoked to process an objective. They're sequentially numbered per objective, so you can always see how many times an objective has been worked. When the agent picks up the pending inbox messages and starts running, a turn is created, and then all the unprocessed messages get their `turn_id` stamped with that turn's ID. That atomic stamp-on-pickup is what prevents double-processing. A turn also stores the Claude session ID so conversation context can be reconstructed.

**Schedules** let objectives fire on a timer. A schedule points at an objective, holds a message to deliver, and has a `next_at` timestamp. The engine polls for schedules where `next_at <= now()`. If the schedule has an `interval`, it's recurring: after firing, the `next_at` is bumped forward by the interval and the schedule persists. If there's no interval, the schedule fires once and is deleted.

## Initialization and Migrations

`initDb()` in `schema.ts` handles everything needed to get a database to a working state. It creates the data directory if it doesn't exist, opens the SQLite connection, and runs all the `CREATE TABLE IF NOT EXISTS` statements. Foreign keys are enabled. The journal mode is set to DELETE rather than WAL — a deliberate choice that avoids the WAL shm/wal sidecar files that can confuse iCloud sync.

Schema evolution is handled with in-place migrations that run every time the engine starts. The code inspects the actual table columns via `PRAGMA table_info` and adds missing columns if they're absent. This means `resolution_summary`, `machine`, and `processed_by` columns were all added after the initial schema and are backfilled safely on first run against an older database.

The FTS5 virtual table gets special treatment because SQLite doesn't support `IF NOT EXISTS` for virtual tables. Instead, the code checks `sqlite_master` manually before creating it.

Every database starts with two seeded objectives: `root` (the top of the entire tree, with the goal "Help Max thrive and succeed") and `quick` (a permanent child of root, the catch-all bucket for quick tasks from the search bar). Both have hardcoded IDs and are protected against deletion or abandonment.

## Machine Identity

`node.ts` is responsible for resolving which machine the engine is running on. It checks the `ARIA_MACHINE` environment variable first, then falls back to `os.hostname()` matched against a lookup table of known hostnames. If neither matches, it throws — an unknown machine is an explicit failure, not a graceful degradation. From the machine ID, it derives both the local database path and the peer path (if the local machine is `mini`, the peer is `macbook`, and vice versa). The `isWorker()` function returns true for any machine that isn't `mini`, positioning the Mac Mini as the coordinator.

## Prepared Statement Cache

All queries go through a small caching layer in `queries.ts`. The `stmt()` function takes a database instance, a string key, and SQL. It keeps a `WeakMap` from database objects to plain objects, and uses the string key as the cache key within that map. The first time a query is prepared, it's compiled and cached; subsequent calls return the cached statement. This avoids the overhead of re-parsing SQL on every call while still being safe to use with multiple database instances.

## Status Lifecycle

An objective moves through a defined set of statuses: `idle` → `thinking` → `idle` or `needs-input` or `resolved` or `failed` or `abandoned`. The engine activates `idle` and `needs-input` objectives when they have unprocessed inbox messages. While the agent is running, the objective is `thinking`. After the agent finishes, the objective returns to `idle` if there's more work to do, or to `resolved` when complete. `needs-input` signals that the agent ran but couldn't continue without a human response. `failed` and `abandoned` are terminal states; `resolved` is also terminal.

When an objective is resolved, the `resolved_at` timestamp is set in addition to `updated_at`. This is the only place where `resolved_at` is populated — `updateStatus()` handles it as a special case.

Abandonment cascades. `cascadeAbandon()` walks down the tree from a given parent, finds all children in `idle` or `needs-input` states, marks them `abandoned`, and recurses into each of their subtrees. Protected IDs (`root` and `quick`) are skipped. This runs inside a SQLite transaction so the whole cascade is atomic.

## The Inbox as Trigger

The inbox isn't just a log — it's the activation signal. `getPendingObjectives()` finds all objectives that have at least one unprocessed inbox message (turn_id IS NULL) and whose status is `idle` or `needs-input`. It returns them ordered by urgency, then importance, then creation time, so the most pressing objectives rise to the top.

When the engine picks up an objective to process, it calls `stampMessages()`, which atomically marks all of that objective's unprocessed messages with the current turn ID. This stamp-before-run pattern means even if the agent crashes, the messages are already associated with a turn and won't re-trigger a second agent run unless the system explicitly resets them.

Inserting a message also touches the parent objective's `updated_at`. This keeps the tree's sort order (which is by `updated_at`) fresh, so recently active objectives always surface first.

## Full-Text Search

The `objectives_fts` virtual table uses FTS5 and indexes four columns: `objective`, `waiting_on`, `description`, and `resolution_summary`. It's kept in sync manually — every write path that touches any of those columns also updates the FTS table. This is explicit and slightly verbose, but it's deliberate: SQLite FTS5 content tables can drift from their source in subtle ways, so Aria manages the sync itself.

Queries against the FTS table are tokenized before submission. The input text is stripped of punctuation, split on whitespace, and words shorter than three characters are dropped. The remaining tokens are joined with `OR`, giving broad fuzzy matching rather than strict phrase matching. The results are ranked by FTS5's native `rank` column, which scores by term frequency.

There are two FTS-backed search functions. `searchObjectives()` is general-purpose and searches across all objectives regardless of status. `findSimilarResolved()` restricts results to objectives with `status = 'resolved'` — this is the memory function, used to surface how similar tasks were handled in the past. `matchObjectiveByText()` excludes resolved, failed, and abandoned objectives and is used for routing incoming messages to active work.

## Multi-Machine: Peer Attachment

The multi-machine model doesn't use replication or a shared server. Instead, because both database files are in iCloud Drive, each machine can directly open the other machine's file. The `withPeer()` function in `unified.ts` is the gateway for all cross-machine reads.

`withPeer()` checks whether the peer database file exists and attaches it as a named SQLite database (`ATTACH DATABASE ... AS peer`). If the file doesn't exist or the attach fails, it falls back to local-only operation silently. After the callback runs, the peer database is immediately detached. This attach-use-detach cycle means the peer connection is never held open across calls.

To avoid hammering the filesystem, `withPeer()` caches the last check time and skips the attach attempt if the peer was unavailable within the last 30 seconds. Once the peer is confirmed unavailable, subsequent calls within that window return immediately with `hasPeer = false`.

The "unified" read functions — `getTreeUnified()`, `getObjectiveUnified()`, `getConversationUnified()`, `getChildrenUnified()` — all use `withPeer()` and build `UNION ALL` queries that combine local and peer results, deduplicating by ID. The pattern is consistent: local results first, then peer results filtered to `id NOT IN (SELECT id FROM local table)`. This means the local machine's version of a record always wins over the peer's version on reads.

`syncFromPeer()` is the write path for cross-machine sync. It copies new objectives, inbox messages, turns, and schedules from the peer into the local database. For objectives, it also applies updates: if the peer has a newer `updated_at` for an existing objective, it overwrites the local status, waiting_on, resolution_summary, importance, urgency, and fail_count. Structural fields (objective text, description, parent, model, cwd) are not overwritten on update — those are treated as immutable after creation. This one-way sync, combined with the iCloud layer underneath, means both machines eventually converge to the same state without a coordination server.

## Engine Helpers

A handful of query functions support the engine's runtime decisions rather than data management.

`getThinkingCount()` returns the number of objectives currently in the `thinking` state. The engine uses this to enforce concurrency limits.

`getLastMaxMessageTime()` returns the timestamp of the most recent message from `max` across all objectives. This is used to detect whether Max has been active recently and adjust behavior accordingly.

`getDeepWorkCount()` looks at a time window and returns the maximum number of messages that Max sent to any single objective within that window. A high number suggests focused attention on one objective — a signal the engine can use to avoid interrupting with other work.

`getStuckObjectives()` returns objectives that have been in `thinking` status longer than a threshold, indicating an agent that crashed or hung without updating the database. `getStaleObjectives()` returns objectives that have been `idle` longer than a threshold with no pending inbox messages — candidates for cleanup or pruning.

`getSenderRelation()` takes a sender ID and an objective ID and classifies their relationship: `max`, `system`, `parent`, `child`, `sibling`, or `other`. This classification is how the engine labels messages when presenting them to an agent, giving the agent context about who is talking to it without having to navigate the tree itself.

## Utilities

`utils.ts` is minimal. `generateId()` wraps `randomUUID()` for a consistent ID source. `now()` returns the current Unix timestamp in seconds — whole seconds, not milliseconds. All timestamps in the schema are in this format, which is why all comparisons and cutoff calculations divide or subtract in seconds.
