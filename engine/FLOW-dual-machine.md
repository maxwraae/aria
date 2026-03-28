# FLOW: Aria's Dual-Machine Architecture

There are two computers. The Mac Mini sits on the desk running all the time. The MacBook Pro is Max's laptop — sometimes open, sometimes asleep, sometimes on a different network. Both run the same engine. Both talk to the same iCloud folder. Neither coordinates directly with the other. The architecture is designed so they don't have to.

---

## How Each Machine Knows Who It Is

When the engine starts, the very first thing it does is figure out which machine it's on. This logic lives in `engine/src/db/node.ts`. It calls `os.hostname()`, strips the `.local` suffix if present, and looks up the result in a small table: `Maxs-Mac-mini` maps to `mini`, `Maxs-MacBook-Pro` and `Mac` map to `macbook`. If the hostname doesn't match anything known, the engine throws. You can also set `ARIA_MACHINE` in the environment to override this, which is useful for testing.

Once it knows its own identity, the engine constructs two paths. The **local database** is `~/Library/Mobile Documents/com~apple~CloudDocs/aria/data/<machineId>.db` — for the Mini, that's `mini.db`; for the MacBook, `macbook.db`. The **peer database** is whichever one belongs to the other machine. Both files live in the same iCloud folder, which is the key to everything that follows.

---

## What Happens When Max Sends a Message

The surface (the React frontend) sends a POST to the local engine — whichever engine is running on the machine Max is currently using. The engine writes an **inbox row** to its local SQLite database: the message, the objective ID it belongs to, the sender (`max`), and a UUID that will be used later to prevent duplicate imports.

After writing to the database, the engine calls `nudge()`. This is a small mechanism in `engine/src/engine/loop.ts` that cancels the current poll timer and fires a new poll cycle immediately. Without this, Max would wait up to 5 seconds for the engine to notice the new message. With it, the response starts within milliseconds.

---

## The Poll Loop

The poll loop runs every 5 seconds. At the top of every cycle, before it does anything else, it calls `syncFromPeer`. Then it queries for pending objectives, filters them by machine assignment, checks the concurrency limit, and spawns agent turns for whatever is ready.

**Machine filtering** is the central routing mechanism. Every objective has a `machine` field. If that field is null, the objective belongs to the Mini — the Mini is the default coordinator. If the field is set to `macbook`, only the MacBook engine will process it. The filter in `loop.ts` is explicit: `if (!obj.machine) return machineId === 'mini'` — unassigned objectives go to Mini, assigned objectives go to whoever they're assigned to.

The **concurrency limit** is three simultaneous objectives per machine. The function `atConcurrencyLimit` in `engine/src/engine/concurrency.ts` calls `getThinkingCount(db, machineId)` — it counts objectives currently in the `thinking` state, filtered by machine. Mini's count and MacBook's count are independent. They don't compete for each other's slots.

---

## Spawning a Turn

When the loop finds an objective that's ready and a slot is available, it calls `spawnTurn` from `engine/src/engine/spawn.ts`. Here's what that function does, in order:

1. Sets the objective's status to `thinking`
2. Collects all unprocessed inbox messages for this objective
3. Assembles context — ten **bricks** (persona, contract, environment, objective, parents, siblings, children, similar objectives, memory, conversation, focus) — and writes the result to a temp file at `/tmp/aria-context-<objectiveId>.md`
4. Formats the inbox messages into a single user message string
5. Resolves which model to use — if Max has been active in this objective or its ancestors in the last two hours, it escalates to Opus; otherwise Sonnet
6. Creates a turn record in the database
7. Stamps the inbox messages with the turn ID, so they won't be processed again
8. Spawns `claude -p` as a child process

The Claude binary path is `~/.local/bin/claude`, resolved via `homedir()`. This is the **ENOENT fix**: background processes don't have the same `PATH` as an interactive shell, so a bare `claude` command would fail. Resolving through `homedir()` gives an absolute path that always works.

Claude runs with `--output-format stream-json --verbose`, which means it streams NDJSON to stdout. The engine reads this stream asynchronously via `processOutput`, parsing tool calls and text blocks as they arrive. When Claude finishes, the agent's response is stored as an inbox row (type `reply`), status returns to `idle` or `needs-input` depending on what the agent did, and a WebSocket message pushes the update to the surface.

---

## The Environment Brick

One of those eleven context bricks is worth calling out specifically. The **environment brick** (`engine/src/context/bricks/environment/index.ts`) detects at render time — not at boot time — which machine the agent is running on. It calls `os.hostname()` directly, checks whether the result contains "mini" or "mac-mini", and sets `machineName` accordingly. The rendered system prompt tells the agent "You are on the Mac Mini" or "You are on the MacBook Pro" along with the current date, time, working directory, and objective ID. This means the agent always has accurate machine context regardless of when or where it spawned.

---

## The Sync Mechanism

`syncFromPeer` is the gravitational center of the whole architecture. It lives in `engine/src/db/queries.ts` around line 720, and it runs at the top of every poll cycle — every 5 seconds on both machines.

