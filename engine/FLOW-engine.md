# ARIA Engine

ARIA is an autonomous objective engine. It manages a tree of objectives — desired states of the world — and spawns AI agents to make them true. The whole system is message-driven: objectives have inboxes, messages trigger agent turns, and agents communicate by sending messages to each other. A single polling loop watches for unprocessed messages and spawns Claude instances to handle them.

## Objectives Are States, Not Tasks

The fundamental unit is an objective: a desired state that's either true or not yet true. "The kitchen wall is painted" is an objective. So is "Help Max thrive and succeed," which is the permanent root that never resolves. Every objective sits in a tree, each one serving a parent. The chain always reaches the root. This nesting means any objective can answer both "why does this matter?" (look up) and "how does this get done?" (look down at children).

Objectives live in a SQLite database at `~/.aria/objectives.db`, managed through the schema in `db/schema.ts`. Each objective carries a status, a model preference (defaulting to Sonnet), an optional `waiting_on` reason, a fail count, and priority flags for importance and urgency. There's also a full-text search index across objective names, descriptions, waiting reasons, and resolution summaries, so agents can find related work by keyword.

The root objective is seeded automatically when the database initializes. It has no parent and can never be resolved or failed. Everything else descends from it.

## The Six Statuses

An objective moves through a small state machine. **Idle** is the resting state — work isn't happening right now, but the objective isn't done. An idle objective might have a `waiting_on` value indicating something external is blocking progress, but waiting isn't a separate status. **Thinking** means an agent is actively running on it. The engine sets this when it spawns a turn and clears it when the agent exits. **Needs-input** means the agent couldn't finish and needs Max's attention — it asked a question, proposed something, or hit a decision point. **Resolved** means the desired state is now true. **Failed** means it was attempted and can't happen. **Abandoned** means the parent was resolved through a different path, making this objective irrelevant.

Resolution has an important cascading behavior. When an objective resolves, all its remaining idle or needs-input children are automatically abandoned through `cascadeAbandon` in `db/queries.ts`. This is recursive — if those children have their own active children, they get abandoned too. The logic is simple: if the parent's desired state is already true, the sub-objectives no longer matter.

## Messages and the Inbox

Every objective has an inbox. Messages arrive from Max, from parent objectives, from child objectives, or from the system itself. Each message records who sent it, when, and whether it's been processed. The critical field is `turn_id`: a null `turn_id` means the message hasn't been handled yet. This is what makes the whole engine go.

When a message is inserted via `insertMessage` in `db/queries.ts`, it also touches the objective's `updated_at` timestamp. Messages are typed — regular messages, replies, and signals — though the type is mostly cosmetic in the current system except for how messages get formatted in context.

The sender identity carries real meaning. `getSenderRelation` in `db/queries.ts` determines the relationship between a message sender and the receiving objective: is this from Max, from my parent, from one of my children, from a sibling, or from something else entirely? This relationship gets rendered as a label in the agent's context, so the agent knows who it's talking to and can respond appropriately.

## The Engine Loop

The engine is a poll loop that runs every 5 seconds, implemented in `engine/loop.ts`. On startup, it does one important recovery step: any objectives stuck in `thinking` status from a previous crash get reset to `needs-input`. This prevents orphaned objectives from blocking the system permanently.

Each poll cycle does two things. First, it looks for objectives that need attention — objectives with unprocessed messages (null `turn_id`) that are in `idle` or `needs-input` status. The query in `getPendingObjectives` joins the objectives table with the inbox, finding distinct objectives that have at least one unprocessed message. Results are ordered by urgency first, then importance, then creation time.

For each pending objective, the engine checks two gates before spawning. The first is concurrency: no more than 3 agents running simultaneously, tracked by counting how many objectives are currently in `thinking` status. The second is a courtesy mechanism around Max's activity. If Max sent any message anywhere in the system within the last 15 minutes (tracked by `getLastMaxMessageTime`), the engine considers Max "active" and becomes selective. In active mode, it only fires on urgent objectives or objectives where Max himself sent an unprocessed message. Background work waits. This prevents the engine from burning compute on low-priority objectives while Max is in conversation.

