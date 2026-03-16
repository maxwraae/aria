# Memory TUI

The memory TUI is a single-file terminal application for browsing and searching the memories Aria has extracted from conversation history. It runs without curses — everything is raw ANSI escape codes sent directly to stdout, with stdin put into raw mode so keypresses arrive one character at a time. There's no event loop framework, no external TUI library. Just a Python `while True` loop that renders the screen, reads a key, updates state, and repeats.

## Startup

When you run `python tui.py`, `main()` immediately calls `fetch_overview_data()` to query both databases before anything appears on screen. This front-loads the data so the first render is instant. Two databases are involved: `memories.db` lives in iCloud under `Aria/data/` and is the canonical store of extracted memories; `batch.db` lives next to the script itself and tracks the processing pipeline — sessions, runs, and their statuses. Both are opened read-only via SQLite URI mode (`?mode=ro`) to prevent accidental writes.

After fetching the data, `main()` initializes all view state variables: the current `view` (starting at `'overview'`), selection indices and scroll offsets for browse and search, and `detail_from`, which tracks which view to return to when closing a detail panel. Then it calls `enter_alt_screen()` and `hide_cursor()` — the alt screen is an ANSI feature that switches the terminal to a separate buffer, so the original shell session is preserved intact when the TUI exits. Cursor hiding prevents the cursor from flickering across the screen during renders.

The entire main loop then runs inside a `with raw_mode():` block. The `raw_mode` context manager uses `termios` to save the current terminal settings before calling `tty.setraw()`, and restores them unconditionally in the `finally` block. This is what makes individual keypresses work without waiting for Enter, and it's why cleanup is critical — if the process dies without restoring terminal settings, the shell is left unusable.

## The Main Loop

The loop structure is simple: clear the screen, render the current view to a string, write it to stdout, read one keypress, update state, repeat. Every iteration does a full redraw — there's no diffing or partial updates. `clear_screen()` sends `\x1b[2J\x1b[H`, which erases the screen and moves the cursor to the top-left, so each render paints a fresh frame.

The `view` variable acts as a state machine with four values: `'overview'`, `'browse'`, `'detail'`, and `'search'`. Each iteration, a single render function is called based on the current view, and after the keypress a single block of key-handling logic runs for that same view. Transitions between views happen by reassigning `view` within the key handler — there's no push/pop stack, except that `detail_from` serves as a single level of "remember where I came from" for the detail view.

`read_key()` handles the complexity of terminal input. Most printable characters come through as a single byte. Arrow keys arrive as three-byte sequences: ESC, then `[`, then a letter. `read_key()` detects ESC, then uses `select` with a 50ms timeout to check whether more bytes are immediately available. If they are, it reads the rest of the sequence and maps `A/B/C/D` to `up/down/right/left`. If nothing follows within 50ms, it's a bare ESC keypress. Carriage returns (`\r`) and newlines map to `'enter'`, and `\x7f` maps to `'backspace'`.

## The Overview Screen

`render_overview()` takes the pre-fetched data dict and the current `selected_index` and builds the entire overview as a single string. The five memory types — world, max, people, friction, biology — are hardcoded in `_MEMORY_TYPES`. For each type, it renders a row showing the type name, count, a progress bar scaled relative to the type with the highest count, and session completion stats. The selected row gets a `>` marker and is rendered in cyan; unselected rows have no marker and dimmed session info.

The progress bar from `bar()` uses Unicode block characters: `█` for filled sections and `░` for empty ones. The proportion is `count / max_count` so the bar shows relative density across types rather than absolute completeness. Session stats show `done_sessions / total_sessions` with a percentage. This comes entirely from batch.db — it reflects how many processing sessions have been completed, not type-specific progress.

Below the type table, the last run from batch.db's `runs` table is displayed if one exists. This shows the prompt type, how many sessions were processed, how many memories were extracted, cost in USD, and token counts formatted with K/M suffixes. The `render_overview()` code handles two different column naming conventions for these fields (e.g., `total_cost_usd` vs `cost_usd`) using `get()` with fallback keys, suggesting the schema evolved over time.

In the overview key handler, up/down arrows (or `k/j`) move `selected` through the five types, clamped to valid indices. Pressing `s` clears all search state and switches to `'search'`. Pressing `enter` takes the selected type name, calls `fetch_memories()` to load up to 200 memories of that type from memories.db ordered newest first, resets `browse_selected` and `browse_scroll` to zero, and sets `view = 'browse'`. Pressing `q` or Ctrl-C breaks the loop.

## The Browse Screen