The mechanism uses SQLite's `ATTACH DATABASE` feature. The logic in `engine/src/db/unified.ts` takes the peer's file path and attaches it as a second database named `peer`. Once attached, both databases are visible in the same SQL session, so you can write `SELECT * FROM peer.objectives` or `INSERT INTO local SELECT * FROM peer.inbox`. When the sync is done, the peer database is detached.

The sync itself is four `INSERT OR IGNORE` / `UPDATE` operations:

- **Objectives:** First, insert any objectives from the peer that don't exist locally (by ID). Then, update any objectives where the peer's `updated_at` is newer than the local copy. This second step propagates status changes — if the MacBook marks an objective as `resolved`, the Mini picks that up on the next sync.
- **Inbox:** Insert any inbox rows from the peer that don't exist locally. Because every inbox row has a UUID primary key and inbox is append-only, `INSERT OR IGNORE` is perfectly conflict-free. There's no case where two machines write different data to the same UUID.
- **Turns:** Same pattern as inbox — `INSERT OR IGNORE` by UUID.
- **Schedules:** Same pattern.

**iCloud is the transport.** Neither machine talks to the other over a network socket. The Mini writes to `mini.db`, iCloud syncs the file to the MacBook, the MacBook attaches `mini.db` as peer and reads from it. The MacBook writes to `macbook.db`, iCloud syncs that back, the Mini reads from it. The latency is whatever iCloud's file sync latency is — usually a few seconds, occasionally more on slow connections.

---

## The Local/Remote Toggle

The surface has a toggle on each objective card: **Auto** or **MB** (MacBook). When you toggle an objective to MB, it sets the `machine` field in the database to `macbook`. The Mini engine, which syncs this change on the next cycle, sees that the objective is no longer assigned to `mini` and stops processing it. The MacBook engine, which also syncs the change, sees that it's now assigned to `macbook` and starts picking it up.

Toggling back to Auto sets `machine` to null, which reverses the assignment: Mini resumes, MacBook stops. The agent's environment brick will reflect the new machine context the next time a turn is spawned.

### Machine Cascade

Machine assignment cascades downward through the entire subtree. When you toggle an objective's machine, every active descendant (children, grandchildren, etc.) immediately updates to match. The `cascadeMachine` function in `queries.ts` walks the tree recursively, skipping objectives that are already resolved, failed, or abandoned.

This means you can set a top-level objective to MacBook and know that everything spawned under it — by agents, by the API, by Max — will stay on the MacBook. The assignment is permanent until explicitly changed.

You can also override deeper in the tree. If a MacBook subtree has one branch that should run on Mini, toggle that branch node — it and its descendants switch to Mini while the rest of the subtree stays on MacBook. The most recent explicit change always wins downward.

### Machine Inheritance

When a new objective is created — whether by an agent calling `aria create` or by the surface calling `POST /api/objectives` — it inherits the `machine` field from its parent. An agent running on the MacBook that spawns a child doesn't need to think about machine assignment; the child automatically belongs to the same machine as its parent. This keeps entire work trees co-located on the machine that owns the root.

---

## Cross-Machine Messaging

An agent running on the MacBook can send a message to an objective that lives on the Mini. The `aria tell <objective-id> "message"` command writes an inbox row to `macbook.db` — the local database, wherever the agent is running. iCloud syncs the file. On the next poll cycle, the Mini calls `syncFromPeer`, attaches `macbook.db`, and imports the new inbox row. The Mini objective wakes up, processes the message, and responds. That response is an inbox row in `mini.db`. iCloud syncs it. The MacBook imports it. The conversation has crossed machines twice, mediated entirely by file sync.

---

## When the MacBook Sleeps

MacBook objectives don't fail when the laptop sleeps — they just pause. The MacBook engine stops polling. Its objectives stay in whatever status they were in. When the MacBook wakes and the engine restarts, the first thing it does is recover any objectives left in `thinking` state: these are reset to `needs-input`, on the assumption that whatever Claude was doing got interrupted. Then `syncFromPeer` runs immediately, catching up on anything the Mini wrote while the MacBook was asleep.

The **stuck recovery** mechanism in the loop handles longer outages. Any objective that stays in `thinking` for more than 10 minutes gets noticed. After three consecutive stuck detections, the objective is set to `needs-input`, a system message is inserted explaining what happened, and Max gets a notification via `aria notify`. The threshold is generous enough that normal long-running turns don't trigger it, but short enough that a crashed agent doesn't stay invisible for hours.

---

## The Shape of the Thing

Two machines. Two databases. One iCloud folder that acts as a passive message bus. No coordinator, no shared lock, no network socket between them. Each engine is sovereign over the objectives assigned to it, and the sync mechanism is careful never to overwrite data that the other machine owns. The result is a system that degrades gracefully — if the MacBook is offline, the Mini keeps running; if iCloud is slow, syncs are just delayed, not lost; if the engine crashes, nothing is corrupted, just paused.