The second thing each poll cycle does is recover stuck objectives. If an objective has been in `thinking` for more than 10 minutes, something went wrong — the agent probably crashed or hung. The engine increments the objective's fail count and resets it. If the fail count is under 3, it goes back to `idle` so the engine will retry on the next cycle. If it hits 3, the objective moves to `needs-input` and gets a system message telling Max it needs human attention. This is the circuit breaker: retry automatically, but don't retry forever.

## Spawning a Turn

When the engine decides an objective needs attention, `spawnTurn` in `engine/spawn.ts` handles the entire lifecycle. The sequence matters because it prevents double-processing.

The objective's status moves to `thinking` immediately. Then the engine collects all unprocessed messages from the inbox. It assembles a context document — the system prompt that will orient the agent — and writes it to a temp file at `/tmp/aria-context-{objectiveId}.md`. The unprocessed messages get formatted into a user message, with context messages (from other objectives and systems) ordered before Max's messages, so Max's voice comes last and carries the most weight. Each message gets a sender tag showing the relationship: `[max]`, `[parent:abc123 "Some objective"]`, `[child:def456 "Another objective"]`.

A turn record is created in the database with an incrementing turn number per objective. Then — critically — all unprocessed messages get stamped with the new turn ID. This is what prevents re-triggering: the messages now have a `turn_id`, so the next poll cycle won't pick up this objective again unless new messages arrive.

The agent itself is a Claude CLI process spawned with `-p` (prompt mode), using the assembled context as a system prompt file and the formatted messages as the user prompt. It runs with stream-json output format and a restricted tool set: Bash, Edit, Read, Write, Glob, and Grep. The objective's preferred model is passed through, and the `ARIA_OBJECTIVE_ID` environment variable tells the CLI commands which objective is running. The working directory defaults to the objective's `cwd` field, falling back to the user's home directory.

## Processing Agent Output

The output handler in `engine/output.ts` reads the NDJSON stream from the Claude process. It's looking for a few things. System init frames carry the session ID, which gets stored on the turn record for debugging. Assistant frames are parsed for text content — the last text block becomes the agent's final response. The handler also watches for `aria` CLI invocations inside Bash tool-use blocks, logging them to stderr so you can see what the agent is doing in the engine's output.

When the process closes, several things happen. If the objective is still in `thinking` status — meaning the agent didn't change its own status via CLI commands during the turn — it falls back to `needs-input`. The assumption is that if the agent didn't explicitly resolve, fail, or set itself to waiting, it probably needs Max.

The agent's final text response gets stored as a self-reply in the objective's own inbox, stamped with the current turn ID so it doesn't re-trigger the engine. Then the handler looks at who sent the messages that triggered this turn. For any non-Max, non-system sender that sent a message in this turn, the agent's response gets forwarded to that sender's inbox as a reply. This is the inter-objective communication loop: a child sends a message to its parent, the parent's agent runs a turn, and the response flows back to the child's inbox, potentially triggering the child's next turn.

The temp context file gets cleaned up after the turn completes.

## Context Assembly

Before an agent runs, it needs to understand who it is, what it's working on, and what's happened so far. The context assembler in `context/assembler.ts` builds this from five layers, separated by horizontal rules.

The **persona** layer is a short identity statement: you're an AI agent working for Max, you operate inside an objectives system, your job is to make your objective true.

The **contract** layer, in `context/layers/contract.ts`, is the longest section and the most important. It explains the entire objectives model to the agent: what objectives are, how they relate hierarchically, what each status means, how resolution and cascading work, and the scope rules governing what an agent can and cannot do. The key constraint: an agent cannot resolve or fail itself. Only its parent can do that. An agent does work, reports back, and its parent judges completion. This prevents objectives from prematurely closing themselves.

The contract also defines the CLI tools available to agents. `aria create` makes a child objective. `aria succeed` and `aria fail` close children (with required summaries/reasons — the system enforces this). `aria wait` marks the current objective as blocked on something external. `aria tell` sends a message to any objective. `aria notify` reaches Max directly with required importance and urgency flags. Read-only commands like `aria find`, `aria show`, `aria tree`, and `aria inbox` let the agent explore the objective tree.

The **environment** layer provides the current date, time, machine info, and database location.

