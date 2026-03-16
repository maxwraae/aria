# Engine

## The Core Idea

Aria is a tree of objectives. Each objective is a desired state of the world — not a task to do, but a state that should become true. "The kitchen wall is painted" rather than "buy paint." Objectives are arranged in a parent-child hierarchy, where children answer the question of *how* and parents answer the question of *why*. At the root of the tree sits one objective that never resolves: "Help Max thrive and succeed." Everything else is a subtree underneath it.

The engine's job is simple in principle: whenever an objective has unread messages in its inbox, spawn a Claude agent to work on it. That agent does work, responds, and exits. New messages may arrive from that work — from child objectives reporting back, from Max asking questions, from schedules firing — and each new batch of messages triggers another agent turn. The engine never maintains long-running agents. Every turn is a fresh spawn, fresh context, fresh work, then exit.

Two special objectives exist as permanent anchors: `root` (the top of the tree, the ultimate "why") and `quick` (a catch-all inbox for unattributed messages from the search bar). Both are protected — they can never be resolved, failed, or abandoned.

---

## Startup and Recovery

When the engine starts (`startEngine` in `loop.ts`), the first thing it does is identify which machine it's running on. Machine identity comes from the hostname, mapped to a short name (`mini` or `macbook`). The mac mini is treated as the coordinator; anything else is a worker. This shapes which objectives the engine claims and how it reports results.

Before polling begins, the engine scans for objectives stuck in `thinking` status. `Thinking` means "an agent is actively running right now." If the engine crashed mid-turn, some objectives may have been left in `thinking` state permanently. On startup, every one of these gets reset to `needs-input` and logged. This is crash recovery — the system can always restart cleanly.

Then the engine fires its first poll immediately, and sets up a 5-second interval for all subsequent polls.

---

## The Poll Cycle

Every 5 seconds, the engine runs its poll function. It does four things in order.

**Schedules first.** Before looking at objectives, the engine checks whether any scheduled messages are due. Schedules are rows in a `schedules` table with a `next_at` timestamp. Any schedule whose `next_at` has passed gets fired: its message is inserted into the target objective's inbox, and the schedule either bumps forward (if it has a recurring interval) or gets deleted (if it was one-shot). Intervals are expressed as strings like `5m`, `1h`, or `1d`, parsed into seconds by `parseInterval`.

**Stale pruning.** Once per hour (tracked by `lastPruneTime`), the engine prunes idle objectives that haven't been touched in 14 days. The rule is specific: the objective must be idle, must have a parent, must not be `root` or `quick`, and must have no unprocessed messages in its inbox. Objectives that meet all these criteria get set to `abandoned`, and their own children get cascade-abandoned recursively. This is housekeeping — dead branches that haven't moved in two weeks get cleared.

**Backup health check.** Also once per hour, the engine reads `~/.aria/backup-status.json` and checks whether the last backup succeeded and how old it is. If the backup is stale (over 25 hours) or failed, the engine logs a warning. This is purely observational — it doesn't take any action, just surfaces the problem in logs.

