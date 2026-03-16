# CLI

The CLI (`src/cli/index.ts`) is the primary human and agent interface to the Aria engine. It handles both interactive terminal use and programmatic calls from agent turns. Every command follows the same basic shape: parse arguments, validate them, open the database, do the work, output the result, close the database.

## Entry and Dispatch

The CLI is a Node.js script invoked directly as `aria <command> [args...]`. Dispatch is a straightforward switch on `process.argv[2]`. The remaining args (`process.argv.slice(3)`) are passed as a raw array to each command function, which then handles its own parsing. If the command token is absent, `--help`, `-h`, or `help`, the help text is printed and nothing runs. An unrecognized command prints the help text and exits with a non-zero code.

## Argument Parsing

The shared `parseFlags` function handles the argument style used across commands. It separates positional arguments from named flags. A token starting with `--` is a flag. If the next token doesn't also start with `--`, it's treated as that flag's value and consumed — otherwise the flag is recorded as a boolean `true`. Everything else accumulates as a positional. This means commands like `aria notify "message" --urgent --important` work naturally: the message is positional, the flags are boolean.

Interval strings (used by `schedule`) are parsed separately by `parseInterval` in `parse-interval.ts`. It accepts a number followed by a single unit: `s` for seconds, `m` for minutes, `h` for hours, `d` for days. Combinations aren't supported — it's one unit per string. Invalid formats return `null`, which the caller treats as an error.

## Dual-Mode Output: TTY vs JSON

The most pervasive design decision in the CLI is the dual output mode. At startup, `process.stdout.isTTY` is checked and stored in `isTTY`. Every command that produces output uses this to choose between two formats.

When running in a terminal, output is human-readable: colored text, truncated names, tree connectors, relative labels. When stdout is a pipe (non-TTY), every command switches to clean JSON on stdout. This is how agents consume CLI output — they call `aria` as a subprocess and parse the JSON. The human and machine interfaces are the same binary, same command, different rendering.

Color is applied through a `color` helper that wraps strings in ANSI escape codes only when `isTTY` is true. In non-TTY mode, the same functions return the string unchanged. Status values get their own coloring: `idle` is dim, `thinking` is yellow, `needs-input` is cyan, `resolved` is green, `failed` is red, `abandoned` is strikethrough.

## Scope and Authorization

Several commands only make sense in certain contexts. The registry defines four scope types for commands:

**`none`** — No access restriction. Anyone can call it anywhere. `tree`, `show`, `find`, `inbox`, `schedule`, `schedules`, and `schedules` are all scope-none; they're read-only or globally applicable.

**`self`** — The command operates on the calling objective's own state. `wait` is the only self-scoped command. It requires `ARIA_OBJECTIVE_ID` to be set, because there's no meaningful target to act on without knowing who is calling.

**`descendant`** — The command can only target objectives that are children or descendants of the caller. `succeed`, `fail`, and `reject` all carry this scope. This is the core ownership rule: you can only close out objectives you created. The `isDescendantOf` helper in `registry.ts` enforces this by walking the parent chain upward from the target, checking if it reaches the caller. Max bypasses this check — when `callerId` is `'max'` or absent, all descendant-scoped commands proceed without the ancestry check.

**`any`** — No target restriction, but the target must exist. `tell` uses this scope — you can send a message to any objective in the system, but you can't tell a non-existent one.

## The Command Registry

`src/commands/registry.ts` serves two purposes. First, it holds the canonical definition of every command: name, syntax string, argument specs (positional vs named, required vs optional, type), scope, and description. Second, it exports a validation function for each command that enforces the rules before any database work happens.

Each `validateX` function returns `null` on success or an error string on failure. The caller prints the error to stderr and exits non-zero. This separation keeps the validation logic testable and reusable — the same validators run whether the command comes from a human at a terminal or an agent in an engine turn.

The validation functions enforce several categories of rules. Missing required arguments produce usage strings from the canonical syntax. Empty strings for required text arguments are rejected with messages that explain why the argument matters (e.g., `aria succeed` requires a non-empty summary because the summary is what the parent reads to understand what happened). Terminal statuses block state-changing commands — you can't succeed, fail, or reject something already resolved, failed, or abandoned. Self-targeting is blocked: an objective cannot succeed, fail, or reject itself. And the ancestry check described above enforces ownership for descendant-scoped commands.

## Commands and What They Do

`create` makes a new child objective. The parent ID comes from `ARIA_OBJECTIVE_ID` in the environment, defaulting to `'root'`. The model can be specified with `--model`, defaulting to `'sonnet'`. If instructions are provided as a second positional, they're inserted as an inbox message from the caller into the new objective's conversation immediately after creation.