The **objective** layer, from `context/layers/objective.ts`, gives the agent situational awareness. It shows the agent's own objective and status, the "why chain" of ancestors from root down to the current objective, any sibling objectives (same parent, different work), and the first 5 children in detail with their last message, plus up to 15 more in summary. This gives the agent enough context to understand where it sits in the tree and what's happening around it without overwhelming the prompt.

The **conversation** layer, from `context/layers/conversation.ts`, includes the last 10 messages from the objective's inbox with sender relationship tags. This is the agent's recent memory — what's been said, who said it, and in what order.

## The CLI

The `aria` CLI in `cli/index.ts` is the interface for both Max and the agents. It's dual-mode: when connected to a TTY (Max typing in a terminal), it outputs human-readable colored text. When piped or called programmatically by an agent, it outputs structured JSON. This means agents can parse results reliably while Max gets a friendly display.

The CLI dispatches to individual command handlers. Most commands open their own database connection, do their work, and close it. The `engine` command is special — it opens a persistent connection and starts the polling loop, with a SIGINT handler for clean shutdown.

Command validation lives in `commands/registry.ts`, which enforces scope rules. `succeed` and `fail` check that the caller is an ancestor of the target — you can only close objectives you created or that your descendants created. You can't succeed yourself. You can't succeed the root. You can't succeed something that's already resolved, failed, or abandoned. The validation also requires summaries and reasons, forcing agents to explain what happened rather than just flipping a status.

The `create` command parents the new objective under `ARIA_OBJECTIVE_ID` if set (meaning an agent is calling it), otherwise under root (meaning Max is calling it). If instructions are provided, they become the first message in the new objective's inbox, which will trigger the engine to spawn an agent for it on the next poll cycle.

The `notify` command is the agent's way of getting Max's attention directly. It requires both an importance flag and an urgency flag — the agent has to make an explicit judgment about how disruptive the notification should be. The notification gets stored as a signal-type message in the root objective's inbox.

The `wait` command sets the objective's `waiting_on` field and moves it back to `idle`. This is different from `needs-input` — waiting means something external (a reply from someone, a scheduled event, a dependency) is blocking, not that the agent is confused.

## The Communication Model

The whole system runs on a simple pattern: send a message, trigger a turn, get a response routed back. When a parent creates a child objective with instructions, those instructions land as a message in the child's inbox. The engine picks it up, spawns a turn, and the child's agent runs. When the child finishes, the output handler routes the response back to whoever triggered the turn.

Objectives can talk to any other objective via `aria tell`, but the scope rules for `succeed` and `fail` are strict — only ancestors can close descendants. This creates a natural hierarchy of control: work flows down, results flow up, and resolution authority stays with whoever delegated the work.

The `ARIA_OBJECTIVE_ID` environment variable is the thread connecting an agent's CLI calls back to its identity. When an agent calls `aria create`, the new objective automatically parents under the calling agent's objective. When it calls `aria wait`, it knows which objective to mark as waiting. When it calls `aria succeed` on a child, the validation checks ancestry against this ID.

## Failure and Recovery

The system has three layers of failure handling. The first is spawn errors — if the Claude binary can't be found or the process fails to start, the objective moves to `needs-input` and gets a system message explaining the spawn failure. The second is stuck detection — the 10-minute threshold with the 3-strike circuit breaker. The third is exit-without-resolution — if the agent process exits and the status is still `thinking`, it falls back to `needs-input`.

The fail count persists on the objective, so if an objective keeps crashing across multiple engine restarts, it still accumulates strikes. After the third failure, the engine stops retrying and asks Max to look at it. This prevents infinite loops on genuinely broken objectives.

## Data Flow Summary

A message arrives in an objective's inbox. The engine's next poll finds it (null `turn_id`, objective in `idle` or `needs-input`). If concurrency and activity gates pass, the engine stamps the messages, assembles context, and spawns a Claude agent. The agent reads its context (who am I, what's my objective, what's the conversation so far), reads the messages (what just happened), and acts — doing work directly, creating child objectives, sending messages to other objectives, or marking itself as waiting. When the agent exits, its response is stored and routed back to whoever triggered the turn. If the agent changed the objective's status via CLI commands, that status persists. If not, the objective falls back to `needs-input`. The context temp file is cleaned up, and the cycle waits for the next message.
