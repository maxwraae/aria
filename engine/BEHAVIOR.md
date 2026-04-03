# Aria Engine Behavior

How the engine actually works today. Each rule is what the code does right now, based on reading the source files. No aspirations, no plans. Just what's real.

---

## The Loop

The engine polls every **1 second**. No nudge mechanism. The fast tick makes everything responsive: Max's messages get picked up within 1 second, presence detection is accurate, schedules fire on time.

Each poll cycle does this, in order:

1. Sync from peer DB (iCloud SQLite ATTACH)
2. Fire any ready schedules (insert messages into objective inboxes)
3. Prune stale objectives (once per hour)
4. Compute `max_active` set (objectives Max engaged with in last 15 min)
5. Find pending objectives (inbox rows with `turn_id IS NULL`)
6. Filter by machine ownership
7. Spawn Max-direct objectives immediately (bypass concurrency)
8. Sort remaining by priority (max_active > urgent > important > oldest)
9. Spawn autonomous turns up to concurrency limit (3 idle, 10 when max_active)
10. Recover stuck objectives

**Source:** `engine/src/engine/loop.ts`

---

## Rules

### 1. Concurrency Cap

**Rule:** Maximum 3 objectives in `thinking` status system-wide (per machine). If 3 are already thinking, the engine does not spawn another. It waits and queues.

**How it works:** `atConcurrencyLimit(db, machineId)` counts objectives with `status = 'thinking'` on this machine. If count >= 3, the loop stops spawning and waits for the next tick.

**Source:** `engine/src/engine/concurrency.ts`

**Test:** `src/engine/concurrency.test.ts`
- Insert 3 objectives with `status = 'thinking'` → `atConcurrencyLimit()` returns true
- Insert 2 objectives with `status = 'thinking'` → returns false
- Insert 3 thinking + 1 pending with unprocessed message → poll logic does not spawn the 4th
- Insert 2 thinking, 1 resolves → next pending gets spawned

---

### 2. Circuit Breaker

**Rule:** 2 consecutive failures on the same objective → status set to `needs-input`, Max notified. Any kind of failure counts: agent crash, error exit, timeout. The objective stops running until Max intervenes.

**How it works:** The `fail_count` field on the objective increments each time a turn exits with an error. When it hits 2, the loop sets status to `needs-input` and calls `aria notify`. A successful turn resets the counter to 0.

**Source:** `engine/src/engine/loop.ts`, stuck recovery section

**Test:** `src/engine/circuit-breaker.test.ts`
- Objective fails once → `fail_count` increments to 1, status stays active (idle or gets re-queued)
- Objective fails twice consecutively → status becomes `needs-input`
- Objective fails once, succeeds, fails again → counter resets on success, still active after second failure
- After hitting `needs-input`, objective is NOT picked up by `getPendingObjectives` even if it has unprocessed messages

---

### 3. Stuck Timeout

**Rule:** An agent in `thinking` for more than 30 minutes is killed and counted as a failure toward the circuit breaker.

**How it works:** The loop queries for objectives with `status = 'thinking'` and `updated_at` older than 30 minutes. It resets them to their previous status, increments `fail_count`, and if that trips the circuit breaker (2 consecutive), sets to `needs-input` and notifies Max.

**Source:** `engine/src/engine/loop.ts`

**Test:** `src/engine/stuck-timeout.test.ts`
- Objective in `thinking` for 29 minutes → not considered stuck
- Objective in `thinking` for 31 minutes → reset, `fail_count` incremented
- Objective stuck twice in a row (two consecutive timeouts) → `needs-input`
- Objective stuck once, then succeeds on next turn → `fail_count` resets, still active

---

### 4. Stale Pruning

**Rule:** Objectives idle for 14 days with no unprocessed messages are marked `abandoned`.

**How it works:** Runs once per hour. Queries for objectives where `updated_at` is older than 14 days and there are no `turn_id IS NULL` messages in the inbox. Sets status to `abandoned`.

**What it doesn't do:** Doesn't delete anything. Abandoned objectives stay in the DB and can be revived.

**Source:** `engine/src/engine/loop.ts`

---

### 5. Tool Lockdown

**Rule:** Agents get Bash, Edit, Read, Write, Glob, Grep. No MCP tools. And explicit deny rules in the contract for dangerous Bash commands.

**How it works:** The `--allowedTools` flag on the spawn command restricts to 6 tools. No MCP tools (no Mail, Calendar, Reminders, etc.). Agents can call CLI skills via Bash if they know about them.

