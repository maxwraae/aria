# ARIA Engine

Autonomous objective management system. Objectives are desired states organized in a tree, each served by AI agents that wake on incoming messages, do work, and report back. The root objective ("Help Max thrive and succeed") never resolves -- everything else chains up to it.

## Project Structure

```
engine/
├── src/
│   ├── cli/
│   │   └── index.ts          # CLI entry point — all `aria` commands
│   ├── context/
│   │   ├── assembler.ts       # Builds full system prompt for agent turns
│   │   └── layers/
│   │       ├── contract.ts    # Agent contract (rules, tools, resolution logic)
│   │       ├── objective.ts   # Objective context (self, ancestors, siblings, children)
│   │       └── conversation.ts # Recent conversation history for the objective
│   ├── db/
│   │   ├── schema.ts          # SQLite schema + init (objectives, inbox, turns, schedules)
│   │   ├── queries.ts         # All DB operations (CRUD, inbox, turns, FTS search)
│   │   └── utils.ts           # ID generation + timestamp helper
│   └── engine/
│       ├── loop.ts            # Main poll loop — finds pending objectives, spawns turns
│       ├── spawn.ts           # Spawns `claude -p` with assembled context per objective
│       ├── output.ts          # Processes NDJSON stream from claude, routes results
│       └── concurrency.ts     # Concurrency limits + Max-active detection
├── test-engine.sh             # Integration test suite (DB init, CRUD, inbox, context)
├── test-context.ts            # Test helper for context assembly and engine queries
├── package.json
└── tsconfig.json
```

## Key Concepts

**Objectives** -- Desired states, not tasks. Organized in a parent-child tree. Statuses: `idle`, `thinking`, `needs-input`, `resolved`, `failed`, `abandoned`.

**Inbox** -- Message queue per objective. Messages from Max, parent, children, or system. Unprocessed messages trigger agent turns.

**Turns** -- One agent invocation. The engine collects unprocessed messages, assembles context, spawns `claude -p`, and processes the output. Each turn is recorded with a session ID.

**Context Assembly** -- Each agent turn gets a system prompt built from layers: persona, contract (rules of the system), environment, objective tree context, and recent conversation.

**Concurrency** -- Max 3 concurrent `thinking` objectives. When Max is active (message within 15 min), only Max's messages and urgent items get processed.

## Database

SQLite at `~/.aria/objectives.db`. Tables:

- `objectives` -- The tree. Has FTS5 via `objectives_fts`.
- `inbox` -- Messages per objective. `turn_id IS NULL` = unprocessed.
- `turns` -- Turn history per objective with session IDs.
- `schedules` -- Recurring message delivery (schema exists, not yet wired).

## CLI

```bash
# Run via tsx
npx tsx src/cli/index.ts <command>

# Or after build
node dist/cli/index.js <command>
```

### Commands

```
aria create "desired state" ["instructions"]    # New child objective (default parent: root)
aria tree                                       # Show objective tree
aria show <id>                                  # Show one objective
aria send <id> "message"                        # Send message as Max
aria inbox <id>                                 # Show conversation
aria succeed <id> ["summary"]                   # Resolve objective
aria fail <id>                                  # Fail objective
aria wait "reason" [--id <id>]                  # Mark as waiting
aria tell <id> "message"                        # Message a child (uses ARIA_OBJECTIVE_ID as sender)
aria notify "message" [--important] [--urgent]  # Signal to root
aria find "query"                               # FTS search
aria engine                                     # Start the engine loop
```

Outputs JSON when piped (non-TTY), colored text when interactive.

### Flags

- `--parent <id>` -- Set parent on create (default: `root`)
- `--model <model>` -- Set model on create (default: `sonnet`)

## Engine

```bash
npx tsx src/cli/index.ts engine
```

Polls every 5 seconds. For each objective with unprocessed inbox messages:

1. Sets status to `thinking`
2. Assembles context (persona + contract + environment + objective tree + conversation)
3. Writes system prompt to `/tmp/aria-context-<id>.md`
4. Spawns `claude -p` with the user message (bundled inbox messages)
5. Parses NDJSON output stream, captures session ID and assistant text
6. On exit: stores result in objective's inbox, routes responses to message senders, resets status

Stuck detection: objectives in `thinking` for >10 minutes get reset. After 3 failures, set to `needs-input`.

## Tests

```bash
./test-engine.sh
```

Covers DB init, root seeding, idempotent re-init, FTS, objective CRUD, tree structure, inbox messaging, context assembly, and engine queries.

## Development

```bash
npm install
npm run dev          # tsx watch mode
npm run build        # tsc → dist/
```

Requires Node.js with ES2022+ support. Uses `better-sqlite3` for the database and `tsx` for TypeScript execution.