**Objectives with work to do.** This is the main event. The engine queries for pending objectives: those that have at least one inbox message with no `turn_id` (meaning it hasn't been processed yet), and whose status is either `idle` or `needs-input`. Results come back ordered by urgency first, then importance, then age — so urgent objectives always get attended to before lower-priority work.

The engine filters this list to only objectives assigned to the current machine. Unassigned objectives default to the `mini`. Then it iterates, checking two gates before spawning each one.

---

## Concurrency and Max-Activity Gates

Before spawning any agent, the engine checks two things.

The first is a hard concurrency ceiling. The system tracks how many objectives are currently in `thinking` status — meaning agents actively running — and caps this at 3. The moment that count hits 3, no more agents get spawned until one of the running ones finishes. This prevents resource exhaustion from runaway parallelism.

The second gate is Max-activity awareness. If Max sent a message in the last 15 minutes, the engine considers Max to be "active." When Max is active, the engine applies a filter: it will only spawn agents for objectives that are marked urgent, or that have an unprocessed message specifically from Max. Background work — child objectives reporting results, system-triggered items, non-urgent processing — all gets held until Max goes quiet. The rationale is efficiency: when Max is in a conversation, burn compute on what he's directly working on, not on background housekeeping.

If neither gate blocks, `spawnTurn` gets called.

---

## Spawning a Turn

`spawnTurn` (in `spawn.ts`) prepares and launches a Claude process for one objective. It does this in a deliberate sequence.

The objective's status flips to `thinking` immediately. This is the first write — it claims the objective and makes it invisible to concurrent polls before anything else happens.

Then the engine collects all unprocessed inbox messages for this objective: every row in the `inbox` table for this objective where `turn_id` is null. These are the messages the agent needs to respond to.

Next, context assembly. The engine calls `assembleContext` with nine "bricks" — modular context components that each render a section of the system prompt. In order: PERSONA (who Aria is), CONTRACT (how the system works, the rules), ENVIRONMENT (current date, time, machine), OBJECTIVE (this objective's name, description, status, age, turn count), PARENTS (the ancestor chain from root down), SIBLINGS (other objectives with the same parent), CHILDREN (sub-objectives under this one), SIMILAR_RESOLVED (past objectives with similar text that were resolved, with their summaries), and CONVERSATION (the last 10 messages in this objective's inbox). All nine bricks render and their outputs get joined with `---` separators into a single system prompt string, written to a temp file at `/tmp/aria-context-{objectiveId}.md`.

The inbox messages get formatted into a user message. Context messages (from the system or other objectives) come first; Max's messages come last. Each message gets labeled with the sender's relationship to the current objective: `[max]`, `[parent:abc123 "Parent objective"]`, `[child:def456 "Child objective"]`, `[sibling:ghi789 "Sibling"]`, or `[system]`. This labeling tells the agent exactly who is talking and what their relationship is.

A turn record gets created in the `turns` table, incrementing the turn number for this objective. Then all the unprocessed inbox messages get stamped with this turn's ID. The stamp is critical — it's what prevents the same messages from triggering another agent spawn while this one is running. A message with a `turn_id` is a processed message, invisible to the pending-objectives query.

Finally, `claude -p` gets spawned as a child process. The user message goes in as the `-p` argument, the system prompt file via `--system-prompt-file`, with `--output-format stream-json --verbose` for structured output, and tools restricted to `Bash, Edit, Read, Write, Glob, Grep`. The model comes from the objective's `model` field, defaulting to `sonnet`. The working directory comes from the objective's `cwd` field, defaulting to `$HOME`. The objective's ID is passed in as `ARIA_OBJECTIVE_ID` environment variable — this is how the agent knows who it is when running `aria` commands. Stdin gets closed immediately; this is a one-shot prompt, not an interactive session.

---

## Processing the Agent's Output

`processOutput` (in `output.ts`) handles the agent's NDJSON stream asynchronously while the process runs.

The stream comes in as newline-delimited JSON. The engine accumulates bytes into a buffer and parses complete lines as they arrive. Each parsed frame has a `type` field.

`system` frames carry initialization info — specifically the `session_id`, which gets written to the turn record. This is how the turn links to a specific Claude conversation session.

`assistant` frames are the meaty ones. Each carries a `message.content` array of blocks. Text blocks update `lastAssistantText` (always overwriting, so the engine ends up with the agent's final response) and also emit to any active stream subscribers. Tool-use blocks get checked: if the tool is `Bash` and the command starts with `aria `, the engine logs it to stderr so it's visible in the process output.

`user` frames (tool results flowing back in) are ignored — the engine doesn't need to track those.

`result` frames signal the Claude CLI's notion of completion, but the engine waits for the process `close` event to finalize.

When the process closes, the engine does the turn-completion logic. It reads the objective's current status from the database. Here's the key rule: during its turn, the agent may have changed its own status by running `aria` commands — setting itself to `idle` (via `aria wait`), or having a child's result flow in and trigger a status change, or any other state transition. If the status is still `thinking` when the process exits, that means the agent didn't explicitly set a final state, and the engine defaults it to `needs-input`. The assumption is: if you didn't finish, you need help.

Then the agent's final response text gets stored back into the objective's own inbox as a `reply` message, stamped with the current `turn_id` so it doesn't re-trigger the engine. This creates the conversation record — every agent response is preserved in the inbox.

After that, the engine looks at who sent messages in this turn (by querying `inbox WHERE turn_id = ?` for non-Max, non-system, non-self senders). These are child objectives that sent messages that triggered this turn. Each one gets a copy of the agent's response in their own inbox — as an unprocessed message, so the engine will pick them up and spawn agents for them in subsequent polls. This is the return path: a child reports a result, the parent processes it, the parent's response goes back to the child, the child wakes up and sees the reply.

In worker mode (running on the MacBook rather than the mini), the completed turn's data — status, response text, session ID — gets POSTed to the coordinator at `http://mac-mini:8080/api/worker/turns/{turnId}/complete`. The coordinator stores the result and updates the shared database. This is how multi-machine results flow back: the worker does the computation, the coordinator records it.

Finally, the temp context file at `/tmp/aria-context-{objectiveId}.md` gets deleted.

---

## Stuck Detection

In the same poll cycle, after processing pending objectives, the engine checks for stuck objectives. A stuck objective is one that has been in `thinking` status for more than 10 minutes without `updated_at` advancing. This catches cases where an agent spawned but died silently, or hung, without updating the database.

For each stuck objective, the engine increments its `fail_count`. If the fail count is still below 3, the objective gets reset to `idle` — it'll get picked up in a future poll. If it hits 3 consecutive failures, the engine sets it to `needs-input` and inserts a system message explaining that it has failed this many times and needs Max's attention. At that point, a human needs to intervene.

---

## The Context System

The nine bricks that assemble into a system prompt are each responsible for one slice of context. They're not independent in what they produce — they're designed together to give the agent a complete picture of its situation.

PERSONA and CONTRACT are static bricks, loaded from markdown files on disk. They don't change per-objective or per-turn. PERSONA is two sentences: "You are Aria. You exist to help Max thrive and succeed. You always read your objective and messages before doing anything else." CONTRACT is the full agent operating manual — the theory of objectives, the six statuses, how resolution works, scope rules, every `aria` command with its syntax. An agent waking up for its very first turn on any objective has the complete rulebook in its context.

ENVIRONMENT gives the agent the current date, time, and machine name. This is rendered fresh each time.

OBJECTIVE gives the agent its own identity: the objective text, description if any, current status (including `waiting_on` text if set), and metadata — which turn number this is, how many days ago the objective was created, and how many days since the last status change.

PARENTS traces the ancestry chain from the root down to this objective, formatted as an indented "WHY CHAIN." Every level shows the objective text and whether it's the root. The agent can look up this chain to understand why its work matters.

SIBLINGS lists other objectives that share the same parent, with their statuses. This tells the agent what parallel work is happening alongside its own.

CHILDREN lists this objective's sub-objectives. The first five get detailed treatment — their status and their most recent inbox message, giving the agent a quick sense of where each sub-objective stands. Beyond five, they're listed with just status. Beyond twenty, the count is shown and the agent is told to use `aria find` to explore.

SIMILAR_RESOLVED searches the FTS index for past resolved objectives with text similar to the current one, including their resolution summaries. This is institutional memory — "we did something like this before, here's how it turned out."

CONVERSATION renders the last 10 messages in the objective's inbox, using the same sender-labeling as the user message format. This gives the agent its recent history before the current batch of messages.

Token counting uses a simple heuristic: `ceil(text.length / 4)`. No tiktoken, no model-specific encoding. The system defines token budgets per model (80K for sonnet at 40% of its 200K window, 500K for opus at 50% of its 1M window, 60K for haiku at 30%). But as of the current code, these budgets are defined in `models.ts` and passed into the assembler context, but no brick actively trims content to fit within them — the bricks render everything they have and return a token count, but no pruning logic cuts content when the budget is exceeded.

---

## The Nudge Mechanism

When the HTTP server receives a message — whether from Max typing in the UI, from the `POST /api/objectives/:id/message` endpoint, or from a new objective being created with instructions — it calls `nudge()`. The nudge function clears the current poll interval and immediately runs a poll, then resets the interval. This means new messages get attention within milliseconds rather than waiting up to 5 seconds for the next scheduled poll. The engine is still interval-driven, but messages get priority by jumping the queue.

---

## The HTTP Server

The server (`server/index.ts`) is a plain Node.js HTTP server with no framework. Routes are matched manually using a simple pattern-matching helper that maps URL segments to named parameters.

The API surface covers the full lifecycle of objectives: read the tree, read a single objective with its children, read a conversation, create objectives, send messages, resolve or fail or reject objectives, mark as waiting, and search by keyword. Most mutation endpoints call `nudge()` after inserting messages to ensure prompt pickup.

Two endpoints support the multi-machine worker pattern. `GET /api/worker/objectives?machine=X` returns pending objectives assigned to a given machine, with their unprocessed messages. `POST /api/worker/turns/:turnId/complete` accepts the result of a completed turn and writes it into the coordinator's database — this is how worker results come back.

The `/api/message` endpoint is a smart router for the search bar. When a message arrives without a specific target objective, the server runs an FTS search against all active objectives. If there's no match, it creates a new child of `quick` and sends the message there. If there's exactly one confident match (or the top match is significantly stronger than the second), it routes directly. If the match is ambiguous, it returns a list of candidates for the UI to present as a picker.

The server also manages a WebSocket connection used by the React surface. Each connected client gets an immediate snapshot of the objective tree, then receives updates every 500ms if the tree has changed (a simple JSON comparison catches any difference). Clients can also subscribe to a specific objective's live turn stream by sending a `watch_objective` message. When the engine emits text from a running agent via `emit()` in `streams.ts`, it flows through to any watching WebSocket clients in real time.

TTS (text-to-speech) requests are also handled over WebSocket. A client sends a `tts_request` with text and a request ID; the server synthesizes audio in a streaming fashion and sends audio chunks back as `tts_audio` frames.

---

## The Streams Bridge

`streams.ts` is a small but important piece. It's a module-level map from objective ID to an array of callbacks. When `processOutput` emits text from a running agent, it calls `emit(objectiveId, text, false)`. When the turn completes, it calls `emit(objectiveId, '', true)`. The WebSocket server subscribes to these emissions via `subscribe(objectiveId, callback)` when a client starts watching an objective. The bridge is in-process — output flows directly from the engine to the server without any intermediate queue or IPC.

---

## Multi-Machine Architecture

Two machines run the system: the mac mini (coordinator) and the MacBook (worker). Each has its own SQLite database in iCloud at `~/aria/data/{machine}.db`. The coordinator (`mini`) runs the full engine and HTTP server. The worker (`macbook`) runs an engine too, but in worker mode.

In worker mode, after a turn completes, the result gets POSTed to the coordinator's `/api/worker/turns/:turnId/complete` endpoint. The coordinator writes the result into its own database as the canonical record.

For reading, the coordinator can optionally attach the peer's database as a SQLite `ATTACH DATABASE`. The `withPeer` function in `unified.ts` manages this: it checks whether the peer DB file exists, attaches it as `peer`, runs the callback, then detaches. Reads that need to span both machines use UNION ALL queries that combine local and peer tables, deduplicating by ID. This attachment happens on demand and is re-checked every 30 seconds — if the peer file disappears (e.g., the MacBook goes offline and iCloud sync lags), the system falls back to local-only without crashing.

The `getTreeUnified`, `getObjectiveUnified`, `getConversationUnified`, and `getChildrenUnified` functions in `queries.ts` are the read-path entry points that use this pattern, though the current engine loop itself only queries the local database — peer-awareness is surfaced at the API/UI layer rather than in the core engine loop.

---

## Scope Enforcement

The `aria` CLI commands that agents run have scope constraints enforced at validation time (`commands/registry.ts`). `succeed`, `fail`, and `reject` require that the target objective be a descendant of the caller — the system walks the parent chain to verify ancestry. An agent cannot resolve an objective it didn't create. It also cannot resolve itself; only its parent can do that. The root and `quick` objectives are additionally protected and return a 403 if anything tries to resolve or fail them. `tell` has no scope restriction — any agent can message any other objective. `wait` operates only on the caller's own objective. These constraints enforce the tree's authority structure: parents judge children, not the other way around.

---

## The Status Lifecycle in Full

Every objective starts `idle`. An agent turn sets it to `thinking`. When the turn ends, the objective is either in a state the agent set (via `aria wait` setting it back to `idle` with a `waiting_on` reason, or a parent calling `succeed`/`fail`/`reject` on it through a CLI command), or it falls back to `needs-input` if nothing changed. `resolved`, `failed`, and `abandoned` are terminal — once set, they don't change. Resolved and failed are set explicitly. Abandoned is set by cascade: when a parent resolves, all of its non-terminal children get abandoned recursively.

The distinction between `idle` and `needs-input` is intent. `Idle` means "waiting for something, possibly known (waiting_on field), possibly just not yet started." `Needs-input` means "an agent ran and couldn't finish — a human or parent needs to look at this." The engine treats them identically for spawning purposes (both are eligible), but the UI can render them differently, and the stuck-recovery system specifically sets failing objectives to `needs-input` to make them visible.

---

## What the Agent Actually Sees

When an agent wakes up, its system prompt contains, in order: who it is (PERSONA), the complete rule system (CONTRACT), the current date and time (ENVIRONMENT), its own objective and status (OBJECTIVE), its ancestry chain (PARENTS), its sibling objectives (SIBLINGS), its children with statuses and last messages (CHILDREN), similar resolved objectives (SIMILAR_RESOLVED), and its recent conversation history (CONVERSATION). Its user message contains all the inbox messages that triggered this turn, labeled by sender relationship.

The agent has access to six tools: Bash, Edit, Read, Write, Glob, Grep. The `aria` CLI is available as a Bash command, and the engine intercepts `aria ` prefixed Bash calls to log them. The agent can read any file, edit code, run shell commands, and use `aria` to manage the objective tree. It cannot access the internet directly (no WebFetch or WebSearch in the allowed tools list).

When the agent finishes, it exits. Its response text is stored in its inbox. The engine routes that response to whoever triggered the turn. The next poll — at most 5 seconds away — will find any newly unprocessed messages and spawn the next round of agents. The system is always in motion.