**Deny rules (enforced via contract/system prompt, not mechanically):**
- **No `rm`.** Never delete files. Use Finder trash (`osascript -e 'tell application "Finder" to delete...'`) if removal is needed.
- **No `git push`.** Can commit locally, cannot push to remotes.
- **No external messaging.** No sending email, Slack, or any communication to anyone other than Max via the Aria inbox. No `sendmail`, no `osascript` to Mail, no `curl` to messaging APIs.
- **No software installation.** No `brew install`, `npm install -g`, `pip install`, or system-level changes.

**Where the deny rules live:** In the contract (`contract.md`), the document every agent reads every turn.

**Source:** `engine/src/engine/spawn.ts` (tool list), `engine/src/context/bricks/contract/contract.md` (deny rules)

**Source:** `engine/src/engine/spawn.ts`

---

### 6. Priority Ordering

**Rule:** Pending objectives are processed in order: urgent first, then important, then oldest.

**How it works:** The query sorts by `urgent DESC, important DESC, created_at ASC`. Both urgent and important are boolean flags on the objective. This creates 4 priority buckets. Within each bucket, oldest objectives go first.

**What it doesn't do:** No scoring, no weighting, no dynamic reprioritization. No concept of "this has been waiting a long time, bump it up."

**Source:** `engine/src/db/queries.ts`, `getPendingObjectives`

---

### 7. Max Priority Lane

**Rule:** When Max messages an objective, that objective gets `max_active` for 15 minutes. The status propagates through new activity, not through the tree structure. Concurrency cap lifts from 3 to 10 while any `max_active` objectives exist.

**How `max_active` spreads:**
- Max messages objective A → A is `max_active`
- A's turn creates a child B → B inherits `max_active`
- A's turn sends a message to existing objective C → C gets `max_active`
- B's turn creates grandchild D → D inherits `max_active`
- Existing child E that nobody messaged → stays normal priority. Not activated.

The wave propagates through **messages and new work**, not tree structure. Old branches don't light up just because Max talked to an ancestor.

**Priority ordering:** `max_active DESC, urgent DESC, important DESC, created_at ASC`

**Concurrency:** If any `max_active` objectives exist in the pending queue, cap = 10. Otherwise, cap = 3.

**Timeout:** Each `max_active` flag expires 15 minutes after the message that triggered it. Computed fresh each poll tick. No DB storage.

**Multiple conversations:** Max can talk to several objectives at once. Each spawns its own wave of `max_active`. They compete by normal tiebreakers within the `max_active` tier.

**Models:** Max's direct objective gets opus (existing model selection rule). Children and downstream objectives stay sonnet. The priority lane gives them speed (more slots, higher priority), not a model upgrade.

**Source:** `engine/src/engine/loop.ts`, `engine/src/engine/concurrency.ts`

**Test:** `src/engine/max-priority-lane.test.ts`
- Max messages objective A → A is `max_active`, sorted before urgent+important
- A's turn creates child B → B inherits `max_active`
- Existing child C (not messaged) → NOT `max_active`
- Max messages two different objectives → both waves active simultaneously
- 15 minutes pass with no new messages → `max_active` is empty, cap returns to 3
- Concurrency cap is 10 when any `max_active` exists, 3 when none

---

### 8. Model Selection

**Rule:** Sonnet always. Opus only when Max directly messaged this specific objective (a Max message is in the unprocessed batch for this turn).

**How it works:** At spawn time, check the unprocessed messages for this objective. If any have `sender = 'max'`, use opus. Otherwise, sonnet. No ancestor walking. No time window. No propagation. Just: did Max talk to you? Yes → opus. No → sonnet.

**Explicit override:** An objective can have a `model` field set explicitly. That takes precedence over everything.

**Source:** `engine/src/engine/spawn.ts`, model resolution section

**Test:** `src/engine/model-selection.test.ts`
- Objective with Max message in unprocessed batch → opus
- Objective with only system/child messages → sonnet
- Child of objective Max messaged → sonnet (no propagation)
- Objective with explicit model override → uses override regardless of Max messages

---

### 9. Max Bypasses Concurrency

**Rule:** If Max directly messaged an objective, it spawns immediately regardless of the concurrency cap. Max's messages are never queued.

**How it works:** Before checking the concurrency limit, the loop checks if any pending objective has an unprocessed message from Max. Those objectives are spawned first, and they don't count against the concurrency cap (3 or 10).

**Effect:** The concurrency cap governs autonomous work only. Max always gets a response. If 3 agents are thinking and Max sends a message, that's now 4 thinking, and that's fine.

**Source:** `engine/src/engine/loop.ts`

