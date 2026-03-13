// ANSI rendering utilities for the terminal TUI.
// All side-effect functions write to process.stdout directly.
// All pure functions return strings.
// No imports, no dependencies.

// ---------------------------------------------------------------------------
// Alternate screen buffer
// ---------------------------------------------------------------------------

export function enterAltScreen(): void {
  process.stdout.write('\x1b[?1049h');
}

export function exitAltScreen(): void {
  process.stdout.write('\x1b[?1049l');
}

// ---------------------------------------------------------------------------
// Cursor and screen
// ---------------------------------------------------------------------------

export function clearScreen(): void {
  process.stdout.write('\x1b[2J\x1b[H');
}

export function moveTo(row: number, col: number): void {
  process.stdout.write(`\x1b[${row};${col}H`);
}

export function hideCursor(): void {
  process.stdout.write('\x1b[?25l');
}

export function showCursor(): void {
  process.stdout.write('\x1b[?25h');
}

// ---------------------------------------------------------------------------
// Box drawing
// ---------------------------------------------------------------------------

export function horizontalLine(width: number): string {
  return '─'.repeat(width);
}

// Strip ANSI escape codes to measure visible length.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visibleLength(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

/**
 * Draws a bordered box with an embedded title in the top border.
 *
 * Layout (width = total outer width including borders):
 *   ┌─ title ─────┐
 *   │ content     │
 *   └─────────────┘
 *
 * Content area width = width - 4  (2 border chars + 1 space each side)
 * Lines may contain ANSI color codes — padding is based on visible length.
 */
export function box(title: string, lines: string[], width: number): string {
  const innerWidth = width - 4; // 2 border + 2 padding spaces

  // Top border: ┌─ {title} ─...─┐
  const titleSegment = `─ ${title} ─`;
  const topFill = Math.max(0, width - 2 - titleSegment.length); // -2 for ┌ and ┐
  const topBorder = `┌${titleSegment}${'─'.repeat(topFill)}┐`;

  // Content lines: │ {padded line} │
  // Use visible length so ANSI codes don't break alignment.
  const contentRows = lines.map((line) => {
    const vis = visibleLength(line);
    const pad = Math.max(0, innerWidth - vis);
    return `│ ${line}${' '.repeat(pad)} │`;
  });

  // Bottom border: └─...─┘
  const bottomBorder = `└${'─'.repeat(width - 2)}┘`;

  return [topBorder, ...contentRows, bottomBorder].join('\n');
}

// ---------------------------------------------------------------------------
// Wrap / scroll helpers — shared across brick-detail and assembly-view
// ---------------------------------------------------------------------------

/**
 * Wrap lines to maxWidth, return flat array of wrapped lines.
 * Empty lines are preserved as-is.
 */
export function wrapLines(lines: string[], maxWidth: number): string[] {
  const result: string[] = [];
  for (const raw of lines) {
    if (raw.length === 0) {
      result.push('');
      continue;
    }
    let remaining = raw;
    while (remaining.length > maxWidth) {
      result.push(remaining.slice(0, maxWidth));
      remaining = remaining.slice(maxWidth);
    }
    result.push(remaining);
  }
  return result;
}

/**
 * Slice wrapped lines for scroll viewport.
 * Returns the visible slice and the total line count.
 */
export function scrollSlice(
  lines: string[],
  scrollOffset: number,
  viewportHeight: number,
): { visible: string[]; total: number } {
  return {
    visible: lines.slice(scrollOffset, scrollOffset + viewportHeight),
    total: lines.length,
  };
}

/**
 * Render a scroll position indicator like "Lines 1-25 of 200".
 * Returns an empty string if all content fits in the viewport.
 */
export function scrollIndicator(
  offset: number,
  viewportHeight: number,
  total: number,
): string {
  if (total <= viewportHeight) return '';
  const start = offset + 1;
  const end = Math.min(offset + viewportHeight, total);
  return `Lines ${start}-${end} of ${total}`;
}

// ---------------------------------------------------------------------------
// Colors — always enabled (TUI only runs in a TTY)
// ---------------------------------------------------------------------------

export const tui = {
  dim:     (s: string): string => `\x1b[2m${s}\x1b[0m`,
  bold:    (s: string): string => `\x1b[1m${s}\x1b[0m`,
  cyan:    (s: string): string => `\x1b[36m${s}\x1b[0m`,
  green:   (s: string): string => `\x1b[32m${s}\x1b[0m`,
  yellow:  (s: string): string => `\x1b[33m${s}\x1b[0m`,
  red:     (s: string): string => `\x1b[31m${s}\x1b[0m`,
  inverse: (s: string): string => `\x1b[7m${s}\x1b[0m`,
};
