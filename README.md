# Aria

**Adaptive Recursive Intelligent Actions**

You give it an objective, any desired state that should be true but isn't yet, and it produces *actions* to make it true. That's what the system does. It acts. *Intelligent* actions, because each one is chosen with judgment, the highest-value move given what you know right now. *Recursive*, because every action's output becomes the next cycle's input, a loop that keeps turning until the objective is true. *Adaptive*, because the system learns across those cycles, updating its understanding from what came back, adjusting as reality teaches it what works.

Objectives live in a tree. At the top sits one that never resolves: *help Max thrive and succeed.* Below that, objectives get progressively more concrete until they're actionable enough for an agent to pick up and do. Each objective has an inbox. Messages arrive, an agent wakes up, observes, analyzes, acts, and exits. New messages wake it again. The cycle repeats until the desired state is true.

## The loop

Every objective runs the same cycle. **Observe**: read new messages, check what children reported, understand the current state. **Analyze**: connect what you just observed to what you already know, ask whether you have the knowledge to act. **Act**: do whatever the analysis pointed to, then exit. The agent doesn't persist between cycles, but conversation history does, so context accumulates. The agent who wins has the fastest cycle.

## Structure

```
Aria/
├── engine/                 TypeScript server, CLI, and agent engine
│   └── src/
│       ├── cli/            CLI commands (aria tree, aria create, aria send, ...)
│       ├── context/        Prompt assembly: modular "bricks" that build agent context
│       ├── db/             SQLite schema, queries, migrations
│       ├── engine/         The loop: polling, spawning agents, processing output
│       ├── memory/         Memory extraction from conversations
│       └── server/         HTTP API, WebSocket, static file serving
│
├── surface/                React frontend (Vite)
│   └── src/
│       ├── components/     UI: chat cards, input bar, objective cards, breadcrumbs
│       ├── hooks/          API client, WebSocket connection, audio
│       ├── constants/      Theme and styling
│       └── context/        React context (focused objective state)
│
└── data/                   SQLite databases (synced via iCloud)
    ├── macbook.db          Objectives database for MacBook
    ├── mini.db             Objectives database for Mac Mini
    └── memories.db         Extracted memories from agent conversations
```

## Running

**Development** (watch mode, hot reload):

```bash
cd engine && npm run dev       # Engine with file watching
cd surface && npm run dev      # Vite dev server on :5173
```

**Production**:

```bash
aria up                        # Engine + built surface on :8080
```

Or manually:

```bash
cd engine && npm run build && npm start
```

## CLI

```bash
aria tree                      # Show the full objective tree
aria show <id>                 # Inspect one objective
aria inbox <id>                # Read an objective's conversation
aria find "query"              # Search objectives

aria create "desired state" "instructions"   # Create a child objective
aria send <id> "message"                     # Send a message to an objective
aria succeed <id> "summary"                  # Resolve a child
aria fail <id> "reason"                      # Mark a child as failed
aria reject <id> "feedback"                  # Send back for another attempt
```