**Test:** `src/engine/max-bypass-concurrency.test.ts`
- 3 objectives in thinking + Max messages a 4th → 4th spawns anyway
- 10 objectives in thinking (max_active mode) + Max messages an 11th → 11th spawns anyway
- Objective with only system messages at concurrency limit → does NOT bypass, waits

---

### 10. Machine Ownership

**Rule:** Each machine only processes objectives assigned to it. Unassigned objectives default to `mini`. A machine never processes objectives owned by the other machine.

**How it works:** Each objective has a `machine` field. The engine reads its own machine ID from hostname. The loop filters pending objectives to only those matching. Objectives without a machine assignment default to `mini`.

**The local exception:** When Max toggles an objective to run on MacBook, only the MacBook engine picks it up. The Mini ignores it completely, even if it can see it via peer sync.

**What it doesn't do:** No load balancing. No failover. If the Mini is down, its objectives just don't run.

**Source:** `engine/src/engine/loop.ts`

**Test:** `src/engine/machine-ownership.test.ts`
- Objective with `machine = 'macbook'` → only returned when engine machineId is 'macbook'
- Objective with `machine = 'mini'` → not returned when engine machineId is 'macbook'
- Objective with no machine set → defaults to 'mini', only returned for mini engine
- Objective toggled from 'mini' to 'macbook' → mini stops seeing it, macbook starts seeing it

---

### 11. Peer Sync

**Rule:** Every poll tick syncs data from the peer machine's DB via iCloud.

**How it works:** `syncFromPeer(db)` uses SQLite ATTACH to open the peer's DB file (which lives in iCloud). It bulk-copies new objectives, inbox messages, turns, and schedules using `INSERT OR IGNORE` and `UPDATE WHERE peer.updated_at > local.updated_at`.

**Frequency:** Every 5 seconds (every poll tick).

**Source:** `engine/src/db/queries.ts`, `syncFromPeer`

---

### 12. Schedule Firing

**Rule:** Schedules with `next_at <= now()` insert a message into the objective's inbox.

**How it works:** `getReadySchedules(db)` finds due schedules. For each, a system message is inserted into the objective's inbox. Recurring schedules get their `next_at` bumped. One-shot schedules are deleted.

**Source:** `engine/src/engine/loop.ts`

---

### 13. Depth Cap

**Rule:** Agents cannot create children beyond 5 levels of autonomous depth. Max is exempt.

**What "autonomous depth" means:** The distance between a new child and the shallowest ancestor where Max sent a message within the last hour. If `new_child_depth - initiation_depth >= 5`, creation is refused.

**How it works:**

Every objective stores a `depth` field, computed once at creation: `parent.depth + 1`. Root is 0.

When an agent runs `aria create`, the CLI:
1. Looks up the calling objective's depth (from `ARIA_OBJECTIVE_ID`)
2. New child would be at `depth + 1`
3. Walks up ancestors to find the shallowest one where Max sent a message (`sender = 'max'` in inbox) within the last hour
4. That ancestor's depth is the initiation depth
5. If `(depth + 1) - initiation_depth >= 5`, refuse with error: "Maximum autonomous depth reached. Report to your parent instead of decomposing further."

**Max bypass:** If `aria create` is called without `ARIA_OBJECTIVE_ID` (i.e., Max running it directly from terminal), no depth check. Max can create at any depth.

**Why an hour:** Matches the intuition that if Max engaged with part of the tree in the last hour, the work below it is "authorized." Long enough that stepping away for 20 minutes doesn't invalidate a chain. Short enough that overnight autonomous runs can't go arbitrarily deep.

**Edge case:** If no ancestor has a Max message within the hour, the initiation depth is the root (0). This means fully autonomous objectives (Max created it and walked away) get 5 levels total before they're capped.

**Source:** `engine/src/cli/create.ts` (enforcement), objectives table (depth field)

**Test:** `src/engine/depth-cap.test.ts`
- Agent at depth 4, Max messaged depth 1 within the hour → can create child (autonomous depth = 4)
- Agent at depth 6, Max messaged depth 1 within the hour → cannot create child (autonomous depth = 6, >= 5)
- Agent at depth 3, no Max message in any ancestor within the hour → initiation depth = 0, autonomous depth = 4, can create
- Agent at depth 5, no Max message in any ancestor within the hour → cannot create (autonomous depth = 6, >= 5)
- Max runs `aria create` directly at depth 8 → allowed, no cap enforced

---

### 14. Fan-out Cap

**Rule:** An objective can have at most 10 active children. If an agent tries to create more, `aria create` refuses.

**How it works:** In `cmdCreate`, before inserting the new objective, count existing children of the parent where `status NOT IN ('resolved', 'failed', 'abandoned')`. If count >= 10, return error: "Maximum children reached (10). Resolve, fail, or rethink existing children before creating more."

