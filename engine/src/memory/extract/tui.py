"""
TUI rendering primitives for the memory extract viewer.

No curses. Pure ANSI escape codes + raw stdin.
All color functions return strings (pure). Screen control writes to stdout.
"""

import os
import re
import sys
import tty
import select
import sqlite3
import termios
import textwrap
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Database paths
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).parent
BATCH_DB = SCRIPT_DIR / "batch.db"
MEMORIES_DB = Path.home() / "Library/Mobile Documents/com~apple~CloudDocs/Aria/data/memories.db"

# ---------------------------------------------------------------------------
# ANSI color helpers — pure functions, return strings
# ---------------------------------------------------------------------------

RESET_CODE = "\x1b[0m"


def dim(text: str) -> str:
    return f"\x1b[2m{text}{RESET_CODE}"


def cyan(text: str) -> str:
    return f"\x1b[36m{text}{RESET_CODE}"


def green(text: str) -> str:
    return f"\x1b[32m{text}{RESET_CODE}"


def yellow(text: str) -> str:
    return f"\x1b[33m{text}{RESET_CODE}"


def red(text: str) -> str:
    return f"\x1b[31m{text}{RESET_CODE}"


def bold(text: str) -> str:
    return f"\x1b[1m{text}{RESET_CODE}"


def inverse(text: str) -> str:
    return f"\x1b[7m{text}{RESET_CODE}"


def reset() -> str:
    return RESET_CODE


# ---------------------------------------------------------------------------
# Screen control — side-effect functions, write to stdout
# ---------------------------------------------------------------------------

def enter_alt_screen() -> None:
    sys.stdout.write("\x1b[?1049h")
    sys.stdout.flush()


def exit_alt_screen() -> None:
    sys.stdout.write("\x1b[?1049l")
    sys.stdout.flush()


def clear_screen() -> None:
    sys.stdout.write("\x1b[2J\x1b[H")
    sys.stdout.flush()


def hide_cursor() -> None:
    sys.stdout.write("\x1b[?25l")
    sys.stdout.flush()


def show_cursor() -> None:
    sys.stdout.write("\x1b[?25h")
    sys.stdout.flush()


def move_to(row: int, col: int) -> None:
    sys.stdout.write(f"\x1b[{row};{col}H")
    sys.stdout.flush()


def get_terminal_size() -> tuple[int, int]:
    """Returns (cols, rows)."""
    size = os.get_terminal_size()
    return size.columns, size.lines


# ---------------------------------------------------------------------------
# Raw mode context manager
# ---------------------------------------------------------------------------

@contextmanager
def raw_mode():
    """Put stdin in raw mode, restore on exit (even on exception)."""
    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        yield
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


# ---------------------------------------------------------------------------
# Key reading
# ---------------------------------------------------------------------------

def read_key() -> str:
    """Read a single keypress from stdin (must be in raw mode).

    Returns one of:
        'up', 'down', 'left', 'right'  — arrow keys
        'enter'                         — carriage return (0x0d)
        'escape'                        — bare ESC (0x1b not followed by [)
        'backspace'                     — 0x7f
        'q', 's', 'j', 'k'             — named convenience keys
        <char>                          — any other printable character
    """
    ch = sys.stdin.read(1)

    if ch == "\x1b":
        # Check if more bytes follow within 50ms (escape sequence vs bare ESC)
        ready, _, _ = select.select([sys.stdin], [], [], 0.05)
        if not ready:
            return "escape"
        ch2 = sys.stdin.read(1)
        if ch2 == "[":
            ch3 = sys.stdin.read(1)
            return {
                "A": "up",
                "B": "down",
                "C": "right",
                "D": "left",
            }.get(ch3, f"esc[{ch3}")
        return "escape"

    if ch == "\r" or ch == "\n":
        return "enter"

    if ch == "\x7f":
        return "backspace"

    return ch


# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------

# Matches all ANSI CSI escape sequences (colors, cursor, etc.)
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def visible_len(text: str) -> int:
    """Length of text excluding ANSI escape codes."""
    return len(_ANSI_RE.sub("", text))


def truncate(text: str, width: int) -> str:
    """Truncate text to width visible characters, appending '...' if needed.

    Width accounts for visible characters only (ANSI codes don't count).
    """
    if visible_len(text) <= width:
        return text
    # Strip codes for truncation, then re-add a reset at the end
    plain = _ANSI_RE.sub("", text)
    if width <= 3:
        return plain[:width]
    return plain[: width - 3] + "..."


