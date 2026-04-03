# Server

The server is the public interface to the Aria engine — the thing you actually talk to, whether you're a browser, a voice client, a remote worker agent, or something sending a quick message over Tailscale. It's a single Node.js HTTP server with a WebSocket layer bolted on top, built without any framework, just the standard `http` module. Everything lives in `server/index.ts`, with text-to-speech functionality split into `server/tts.ts`.

## Startup and Connectivity

The server is started by calling `startServer`, which receives four things: the live SQLite database handle, a `nudge` function that wakes the engine loop, an optional path to the compiled frontend dist folder, and a port number (defaulting to 8080). It binds to `0.0.0.0` so it's reachable on all interfaces, not just localhost.

On startup, it also tries to activate a Tailscale HTTPS tunnel automatically. If the Tailscale CLI is installed at its standard macOS location, it runs `tailscale serve --bg <port>` in the background and logs the resulting HTTPS URL. This is why the server is reachable over Tailscale without any manual configuration — connectivity is assumed, not configured.

All responses carry permissive CORS headers (`Access-Control-Allow-Origin: *`) so that the Surface frontend, the CLI, and any remote caller can reach the API without origin restrictions. Preflight `OPTIONS` requests get a `204` with the allowed methods and headers, then exit.

## Routing

There's no routing framework. Each incoming request gets its URL parsed into a `pathname` and `method`, then falls through a chain of `if` blocks. The helper `matchRoute` does Express-style pattern matching — it splits both the pattern (like `/api/objectives/:id/conversation`) and the actual path into segments, matches literals exactly, and captures `:param` segments into a plain object. The first matching block wins; the rest never execute.

This keeps the routing logic entirely explicit. There's no middleware stack, no implicit behavior. If you want to know what happens to a `POST /api/objectives/:id/fail`, you find that block and read it.

## The Objective Tree API

The bulk of the API is CRUD over objectives — the nodes in Aria's task tree.

`GET /api/objectives` returns the full live tree: every objective that isn't resolved or abandoned, ordered so that root-level nodes come first and siblings are sorted by most-recently-updated. This is the flat list that the Surface uses to reconstruct the visual tree.

`GET /api/objectives/:id` returns a single objective plus its immediate children, assembled by calling `getObjective` and `getChildren` from the queries module. If the objective doesn't exist, it returns a 404.

`PATCH /api/objectives/:id` lets callers update an objective's name, description, or assigned machine. The body can contain any combination of `objective`, `description`, and `machine` fields — omitted fields are left alone. The queries module keeps the full-text search index (`objectives_fts`) in sync whenever these fields change, so search results remain accurate.

`POST /api/objectives` creates a new objective. The required field is `objective` (the title). Optional fields are `description`, `parent` (which node in the tree this lives under), and `model`. If `instructions` are also included in the body, they're immediately dropped into the new objective's inbox as a message from `max`, and the engine is nudged to start processing. This means you can create and prime an objective in a single request.

`GET /api/objectives/:id/conversation` returns the inbox messages for that objective, optionally limited by a `?limit=` query parameter. The default cap is 100 messages.

`POST /api/objectives/:id/message` adds a message to an objective's inbox and nudges the engine. The `sender` defaults to `max` if not specified. This is the direct way to talk to a specific objective when you know its ID.

## Status Transitions

Several routes change the lifecycle status of an objective.

`POST /api/objectives/:id/succeed` marks an objective as resolved. It requires a `summary` string, which gets stored as the objective's resolution summary and also written into the inbox as a `system` reply. If the objective has a parent, a `[resolved]` message is sent upward to the parent's inbox, so the parent agent knows the sub-task completed. Before resolving, any children of the objective that are still active (`idle` or `needs-input`) get cascade-abandoned — they're marked `abandoned` recursively down the tree. The `root` and `quick` IDs are protected and cannot be resolved through this route; attempts return a 403.

`POST /api/objectives/:id/fail` marks an objective as `failed`. It requires a `reason` string. Like succeed, if the objective has a parent, a `[failed]` message propagates upward. Protected objectives cannot be failed.