**What counts:** Only active children. Resolved, failed, and abandoned children don't count against the cap. An objective can create new children after old ones complete.

**Max bypass:** Same as depth cap. If `aria create` is called without `ARIA_OBJECTIVE_ID` (Max running directly), no fan-out check.

**Source:** `engine/src/cli/index.ts` (enforcement in cmdCreate)

**Test:** `src/engine/fan-out-cap.test.ts`
- Agent creates 10 children → allowed
- Agent tries to create 11th child → refused
- Agent creates 10, 3 resolve, creates 3 more → allowed (only 7 active)
- Max creates 15 children directly → allowed, no cap enforced

---

### 15. Cascade Tracking

**Rule:** Every message in the inbox carries a `cascade_id` that traces the chain of activity back to the event that started it. Cascades are the unit of work measurement.

**How it works:**

Every cascade starts with an initiation event:
- Max sends a message → new cascade_id
- A schedule fires → new cascade_id
- The circuit breaker creates a system message → new cascade_id

Every subsequent message in the chain inherits the cascade_id. When the engine spawns a turn, it resolves the cascade_id from the unprocessed messages and passes it to the agent as `ARIA_CASCADE_ID` env var. Every message the agent produces (via `aria create`, `aria tell`, `aria reject`, etc.) carries that cascade_id forward.

**Resolution when multiple cascade_ids exist:** If an objective has unprocessed messages with different cascade_ids (e.g., Max sent a message AND a child reported back), the Max message's cascade_id takes priority. Otherwise, the most recent message's cascade_id is used.

**What this enables:**
- Count turns per cascade: `SELECT cascade_id, COUNT(DISTINCT turn_id) FROM inbox WHERE cascade_id IS NOT NULL GROUP BY cascade_id`
- Trace which objectives a cascade touched
- Measure cascade duration (first message to last)
- Detect anomalous cascades (high turn count, low resolution count)

**Source:** `engine/src/db/queries.ts` (resolveCascadeId, insertMessage), `engine/src/engine/spawn.ts` (env var propagation), `engine/src/engine/output.ts` (response routing)

**Test:** `src/engine/cascade.test.ts`
- insertMessage with cascade_id stores it correctly
- insertMessage without cascade_id stores null (backward compat)
- resolveCascadeId picks Max message's cascade_id over child messages
- resolveCascadeId picks most recent message when no Max message
- resolveCascadeId ignores already-stamped messages
- Turns per cascade queryable via GROUP BY

---

### 16. Bounce Detector

**Rule:** If two objectives exchange 5+ messages within 30 minutes with no Max message to either in that window, the routing is blocked and the child is set to `needs-input`.

**How it works:** In `output.ts`, before routing a reply back to the sender that triggered this turn, `isBouncing()` counts messages between the pair in the last 30 minutes. If >= 5 and no Max message to either objective in the window, the reply is not routed. The current objective is set to `needs-input` with a system message.

**What resets it:** Max messaging either objective. The count is messages, not round-trips (5 messages ≈ 2.5 round-trips).

**Source:** `engine/src/db/queries.ts` (isBouncing), `engine/src/engine/output.ts` (check before routing)

**Test:** `src/engine/bounce-detector.test.ts`
- 4 exchanges in window → not bouncing
- 5 exchanges in window → bouncing, routing blocked
- 5 exchanges + Max message → not bouncing (Max resets)
- 5 exchanges outside 30-min window → not bouncing
- Independent pairs evaluated separately

---

## CLI Commands

Every command an agent can use during a turn. All verified via `src/engine/cli-commands.test.ts`.

| Command | What it does |
|---------|-------------|
| `aria create "state" "instructions"` | Creates child objective with correct parent, idle status, optional instruction message |
| `aria tell <id> "message"` | Sends message to any objective's inbox, sender = calling objective |
| `aria succeed "summary"` | Resolves objective, stores summary, notifies parent, cascade-abandons active children |
| `aria fail "reason"` | Fails objective, stores reason, notifies parent |
| `aria reject <child-id> "feedback"` | Resets child to idle, clears waiting_on, sends feedback message |
| `aria wait "waiting on..."` | Sets status to waiting, stores what it's waiting for |
| `aria schedule "message" --at <time>` | Creates schedule row, fires message at specified time |
| `aria notify "message"` | Sends signal to root objective (reaches Max) |
| `aria find "query"` | FTS search across objectives |
| `aria show <id>` | Returns full objective details |
| `aria tree` | Returns active objective tree with hierarchy |
| `aria inbox` | Returns messages for current objective |