`tree` fetches all objectives from the database via `getTreeUnified`, builds an in-memory tree structure by grouping objectives by their parent ID, then either prints it as an ASCII tree with connectors (TTY) or serializes it as nested JSON (non-TTY). The tree builder is recursive: it maps each node's children by looking up its ID as a parent key.

`show` displays the full detail of one objective — ID, text, status, parent, child count, description, waiting-on reason, and timestamps. Children are fetched separately to get the count.

`inbox` shows the conversation for an objective. Messages are fetched via `getConversationUnified`, limited to the `--limit` flag (default 50). In TTY mode, each message is labeled with its sender's relationship to the objective — `max`, `parent`, `child`, `sibling`, or `system` — each colored differently. A bullet `•` marks messages that aren't part of a completed agent turn (`turn_id` is null), giving a quick visual cue for messages the engine hasn't processed yet.

`send` inserts a message into an objective's inbox with sender set to `'max'`. This is the human-facing alias for sending messages, as distinct from `tell` which is agent-facing. Mechanically they're nearly identical — the difference is semantic, surfaced by the sender label downstream.

`tell` inserts a message into any objective's inbox with sender set to the calling objective's ID (or `'max'` if no `ARIA_OBJECTIVE_ID` is set). It's the agent equivalent of `send` — an objective uses `tell` to communicate laterally or upward in the tree.

`succeed` resolves a child or descendant objective. It validates scope, checks for protected IDs (which cannot be closed by command), updates the objective's status to `'resolved'`, stores the resolution summary via `setResolutionSummary`, then cascades abandonment to any active children of the resolved objective. Two messages are inserted: one into the resolved objective's own conversation (as a system reply with the summary), and one into the parent's inbox announcing the resolution with the format `[resolved] <objective text>: <summary>`. The parent sees the notification as a message from the resolved child's ID.

`fail` marks an objective as failed and notifies the parent with a `[failed]` message. Unlike `succeed`, it doesn't cascade — failing an objective doesn't automatically abandon its children.

`reject` is the retry mechanism. It sets the target back to `'idle'`, clears any `waiting_on` state, and inserts the feedback as a regular message into the target's inbox. The objective will be picked up by the engine on its next tick and get another turn, now with the feedback in its conversation.

`wait` sets the calling objective to a waiting state. It records the reason via `setWaitingOn` and sets status to `'idle'`. The engine will see this objective as idle but with a `waiting_on` field set, which influences how context is assembled for future turns.

`notify` is for an objective to surface something directly to Max. It always writes to stdout (this is the one command that bypasses the TTY-gating for its main output). It inserts a `[notify]` signal into the root objective's inbox, then checks whether Max is in deep work via `isDeepWork`. If he is and the notification isn't marked urgent, it's suppressed with a printed note. Otherwise, it fires a macOS notification via `terminal-notifier` — a fire-and-forget subprocess call. The notification title is decorated with `[!!]` for urgent+important, `[!]` for either, or plain `ARIA` for neither. The notification links to `http://localhost:8080` so clicking it opens the surface.

`find` does a keyword search via `searchObjectives` and renders results as a flat list (TTY) or JSON array (non-TTY).

`context` assembles the full context prompt for an objective, using the same brick pipeline the engine uses. With a `--tui` flag, it launches an interactive terminal UI for inspecting the context. With `--dump` or no flag, it prints the assembled prompt with a token budget summary. Without an objective ID, it runs the static bricks only (persona, contract, environment, similar).

`schedule` creates a recurring or one-time message to be delivered to an objective. The interval string is parsed with `parseInterval` and stored as seconds. The `next_at` timestamp is computed as now + interval seconds. The engine's tick loop checks this table and delivers due messages.

`schedules` lists active schedules, optionally filtered by objective ID.

## Startup Modes

`engine` and `up` are aliases. They initialize the database, start the engine loop, start the HTTP server (serving both the API and the built surface at `surface/dist/`), and register SIGINT/SIGTERM handlers for clean shutdown.

`dev` is the development mode. It spawns two child processes: one running `aria engine` as a subprocess (piping its output to the parent's stdout/stderr), and one running Vite's dev server for the surface at port 5173 (with its output prefixed in magenta). SIGINT from the terminal propagates to both children, gives them 2 seconds to exit cleanly, then exits the parent.

The distinction between `up`/`engine` and `dev` is the surface: production serves a pre-built static bundle from `surface/dist/`, development runs the Vite hot-reload dev server instead. The engine process itself is identical in both cases.