def pad(text: str, width: int) -> str:
    """Pad text to width visible characters with trailing spaces.

    ANSI codes are not counted toward width.
    """
    vlen = visible_len(text)
    if vlen >= width:
        return text
    return text + " " * (width - vlen)


def bar(filled: int, total: int, width: int = 20) -> str:
    """Render a progress bar.

    Example: bar(7, 10, 20) → '██████████████░░░░░░'
    """
    if total <= 0:
        return "░" * width
    proportion = max(0.0, min(1.0, filled / total))
    fill_count = round(proportion * width)
    empty_count = width - fill_count
    return "█" * fill_count + "░" * empty_count


# ---------------------------------------------------------------------------
# Box drawing helpers (bonus — useful for views)
# ---------------------------------------------------------------------------

def horizontal_line(width: int) -> str:
    return "─" * width


def box(title: str, lines: list[str], width: int) -> str:
    """Draw a bordered box with an embedded title in the top border.

    Layout (width = total outer width including borders):
      ┌─ title ─────┐
      │ content     │
      └─────────────┘

    Content area width = width - 4 (2 border chars + 1 space each side).
    Lines may contain ANSI codes — padding uses visible_len.
    """
    inner_width = width - 4

    title_segment = f"─ {title} ─"
    top_fill = max(0, width - 2 - len(title_segment))
    top_border = f"┌{title_segment}{'─' * top_fill}┐"

    content_rows = []
    for line in lines:
        vlen = visible_len(line)
        padding = max(0, inner_width - vlen)
        content_rows.append(f"│ {line}{' ' * padding} │")

    bottom_border = f"└{'─' * (width - 2)}┘"

    return "\n".join([top_border, *content_rows, bottom_border])


# ---------------------------------------------------------------------------
# Data fetching
# ---------------------------------------------------------------------------

def fetch_overview_data() -> dict:
    """Fetch all data needed for the overview screen.

    Returns a dict with keys:
        total_memories: int
        by_type: dict[str, int]         — {type_name: count}
        total_sessions: int
        by_status: dict[str, int]       — {status: count}
        last_run: dict | None           — row from runs table, or None
    """
    data = {
        "total_memories": 0,
        "by_type": {},
        "total_sessions": 0,
        "by_status": {},
        "last_run": None,
    }

    # memories.db
    if MEMORIES_DB.exists():
        try:
            con = sqlite3.connect(f"file:{MEMORIES_DB}?mode=ro", uri=True)
            con.row_factory = sqlite3.Row
            cur = con.cursor()
            row = cur.execute("SELECT COUNT(*) FROM memories").fetchone()
            data["total_memories"] = row[0] if row else 0
            for r in cur.execute(
                "SELECT type, COUNT(*) as n FROM memories GROUP BY type ORDER BY n DESC"
            ):
                data["by_type"][r["type"]] = r["n"]
            con.close()
        except Exception:
            pass

    # batch.db
    if BATCH_DB.exists():
        try:
            con = sqlite3.connect(f"file:{BATCH_DB}?mode=ro", uri=True)
            con.row_factory = sqlite3.Row
            cur = con.cursor()
            row = cur.execute("SELECT COUNT(*) FROM sessions").fetchone()
            data["total_sessions"] = row[0] if row else 0
            for r in cur.execute(
                "SELECT status, COUNT(*) FROM sessions GROUP BY status"
            ):
                data["by_status"][r["status"]] = r[1]
            last = cur.execute(
                "SELECT * FROM runs ORDER BY id DESC LIMIT 1"
            ).fetchone()
            if last:
                data["last_run"] = dict(last)
            con.close()
        except Exception:
            pass

    return data


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

