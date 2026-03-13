import { tui, wrapLines, scrollSlice, scrollIndicator } from './render.js';
import type { BrickResult } from '../types.js';

const BUDGETS = { opus: 100_000, sonnet: 80_000, haiku: 60_000 };

/**
 * Renders a full-screen detail view for a static brick.
 * Pure function — no side effects.
 */
export function renderStaticDetail(
  brick: BrickResult,
  budget: number,
  scrollOffset: number,
): string {
  const termWidth = process.stdout.columns || 80;
  const termRows = process.stdout.rows || 24;
  const contentWidth = termWidth - 4; // 2-space margin each side
  const margin = '  ';

  // Budget percentage against all three model budgets
  const opusPct  = ((brick.tokens / BUDGETS.opus)   * 100).toFixed(1);
  const sonnetPct = ((brick.tokens / BUDGETS.sonnet) * 100).toFixed(1);
  const haikuPct  = ((brick.tokens / BUDGETS.haiku)  * 100).toFixed(1);
  const budgetPct = ((brick.tokens / budget) * 100).toFixed(1);

  // Header line: bold name left, type badge + tokens + budget% right
  const name = tui.bold(brick.name.toUpperCase());
  const badge = tui.cyan('[static]');
  const tokInfo = tui.dim(`${brick.tokens} tok · ${budgetPct}%`);
  const headerRight = `${badge} ${tokInfo}`;
  // Measure visible length for alignment (strip ANSI)
  const nameVis = brick.name.toUpperCase().length;
  const rightVis = '[static]'.length + 1 + `${brick.tokens} tok · ${budgetPct}%`.length;
  const gap = contentWidth - nameVis - rightVis;
  const headerLine = gap > 0
    ? name + ' '.repeat(gap) + headerRight
    : name + '  ' + headerRight;

  // Source path line
  const sourcePath = brick.meta?.sourcePath;
  const sourceLines: string[] = sourcePath
    ? [tui.dim(`Source: ${sourcePath}`), '']
    : [];

  // Separator
  const sepLabel = '── Rendered Content ';
  const separator = tui.dim(sepLabel + '─'.repeat(Math.max(0, contentWidth - sepLabel.length)));

  // Wrap content
  const rawLines = brick.content.split('\n');
  const allWrapped = wrapLines(rawLines, contentWidth);

  // Chrome line count: header + blank + source lines + sep + blank + blank + footer = varies
  const chromeLines = 1 + 1 + sourceLines.length + 1 + 1 + 1 + 1;
  const availableHeight = Math.max(1, termRows - chromeLines);

  const { visible, total } = scrollSlice(allWrapped, scrollOffset, availableHeight);

  // Footer
  const hasSource = Boolean(sourcePath);
  const baseFooter = hasSource
    ? '[q] Back  [↑↓] Scroll  [e] Edit source file'
    : '[q] Back  [↑↓] Scroll';
  const indicator = scrollIndicator(scrollOffset, availableHeight, total);
  let footerLine = baseFooter;
  if (indicator) {
    const footerPad = contentWidth - baseFooter.length - indicator.length;
    footerLine = baseFooter + (footerPad > 0 ? ' '.repeat(footerPad) : '  ') + indicator;
  }

  const outputLines: string[] = [
    margin + headerLine,
    '',
    ...sourceLines.map(l => margin + l),
    margin + separator,
    '',
    ...visible.map(l => margin + l),
    '',
    margin + tui.dim(footerLine),
  ];

  return outputLines.join('\n');
}