`render_browse()` is the most layout-sensitive renderer. It calls `get_terminal_size()` on every invocation so the layout always fits the current terminal dimensions. The available height for memory rows is the terminal height minus a fixed reservation of 7 lines for the header, spacing, and hint bar. Each memory occupies two display lines — a first line with index, content, and date, and a second line with a continuation of the content if it wraps. So the number of visible memories is `(rows - 7) // 2`.

Scroll management happens inside the renderer rather than in the key handler. Given the current `selected_index` and `scroll_offset`, the renderer clamps `scroll_offset` to keep the selected item visible: if `selected_index` is above the visible window, the window slides up; if it's below, it slides down. The renderer then slices `memories[scroll_offset : scroll_offset + max_visible]` to get the visible page.

Each memory row uses `textwrap.wrap()` to reflow the content to `content_width` columns (terminal width minus space for the index gutter and date column), then takes the first two wrapped lines. The selected row gets a `>` marker and cyan coloring applied to the full row string. Dates are dim on unselected rows; the index number is always dim. `visible_len()` strips ANSI escape codes before measuring string width, which is essential throughout the renderers — raw `len()` on colored strings would give wrong column math.

In the browse key handler, up/down adjust `browse_selected` with bounds clamping. When moving up, if `browse_selected` would go above `browse_scroll`, `browse_scroll` is decremented directly in the handler as a fast path for keeping the selection visible. Pressing `enter` on a non-empty list saves the selected memory dict into `detail_memory`, sets `detail_from = 'browse'`, and transitions to `'detail'`. Pressing `q`, ESC, or Ctrl-C returns to `'overview'`.

## The Search Screen

The search view has two modes that aren't explicitly named but emerge from the state: query composition and result navigation. The distinction matters for how `enter` behaves.

When you first press `s` from the overview, `search_query` is empty and `search_results` is an empty list. In the search view, printable characters accumulate into `search_query` one at a time. Each new character also clears `search_results`, `search_selected`, and `search_scroll` — meaning results are always stale relative to the current query until you press enter to run the search. Backspace removes the last character with `search_query[:-1]`.

When `enter` is pressed, the key handler checks two conditions. If `search_results` is non-empty and `search_query` is non-empty, it treats enter as "open the selected result" rather than "run the search again." This means once you have results, you navigate them with arrows and press enter to open one. If you want to modify the query, typing anything will clear the results, putting you back into composition mode. If `search_query` is non-empty but `search_results` is empty, enter runs `search_memories()` and populates the results list.

`search_memories()` connects to memories.db and runs an FTS5 full-text search. The scoring formula combines BM25 relevance (negated because BM25 returns negative values where lower is more relevant) at 70% weight with a recency decay at 30%. The recency component is `1.0 / (1.0 + age_in_months)`, which asymptotically approaches zero for old memories while giving newer ones a boost. If the FTS5 query fails due to a syntax error (unbalanced quotes, special characters), the function retries by quoting each word individually, making common inputs like phrases with punctuation safe. Results are returned sorted by score descending, up to 50 results.

`render_search()` handles layout the same way `render_browse()` does — querying terminal size, reserving lines, computing visible rows. The search input line shows the current query followed by a block cursor character (`█`). Result rows show a sequential number, the type tag in brackets, a truncated content snippet, the score to two decimal places, and the date. The selected row is highlighted in cyan.

## The Detail Screen

`render_detail()` is the simplest renderer. It takes a single memory dict and formats a full-screen view. The header shows the memory ID and type. The content is reflowed with `textwrap.wrap()` to `cols - 4` width to leave a two-space margin on each side. Source and date appear below the content as labeled metadata fields.

The detail key handler only handles one action: `q`, ESC, or Ctrl-C returns to `detail_from`. Since `detail_from` is either `'browse'` or `'search'`, this sends the user back to whichever list they came from, with all their scroll state intact — `browse_selected`, `browse_scroll`, `search_selected`, and `search_scroll` are preserved across the detail transition because the key handler doesn't reset them when entering detail.

## Cleanup

When the main loop exits — either from `q` in the overview, Ctrl-C anywhere (which reads as `'\x03'`), or any unexpected exception — the `finally` block in `main()` calls `show_cursor()` and `exit_alt_screen()`. These two calls undo the terminal setup from startup. The `raw_mode` context manager's `finally` block then restores the original `termios` settings. The order matters: ANSI escape codes should be sent while still in alt screen and raw mode, then `raw_mode`'s exit restores the terminal configuration. After these three cleanup steps, the shell prompt returns normally with no visible artifacts from the TUI session.