def search_memories(query: str, limit: int = 50) -> list[dict]:
    """Full-text search using FTS5 with Aria's scoring formula.

    Score = BM25 * 0.7 + recency_decay * 0.3
    """
    if not MEMORIES_DB.exists() or not query.strip():
        return []
    try:
        con = sqlite3.connect(f"file:{MEMORIES_DB}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        cur = con.cursor()

        sql = """
            SELECT
                m.id,
                m.content,
                m.type,
                m.source,
                m.created_at,
                (-bm25(memories_fts)) * 0.7
                  + (1.0 / (1.0 + (cast(strftime('%s','now') as integer) - m.created_at) / 2592000.0)) * 0.3
                  AS score
            FROM memories m
            JOIN memories_fts fts ON fts.rowid = m.rowid
            WHERE memories_fts MATCH ?
            ORDER BY score DESC
            LIMIT ?
        """
        try:
            rows = cur.execute(sql, (query, limit)).fetchall()
        except sqlite3.OperationalError:
            # FTS5 syntax error — try quoting each word
            safe_query = " ".join(f'"{w}"' for w in query.split())
            try:
                rows = cur.execute(sql, (safe_query, limit)).fetchall()
            except sqlite3.OperationalError:
                rows = []

        con.close()

        result = []
        for r in rows:
            ts = r["created_at"]
            try:
                date_str = datetime.fromtimestamp(float(ts)).strftime("%Y-%m-%d")
            except Exception:
                date_str = str(ts)[:10] if ts else "?"
            result.append({
                "id": r["id"],
                "content": r["content"] or "",
                "type": r["type"] or "",
                "source": r["source"] or "",
                "created_at": date_str,
                "score": r["score"] or 0.0,
            })
        return result
    except Exception:
        return []


def render_search(query: str, results: list[dict], selected_index: int, scroll_offset: int) -> str:
    """Render the search view.

    Layout:
        Search: <query>█

          1. [world]  content snippet...        0.82  2026-02-27
          ...

          [↑↓] Scroll  [enter] View  [esc] Back  [type to search]
    """
    cols, rows = get_terminal_size()
    lines = []

    # Search input line
    lines.append("")
    lines.append(f"  {bold('Search:')} {query}\u2588")
    lines.append("")

    count = len(results)

    if count == 0 and query:
        lines.append(f"  {dim('No results.')}")
        lines.append("")
    elif count > 0:
        # Header
        plural = "s" if count != 1 else ""
        lines.append(f"  {dim(str(count) + ' result' + plural)}")
        lines.append("")

        # How many result rows fit
        # Reserve: 2 (blank+search line) + 1 (blank) + 1 (results header) + 1 (blank) + 1 (blank before hints) + 1 (hints) + 1 (trailing)
        RESERVED_LINES = 9
        LINES_PER_ROW = 1
        max_visible = max(1, (rows - RESERVED_LINES) // LINES_PER_ROW)

        # Clamp scroll
        if selected_index < scroll_offset:
            scroll_offset = selected_index
        elif selected_index >= scroll_offset + max_visible:
            scroll_offset = selected_index - max_visible + 1

        visible = results[scroll_offset: scroll_offset + max_visible]

        # Column widths
        # "  N. [type]  content...    score  date"
        # index up to 3 digits + ". " = 5
        # type tag "[world]" max ~10 chars
        # score "0.82" = 4, date "2026-02-27" = 10, spacers
        SCORE_WIDTH = 4
        DATE_WIDTH = 10
        TYPE_WIDTH = 10  # "[biology]" = 9
        GUTTER = 5       # "  N. "
        SPACERS = 4      # gaps between columns
        content_width = cols - 2 - GUTTER - TYPE_WIDTH - SCORE_WIDTH - DATE_WIDTH - SPACERS

        for list_i, mem in enumerate(visible):
            abs_i = scroll_offset + list_i
            is_selected = (abs_i == selected_index)
            num = abs_i + 1

            type_tag = f"[{mem['type']}]"
            content_snippet = truncate(mem["content"].replace("\n", " "), content_width)
            score_str = f"{mem['score']:.2f}"
            date_str = mem["created_at"]

            idx_label = f"{num}."
            type_col   = pad(dim(type_tag), TYPE_WIDTH + 5)  # dim adds escape bytes
            content_col = pad(content_snippet, content_width)
            score_col  = pad(score_str, SCORE_WIDTH)

            row_text = f"  {idx_label:<4} {type_col} {content_col}  {score_col}  {date_str}"

            if is_selected:
                lines.append(cyan(row_text))
            else:
                lines.append(row_text)

        lines.append("")

    # Key hints
    hints = (
        dim("[↑↓] Scroll") + "  " +
        dim("[enter] View") + "  " +
        dim("[esc] Back") + "  " +
        dim("[type + enter] Search")
    )
    lines.append(f"  {hints}")
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Browse data fetching
# ---------------------------------------------------------------------------

def fetch_memories(mem_type: str, limit: int = 200) -> list[dict]:
    """Fetch memories of a given type from memories.db, newest first.

    Returns a list of dicts with keys: id, content, type, source, created_at (str).
    """
    if not MEMORIES_DB.exists():
        return []
    try:
        con = sqlite3.connect(f"file:{MEMORIES_DB}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        cur = con.cursor()
        rows = cur.execute(
            "SELECT id, content, type, source, created_at FROM memories "
            "WHERE type = ? ORDER BY created_at DESC LIMIT ?",
            (mem_type, limit),
        ).fetchall()
        con.close()
        result = []
        for r in rows:
            ts = r["created_at"]
            try:
                date_str = datetime.fromtimestamp(float(ts)).strftime("%Y-%m-%d")
            except Exception:
                date_str = str(ts)[:10] if ts else "?"
            result.append({
                "id": r["id"],
                "content": r["content"] or "",
                "type": r["type"] or mem_type,
                "source": r["source"] or "",
                "created_at": date_str,
            })
        return result
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Browse renderer
# ---------------------------------------------------------------------------

def render_browse(mem_type: str, memories: list[dict], selected_index: int, scroll_offset: int) -> str:
    """Render the browse view for a memory type.

    Shows memory rows fitting the terminal height, with selection and scrolling.
    """
    cols, rows = get_terminal_size()
    count = len(memories)

    lines = []

    # Header
    header_left = bold(f"{mem_type} memories ({count:,})")
    header_right = dim("newest first")
    gap = max(1, cols - 2 - visible_len(header_left) - visible_len(header_right))
    lines.append(f"\n  {header_left}{' ' * gap}{header_right}\n")

    # How many memory rows we can show:
    # Reserve: 2 (header lines) + 1 (blank after header) + 1 (blank before hints) + 1 (hints line) + 1 (trailing blank)
    RESERVED_LINES = 7
    # Each memory takes 2 display lines (content line + second wrap line)
    LINES_PER_ROW = 2
    max_visible = max(1, (rows - RESERVED_LINES) // LINES_PER_ROW)

    # Clamp scroll_offset so selected_index is visible
    if selected_index < scroll_offset:
        scroll_offset = selected_index
    elif selected_index >= scroll_offset + max_visible:
        scroll_offset = selected_index - max_visible + 1

    visible_memories = memories[scroll_offset: scroll_offset + max_visible]

    # Date column width: "2026-03-15" = 10 chars
    DATE_WIDTH = 10
    # Index gutter: up to 4 digits + ". " = 6 chars, plus 2 for "> " marker
    GUTTER = 8  # "  > NNN. "
    content_width = cols - 2 - GUTTER - DATE_WIDTH - 2  # 2 for spacing between content and date

    for list_i, mem in enumerate(visible_memories):
        abs_i = scroll_offset + list_i
        is_selected = (abs_i == selected_index)
        num = abs_i + 1
        content = mem["content"]
        date = mem["created_at"]

        # Wrap content to content_width, take first 2 lines
        wrapped = textwrap.wrap(content, width=content_width) if content else [""]
        line1 = wrapped[0] if wrapped else ""
        line2 = wrapped[1] if len(wrapped) > 1 else ""

        # Build index label
        idx_label = f"{num}."

        if is_selected:
            marker = ">"
            # First line: marker + index + content + date (right-aligned)
            first_content = truncate(line1, content_width)
            first_content_pad = first_content + " " * max(0, content_width - visible_len(first_content))
            row1 = cyan(f"  {marker} {dim(idx_label):<4} {first_content_pad}  {date}")
            # Second line: indented continuation, no date
            if line2:
                row2 = cyan(f"       {dim(''):<4} {line2}")
            else:
                row2 = ""
        else:
            marker = " "
            first_content = truncate(line1, content_width)
            first_content_pad = first_content + " " * max(0, content_width - visible_len(first_content))
            row1 = f"  {marker} {dim(idx_label):<4} {first_content_pad}  {dim(date)}"
            if line2:
                row2 = f"         {dim(line2)}"
            else:
                row2 = ""

        lines.append(row1)
        if row2:
            lines.append(row2)
        else:
            lines.append("")

    lines.append("")

    # Key hints
    hints = (
        dim("[↑↓] Scroll") + "  " +
        dim("[enter] Full view") + "  " +
        dim("[q] Back")
    )
    lines.append(f"  {hints}")
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Detail renderer
# ---------------------------------------------------------------------------

def render_detail(memory: dict) -> str:
    """Render full detail view for a single memory."""
    cols, _ = get_terminal_size()

    lines = []

    # Header
    header_left = bold(f"Memory #{memory['id']}")
    header_right = dim(memory["type"])
    gap = max(1, cols - 2 - visible_len(header_left) - visible_len(header_right))
    lines.append(f"\n  {header_left}{' ' * gap}{header_right}\n")

    # Word-wrapped content
    content_width = cols - 4  # 2 spaces indent each side
    wrapped = textwrap.wrap(memory["content"], width=content_width) if memory["content"] else ["(no content)"]
    for line in wrapped:
        lines.append(f"  {line}")

    lines.append("")

    # Source and date
    lines.append(f"  {dim('Source:')} {memory['source'] or '(unknown)'}")
    lines.append(f"  {dim('Date:')}   {memory['created_at']}")

    lines.append("")

    # Key hints
    lines.append(f"  {dim('[q] Back')}")
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Overview renderer
# ---------------------------------------------------------------------------

_MEMORY_TYPES = ["world", "max", "people", "friction", "biology"]


def render_overview(data: dict, selected_index: int) -> str:
    total = data["total_memories"]
    by_type = data["by_type"]
    total_sessions = data["total_sessions"]
    by_status = data["by_status"]
    last_run = data["last_run"]

    # Determine max count for progress bar scaling
    max_count = max((by_type.get(t, 0) for t in _MEMORY_TYPES), default=1)
    if max_count == 0:
        max_count = 1

    lines = []

    # Header
    header_left = bold("Aria Memory")
    header_right = dim(f"{total:,} total")
    # Pad header so total aligns to column 53 (visible)
    gap = 53 - visible_len(header_left) - visible_len(header_right)
    lines.append(f"\n  {header_left}{' ' * max(1, gap)}{header_right}\n")

    # Column headers
    col_type   = pad(dim("Type"), 14)
    col_count  = pad(dim("Count"), 9)
    col_bar    = pad(dim("Extracted"), 13)
    col_sess   = dim("Sessions")
    lines.append(f"  {col_type}{col_count}{col_bar}{col_sess}")
    lines.append("")

    # Per-type rows
    for i, t in enumerate(_MEMORY_TYPES):
        count = by_type.get(t, 0)
        done_sessions = by_status.get("done", 0)

        # Progress bar: count relative to max_count
        b = bar(count, max_count, width=10)

        # Session fraction
        if total_sessions > 0:
            pct = done_sessions / total_sessions * 100
            sess_str = f"{done_sessions:,} / {total_sessions:,} ({pct:.1f}%)"
        else:
            sess_str = f"0 / 0"

        # Only show session info for types that have memories
        if count == 0:
            sess_str = f"0 / {total_sessions:,}"

        # Build the row
        type_col  = pad(t, 12)
        count_col = pad(f"{count:,}", 9)
        bar_col   = pad(b, 13)

        if i == selected_index:
            row = cyan(f"> {type_col}{count_col}{bar_col}") + dim(sess_str)
        else:
            row = f"  {type_col}{count_col}{bar_col}{dim(sess_str)}"

        lines.append(row)

    lines.append("")

    # Last run stats
    if last_run:
        run_type      = last_run.get("prompt_type", last_run.get("memory_type", "?"))
        run_sessions  = last_run.get("sessions_processed", 0)
        run_memories  = last_run.get("total_memories", last_run.get("memories_extracted", 0))
        run_cost      = last_run.get("total_cost_usd", last_run.get("cost_usd", 0.0))
        run_tok_in    = last_run.get("total_input_tokens", last_run.get("tokens_in", 0))
        run_tok_out   = last_run.get("total_output_tokens", last_run.get("tokens_out", 0))

        def fmt_tokens(n: int) -> str:
            if n >= 1_000_000:
                return f"{n/1_000_000:.1f}M"
            if n >= 1_000:
                return f"{n/1_000:.1f}K"
            return str(n)

        lines.append(
            f"  {dim('Last run:')} {run_type}  "
            f"{run_sessions:,} sessions  "
            f"{run_memories:,} memories  "
            f"${run_cost:.2f}"
        )
        lines.append(
            f"  {dim('Tokens:')}   {fmt_tokens(run_tok_in)} input  "
            f"{fmt_tokens(run_tok_out)} output"
        )
    else:
        lines.append(f"  {dim('Last run:')} {dim('no runs yet')}")

    lines.append("")

    # Key hints
    hints = (
        dim("[↑↓] Select type") + "  " +
        dim("[enter] Browse memories") + "  " +
        dim("[s] Search") + "  " +
        dim("[q] Quit")
    )
    lines.append(f"  {hints}")
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main():
    data = fetch_overview_data()
    selected = 0

    # Browse state
    view = 'overview'          # 'overview' | 'browse' | 'detail' | 'search'
    browse_memories: list[dict] = []
    browse_type: str = ''
    browse_selected: int = 0
    browse_scroll: int = 0
    detail_memory: dict = {}
    detail_from: str = 'browse'  # which view to return to from detail

    # Search state
    search_query: str = ''
    search_results: list[dict] = []
    search_selected: int = 0
    search_scroll: int = 0

    enter_alt_screen()
    hide_cursor()

    try:
        with raw_mode():
            while True:
                clear_screen()

                if view == 'overview':
                    output = render_overview(data, selected)
                elif view == 'browse':
                    output = render_browse(browse_type, browse_memories, browse_selected, browse_scroll)
                elif view == 'search':
                    output = render_search(search_query, search_results, search_selected, search_scroll)
                else:  # detail
                    output = render_detail(detail_memory)

                sys.stdout.write(output)
                sys.stdout.flush()

                key = read_key()

                if view == 'overview':
                    if key in ('q', '\x03'):
                        break
                    elif key in ('up', 'k'):
                        selected = max(0, selected - 1)
                    elif key in ('down', 'j'):
                        selected = min(len(_MEMORY_TYPES) - 1, selected + 1)
                    elif key == 'enter':
                        browse_type = _MEMORY_TYPES[selected]
                        browse_memories = fetch_memories(browse_type)
                        browse_selected = 0
                        browse_scroll = 0
                        view = 'browse'
                    elif key == 's':
                        search_query = ''
                        search_results = []
                        search_selected = 0
                        search_scroll = 0
                        view = 'search'

                elif view == 'browse':
                    if key in ('q', 'escape', '\x03'):
                        view = 'overview'
                    elif key in ('up', 'k'):
                        browse_selected = max(0, browse_selected - 1)
                        # Adjust scroll if needed
                        if browse_selected < browse_scroll:
                            browse_scroll = browse_selected
                    elif key in ('down', 'j'):
                        browse_selected = min(len(browse_memories) - 1, browse_selected + 1)
                    elif key == 'enter' and browse_memories:
                        detail_memory = browse_memories[browse_selected]
                        detail_from = 'browse'
                        view = 'detail'

                elif view == 'search':
                    if key == 'escape' or key == '\x03':
                        view = 'overview'
                    elif key == 'backspace':
                        search_query = search_query[:-1]
                    elif key == 'enter':
                        if search_results and search_query:
                            # Enter on a result: open detail
                            detail_memory = search_results[search_selected]
                            detail_from = 'search'
                            view = 'detail'
                        elif search_query:
                            # Run the search
                            search_results = search_memories(search_query)
                            search_selected = 0
                            search_scroll = 0
                    elif key in ('up', 'k'):
                        search_selected = max(0, search_selected - 1)
                        if search_selected < search_scroll:
                            search_scroll = search_selected
                    elif key in ('down', 'j'):
                        if search_results:
                            search_selected = min(len(search_results) - 1, search_selected + 1)
                    elif len(key) == 1 and key.isprintable():
                        search_query += key
                        # Reset results when query changes so user must press enter
                        search_results = []
                        search_selected = 0
                        search_scroll = 0

                else:  # detail
                    if key in ('q', 'escape', '\x03'):
                        view = detail_from

    finally:
        show_cursor()
        exit_alt_screen()


if __name__ == "__main__":
    main()
