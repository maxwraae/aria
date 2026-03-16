# Context

Every time Aria wakes up to work on an objective, it needs to know who it is, what it's doing, where it sits in the tree, and what's been said. This is the context assembly system — the machinery that collects all of that information and packages it into a single block of text the agent can read.

The design philosophy is explicit modularity. Rather than one monolithic function that builds context, the system decomposes it into named pieces called **bricks**. Each brick is responsible for one slice of the context. They run independently and combine at the end. This makes each piece easy to understand, tune, and debug.

---

## What a Brick Is

A brick is a module that knows how to produce one section of the context. Every brick has a name, a type, and a `render` function. The render function receives a shared context object — the database connection, the objective ID, the token budget, and the config — and returns either a `BrickResult` or null.

Returning null is the normal way for a brick to say "I have nothing to contribute here." A brick that discovers there are no children, or no ancestors, or no similar resolved objectives, simply returns null. The assembler handles this gracefully and skips it — no empty sections appear in the output.

A `BrickResult` carries the rendered text content, a token count, and optional metadata. The metadata is typed by brick type and used by the TUI for display: things like the source file path for static bricks, the config parameters for tunable bricks, or the match list for bricks that searched the database.

There are four brick types: **static**, **tree**, **matched**, and **flex**. These aren't just labels — they describe the behavior and data source of the brick, and the TUI renders each type differently.

---

## The Brick Types

**Static bricks** contain content that doesn't change based on which objective is being processed. They read from a fixed markdown file on disk and serve that content unchanged. The PERSONA and CONTRACT bricks work this way. PERSONA loads `persona.md`, which defines who Aria is and how it thinks. CONTRACT loads `contract.md`, the system description — the objectives model, the six statuses, the message routing rules, the turn lifecycle. These bricks are always present; they anchor every agent turn to the same foundational understanding. Because they're file-backed, they expose a `sourcePath` in their metadata so the TUI can offer an editor shortcut.

The ENVIRONMENT brick is also static by type, but it generates its content from the current moment rather than a file: today's date, the current time, the machine name, and the path to the database. This grounds the agent in the present without requiring it to be told.

The OBJECTIVE brick is static in type but dynamic in content — it's always one thing, but that thing comes from the database for the specific objective being processed. It renders the objective's text, its description if present, its current status (with the `waiting_on` note if the objective is blocked), and temporal metadata: which turn number this is, how many days ago the objective was created, and how many days since the last status change. This is the clearest signal to the agent about where it stands.

**Tree bricks** render the objective's position in the tree. PARENTS walks up the ancestor chain from the current objective to the root, presenting each level as an indented chain under the heading "WHY CHAIN." The outermost ancestor is labeled "root" and each successive level indents further, with the current objective appearing at the deepest indent. If the current objective has no parent — if it is the root — this brick returns null.

SIBLINGS queries for all other objectives that share the same parent, showing each as a one-liner with its status. This tells the agent what work is happening in parallel at the same level. If there are no siblings, the brick returns null. If the objective is the waiting_on kind, that's shown inline as part of the status tag.

CHILDREN renders the objectives directly under the current one. The first five children get the "detailed" treatment: their objective text, status, and the most recent message from their conversation. Children beyond five but within the first twenty are shown as simple one-liners. If there are more than twenty, the remainder is noted with a suggestion to use `aria find` to search. This tiering reflects a judgment: the most recent children are probably most relevant; showing full detail for all twenty would waste context on children that are less likely to matter.

**Matched bricks** perform a database search based on the current objective's text and return results that matched. SIMILAR_RESOLVED does this: it tokenizes the objective text into words longer than two characters, builds an OR-joined full-text search query, and runs it against the `objectives_fts` table, filtering to only resolved objectives. The results are filtered to exclude the current objective (in case it matched itself) and rendered as a list with their resolution summaries. The goal is pattern recognition — showing the agent objectives that looked similar and how they resolved, so it can learn from or reference past work.

**Flex bricks** are content that grows and shrinks with available context, and whose size interacts with the budget. The CONVERSATION brick is the only flex brick. It fetches the most recent messages from the objective's inbox and renders them with their sender labels. Each message is tagged with the sender's relationship to the current objective — `max`, `system`, or an encoded relationship like `parent:abc1234 "The parent objective"`. This labeling comes from a database lookup that compares the sender's parent and child relationship to the current objective. The conversation shows the last 10 messages.

---

## Token Counting

The system uses a deliberate approximation for token counting: one token equals four characters. This is `countTokens` in `tokens.ts`. Real tokenizers — the ones LLMs actually use — are model-specific and expensive to run at assembly time. The 4-character approximation is fast, deterministic, and close enough for budgeting purposes. Each brick calls `countTokens` on its rendered content and returns the result. The assembler sums these.