`POST /api/objectives/:id/reject` is for pushing back on an objective's last output without terminating it. It resets the status to `idle`, clears the `waiting_on` field (so the objective is no longer blocked), and inserts the provided `feedback` as a new message. The engine will then pick it up and run another turn. The `caller` field can identify who sent the feedback; it defaults to `max`.

`POST /api/objectives/:id/wait` suspends an objective by setting a `waiting_on` reason and resetting status to `idle`. This doesn't remove it from the tree — it just marks it as blocked, waiting for some external condition. The reason string is stored and returned.

## Smart Routing

`POST /api/message` is the frictionless entry point — you send text and the system figures out where it goes. This is designed for voice input, quick capture, or any situation where the user just has something to say and doesn't want to pick a destination manually.

The routing logic works like this: the message text is tokenized (non-word characters stripped, words shorter than three characters dropped) and run through SQLite's full-text search against active objectives. If nothing matches, a new objective is created under the `quick` bucket, the message is dropped in as the first instruction, and the engine is nudged. If exactly one objective matches, or if the top match scores more than 20% better than the second-best match (using FTS's negative ranking: more negative means a stronger match), the message is routed directly to that objective. If the matches are too close to call — multiple candidates with similar scores — the API returns the candidates with `routed: false`, so the frontend can present a picker and let the user decide.

The 20% confidence threshold is a deliberate design choice. FTS rank is a negative score, so the comparison checks whether `|topScore| > |secondScore| * 1.2`. This avoids blindly routing to the best guess when the signal is weak, while still routing automatically when the intent is clear.

## Worker API

The worker API is for external agent processes running on other machines (or the same machine, in separate processes). These agents poll for work, run their turns independently, and report back when done.

`GET /api/worker/objectives?machine=X` returns all objectives assigned to a given machine that have unprocessed inbox messages and are in an actionable status (`idle` or `needs-input`). For each matching objective, it includes the unprocessed messages, so the worker has everything it needs in one response. An objective is "assigned to a machine" when its `machine` field matches the query parameter — this is how work is distributed across multiple worker processes.

`POST /api/worker/turns/:turnId/complete` is how a worker reports the outcome of a completed turn. The body includes the objective's ID, the final status (`needs-input` by default if not provided), the assistant's last message text, and optionally a session ID. The server does several things in sequence: it stores the session ID on the turn record (for conversation continuity), sets the objective's status, inserts the assistant's response as a reply in the inbox, and then checks which other objectives sent messages in this turn. For each such "triggering sender" that isn't `max`, `system`, or the objective itself, the assistant's response is forwarded back to that sender's inbox. This is the mechanism by which agent-to-agent communication flows — a child objective's reply propagates back to the parent that asked.

## System Notifications

`POST /api/notify` is a lightweight channel for sending signals that don't belong to any particular objective. It writes a `[notify]` message into the root objective's inbox with a `signal` type. The `important` and `urgent` boolean fields are accepted but exist mainly for routing hints — they're echoed back in the response but not acted on by the server itself. The intent is that the Surface or another listener picks up signals on root and surfaces them to the user.

## Full-Text Search

`GET /api/search?q=` exposes the FTS index directly. It passes the query string to `searchObjectives`, which runs a SQLite FTS5 match against the `objectives_fts` table (which indexes objective title, description, waiting-on reason, and resolution summary). Results come back as full objective objects ordered by FTS rank.

## Static File Serving

If the server was started with a `surfaceDist` path, it also serves the React frontend as a static SPA. The logic is straightforward: if the request doesn't start with `/api/`, look for the corresponding file in the dist folder. A MIME type map covers the standard web asset types. HTML files are served with `no-cache` headers so refreshes always pick up the latest build. If the file doesn't exist — which happens for any client-side route that React Router handles — the server falls back to serving `index.html`, letting the SPA take over navigation. Path traversal is prevented by checking that the resolved file path still starts with the dist folder prefix.

## WebSocket

A WebSocket server (`ws` library) runs on the same port as the HTTP server, attached to the same underlying `http.Server` instance. Clients connect and receive state in two modes: a shared tree feed and a per-objective streaming feed.

