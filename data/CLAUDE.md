# Aria Data

Two SQLite databases live in this folder, one per machine. Both are real databases that accumulate objectives over time.

- **mini.db** — Mac Mini. Always-on, runs the Aria engine 24/7.
- **macbook.db** — MacBook Pro. Max's daily driver. Agents here need local file access.

## The Model

**Mini is the authority.** It runs the engine, processes turns, and spawns agents. When someone says "Aria," they mean the process running on the Mini.

**MacBook is a staging area.** Agents running on the MacBook create objectives locally because they need access to local files that don't exist on the Mini. Those objectives get synced to the Mini via iCloud so the engine can pick them up.

**Read both, write local.** Any read command merges both databases and presents a unified view. Any write goes only to the database matching the current machine. On the MacBook, that's macbook.db. On the Mini, that's mini.db.

**iCloud syncs the files.** Both databases live in this iCloud-synced folder. Each machine sees both files locally, so reads have no network latency. The sync happens at the filesystem level — no custom networking needed.

**No write conflicts.** Each machine only writes to its own database. There's no situation where two machines write to the same file simultaneously.

## Sync Flow

The sync process (planned, not yet implemented) works like this:

1. The Mini reads macbook.db on a schedule
2. New objectives in macbook.db get created in mini.db
3. The corresponding entries in macbook.db get cleaned up
4. macbook.db is effectively an inbox for new objectives — it holds them until the Mini absorbs them

Until sync is built, macbook.db objectives are visible via merged reads but aren't actively processed by the engine.

## Command Categories

### Lifecycle commands — for Aria agents

`create`, `succeed`, `fail`, `reject`, `wait`, `tell`, `notify`, `send`

These are how agents operate within the objective tree. Any agent can use them, subject to existing permission checks (the caller must be the parent or an ancestor of the target objective).

### Read commands — for anyone

`tree`, `show`, `find`, `inbox`, `context`

These always read from both databases and merge the results. No permission restrictions.

### Management commands — Max only

`abandon`, `edit`, `reparent`, `status`

These modify the structure and state of the objective tree and are restricted to direct commands from Max.

**Permission gate:** If `ARIA_OBJECTIVE_ID` is set (agent context), the most recent inbox message must have `sender === 'max'` before these commands are allowed. If `ARIA_OBJECTIVE_ID` is not set (bare CLI invocation), they are always allowed — that means Max is running the command directly from a terminal.

## Schema

### objectives

| Column | Type | Notes |
|---|---|---|
| id | text | Primary key. `root` and `quick` are protected |
| objective | text | Short title |
| description | text | Full description |
| parent | text | Parent objective ID |
| status | text | See valid statuses below |
| waiting_on | text | ID of objective this one is waiting for |
| resolution_summary | text | Filled when resolved or failed |
| important | integer | Boolean flag |
| urgent | integer | Boolean flag |
| model | text | Agent model to use for this objective |
| cwd | text | Working directory for agent runs |
| machine | text | Which machine created this row |
| fail_count | integer | Number of failed attempts |
| last_error | text | Most recent error message |
| created_at | integer | Unix epoch (milliseconds) |
| updated_at | integer | Unix epoch (milliseconds) |
| resolved_at | integer | Unix epoch (milliseconds), null if not resolved |

**Valid statuses:** `idle`, `thinking`, `needs-input`, `resolved`, `failed`, `abandoned`

**Protected IDs:** `root` and `quick` cannot be resolved, failed, or abandoned.

### inbox

Messages between objectives and Max. The engine delivers inbox messages to agents when they run, and agents use `tell` to send replies back.

### turns

Records of agent turn executions — what ran, when, and what happened.

### schedules

Recurring message schedules. Used to trigger objectives on a timer.

## Journal Mode

Both databases use DELETE journal mode rather than WAL. WAL mode produces `-shm` and `-wal` sidecar files that confuse iCloud sync — iCloud doesn't always handle them correctly and can cause corruption or sync conflicts. DELETE journal mode keeps each database as a single file, which iCloud syncs cleanly.