---

## Budget and Models

Three models are in play, each with different context windows and fill targets. Sonnet gets a 200,000-token context window with a 40% fill target, yielding an 80,000-token budget. Haiku also has a 200,000-token window but a 30% fill target, giving 60,000 tokens. Opus gets a 1,000,000-token window with a 50% fill target — 500,000 tokens.

The fill target exists because these context windows represent the maximum the model can process, not the ideal working space. Sending a model an almost-full context window degrades quality and limits response length. The fill targets are conservative enough to leave room for the agent's response.

The default budget when assembling without specifying a model is Sonnet's 80,000 tokens. Budget is passed into every brick via the context object, so bricks can make budget-aware decisions — though in the current implementation, most bricks don't gate on the budget directly; the config caps serve that purpose instead.

---

## Configuration

Per-brick token caps and item counts are controlled by a config file at `~/.aria/context.json`. If that file doesn't exist, the system creates it from hardcoded defaults on first access: siblings capped at 2,000 tokens and 15 items, children at 5,000 tokens with 5 detailed and 15 one-liner, similar resolved results at 3,000 tokens and 3 results, and so on.

The config is loaded fresh each time it's needed. If the file is malformed or unreadable, the system falls back to defaults silently.

There is a validation function, `validateCaps`, that checks whether the sum of all per-brick token caps exceeds certain thresholds relative to the total budget. Crossing 50% of the budget produces a warning; crossing 80% produces an error. This validation runs in the TUI's overview screen, surfacing these diagnostics visually before they cause problems in production.

---

## Assembly

The assembler in `assembler.ts` is intentionally simple. It takes a list of bricks and a partial context, fills in defaults for any missing context fields, then iterates through the bricks in order. Each brick is called, and if it returns a result, it's collected. Bricks that return null are skipped without any special handling.

After all bricks have run, the results are joined into a single string with `\n\n---\n\n` as the separator between sections. This separator is meaningful — it's a visual and structural delimiter that the model can parse as a section boundary. The final output is an `AssemblyResult` containing the array of individual sections, the total token count, and the combined content string.

The order of bricks matters. When bricks are assembled, they appear in the final context in the same order as the input array. The system assembles them in a principled sequence: PERSONA first to establish identity, CONTRACT to establish the rules, ENVIRONMENT to ground in time and place, OBJECTIVE to anchor to the specific work at hand, then PARENTS for lineage, then SIBLINGS for awareness, then CHILDREN for subordinate work, then SIMILAR_RESOLVED for institutional memory, and finally CONVERSATION for the current dialogue.

This ordering mirrors how a thoughtful agent would want to think: first understand who I am and what the rules are, then understand the specific situation, then understand the context around it, then look at relevant history, then read the current conversation.

---

## The TUI

The terminal UI in `tui/` is a development and debugging tool for understanding what an assembled context looks like and how much budget it consumes. It's a full-screen interactive interface — it enters the alternate screen buffer, hides the cursor, sets raw mode on stdin, and handles its own input loop.

The TUI has three views.

The **overview** is the default view. It shows one row per brick: the brick's position number, name, type, token count, a proportional budget bar (colored green, yellow, or red based on what fraction of Opus's 500K-token budget the brick represents), and percentage columns for each model's budget. A total row appears below. If the config has validation warnings or errors, they appear here. The overview is navigable with arrow keys or vim-style `j`/`k`.

Pressing Enter on any brick opens the **detail view**. This view is type-aware: static bricks show their source path and offer `e` to open the file in an editor; tree and matched and flex bricks show their config fields if any, with Tab to cycle between fields and Enter to start editing. When editing, the TUI accepts numeric input and updates the config file and re-assembles on Enter. Pressing `q` or Escape returns to the overview. Arrow keys scroll the rendered content.

Pressing `a` from the overview opens the **assembly view**, which shows the full concatenated context text with scroll support. This lets you read exactly what would be sent to the model.

When a static brick's source file is opened for editing, the TUI suspends — it exits the alternate screen, shows the cursor, restores normal stdin — then spawns the configured `EDITOR` (falling back to `open` on macOS). When the editor exits, the TUI resumes, reassembles context from the bricks using the updated file, and re-renders.

Config changes made through the detail view are written to disk immediately via `saveConfig`. They take effect on the next reassembly, which happens automatically after a successful edit. This tight feedback loop — edit a value, watch the token count change, verify the rendered content looks right — is what the TUI is built for.