When a client connects, the server immediately sends a `tree_snapshot` message containing the full active objective tree. It then starts a 500ms polling interval that re-fetches the tree and sends another `tree_snapshot` any time the serialized tree has changed. This is diff-by-JSON-comparison — not schema diffing, just stringifying the tree and checking if it changed. It's inexpensive because `getTree` is a single prepared statement against a local SQLite file.

The client can send a `watch_objective` message to subscribe to live streaming output for a specific objective. When an agent turn is running, the engine emits text incrementally through the `streams` module — a module-level pub/sub map (`activeStreams` in `engine/streams.ts`) that maps objective IDs to lists of callbacks. Subscribing registers a callback that forwards each chunk as a `turn_stream` WebSocket message, including the objective ID, the text chunk, and a `done` flag. The `done` flag marks the end of the turn. Watching a new objective automatically unsubscribes from the previous one, so clients track exactly one stream at a time. Cleanup on socket close removes the tree polling interval and the stream subscription.

The client can also send a `tts_request` message to synthesize speech. The request includes a `text` string and a `requestId` for correlation. The TTS module is initialized lazily and may not be available if the Kokoro model files aren't installed — in that case, the server sends a `tts_error` response. If TTS is available, `synthesizeStreaming` is called, which splits the text into segments, synthesizes each one to PCM16LE audio, and streams the chunks back as `tts_audio` messages with base64-encoded audio, the sample rate, and an `isLastChunk` flag.

## Usage Tracking

`GET /api/usage` returns a composite status object with three sections: raw usage data from the Claude API, the current window status, and the active settings.

The usage data comes from `https://api.anthropic.com/api/oauth/usage`, authenticated with the OAuth token stored in the macOS keychain (or `~/.claude/.credentials.json` on other platforms). The response includes three buckets — the 5-hour session window, the 7-day weekly window, and the 7-day Sonnet-specific window — each with a utilization percentage and a `resets_at` timestamp. There's also an `extra_usage` section for overuse billing. Results are cached for 5 minutes in memory to avoid hammering the API; the Surface polls this endpoint every 60 seconds, so a single cache miss triggers one real fetch that serves the next ~5 polls.

The window status section is computed by `getWindowStatus` in `server/usage.ts`. It reports which window we're currently in, the next window, whether the actual API reset time matches the expected one (sync detection), drift in hours, whether we're in online hours, and whether the weekly ceiling has been hit. This is the data the Surface uses to render the usage rings and the engine uses to make scheduling decisions. The full shape is documented in the `WindowStatus` interface.

The Surface component (`UsageRings.tsx`) renders two concentric donut rings — outer for the 7-day weekly utilization, inner for the 5-hour session. Colors shift from calm grey (under 50%) to amber (50–75%) to red (over 75%). A hover tooltip shows exact percentages and time-until-reset for each bucket.

## Text-to-Speech

The TTS layer in `server/tts.ts` wraps the Kokoro ONNX model via the `sherpa-onnx-node` native addon. It initializes once on first use (the `getTTS` singleton function) and returns `null` if the model files aren't present at `~/.paseo/models/local-speech/kokoro-en-v0_19`. This makes TTS entirely optional — the rest of the server operates normally without it.

Text synthesis works in two stages. First, the text is split into segments no longer than 400 characters, breaking on sentence boundaries where possible and falling back to word boundaries for very long runs. This chunking matters because the underlying ONNX model is configured with `maxNumSentences: 1`, so each call handles one short segment at a time. Second, each segment is synthesized to Float32 samples, converted to PCM 16-bit little-endian, and then chunked into roughly 50ms buffers for streaming. Each 50ms buffer is one `onChunk` callback invocation. The base64 encoding happens at the WebSocket boundary.

## Error Handling

Unhandled errors inside request handlers are caught by a top-level `try/catch` around all route logic, which returns a 500 with a JSON error body. JSON parse failures in request bodies return 400. Route-specific missing-field checks return 400. Unknown routes fall through to a final 404 handler.
