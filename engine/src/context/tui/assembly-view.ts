import { tui } from './render.js';
import type { AssemblyResult } from '../assembler.js';

/**
 * Renders the full assembled context with scroll support.
 * Pure function — no side effects.
 */
export function renderAssemblyView(
  result: AssemblyResult,
  scrollOffset: number,
): string {
  const termWidth = process.stdout.columns || 80;
  const termRows = process.stdout.rows || 24;
  const contentWidth = termWidth - 4; // 2-space margin each side

  // Header line: "Full Assembly" left, total tokens right
  const title = 'Full Assembly';
  const tokStr = `${result.totalTokens.toLocaleString('en-US')} tok`;
  const gap = contentWidth - title.length - tokStr.length;
  const headerLine = gap > 0
    ? title + ' '.repeat(gap) + tokStr
    : title + '  ' + tokStr;

  // Separator spanning full content width
  const sepLabel = '── Content ';
  const separator = sepLabel + '─'.repeat(Math.max(0, contentWidth - sepLabel.length));

  // Content lines — split on newlines, then wrap long lines
  const rawLines = result.content.split('\n');
  const allWrapped: string[] = [];
  for (const raw of rawLines) {
    if (raw.length === 0) {
      allWrapped.push('');
      continue;
    }
    let remaining = raw;
    while (remaining.length > contentWidth) {
      allWrapped.push(remaining.slice(0, contentWidth));
      remaining = remaining.slice(contentWidth);
    }
    allWrapped.push(remaining);
  }

  // Available rows for content: total rows minus chrome (header, blank, sep, blank, blank+footer)
  const availableHeight = termRows - 6;
  const totalLines = allWrapped.length;
  const visibleLines = allWrapped.slice(scrollOffset, scrollOffset + availableHeight);

  // Scroll indicator: show position if content overflows
  let footerLine = '[q] Back  [↑↓] Scroll';
  if (totalLines > availableHeight) {
    const endLine = Math.min(scrollOffset + availableHeight, totalLines);
    const indicator = `(${endLine}/${totalLines})`;
    const footerPad = contentWidth - footerLine.length - indicator.length;
    footerLine = footerLine + (footerPad > 0 ? ' '.repeat(footerPad) : '  ') + indicator;
  }

  const margin = '  ';
  const outputLines = [
    margin + headerLine,
    '',
    margin + separator,
    '',
    ...visibleLines.map(l => margin + l),
    '',
    margin + tui.dim(footerLine),
  ];

  return outputLines.join('\n');
}
