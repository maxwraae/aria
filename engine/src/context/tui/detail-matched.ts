import { tui, wrapLines, scrollSlice, scrollIndicator } from './render.js';
import type { BrickResult } from '../types.js';
import { BUDGETS } from '../models.js';

/**
 * Renders a full-screen detail view for a matched brick.
 * Pure function — no side effects.
 */
export function renderMatchedDetail(
  brick: BrickResult,
  budget: number,
  scrollOffset: number,
  selectedField?: string,
  editingValue?: string,
): string {
  const termWidth = process.stdout.columns || 80;
  const termRows = process.stdout.rows || 24;
  const contentWidth = termWidth - 4;
  const margin = '  ';

  const budgetPct = ((brick.tokens / budget) * 100).toFixed(1);

  // Header
  const name = tui.bold(brick.name.toUpperCase());
  const badge = tui.cyan('[matched]');
  const tokInfo = tui.dim(`${brick.tokens} tok · ${budgetPct}%`);
  const headerRight = `${badge} ${tokInfo}`;
  const nameVis = brick.name.toUpperCase().length;
  const rightVis = '[matched]'.length + 1 + `${brick.tokens} tok · ${budgetPct}%`.length;
  const gap = contentWidth - nameVis - rightVis;
  const headerLine = gap > 0
    ? name + ' '.repeat(gap) + headerRight
    : name + '  ' + headerRight;

  // Config section
  const metaConfig = brick.meta?.config;
  const configLines: string[] = [];
  if (metaConfig && Object.keys(metaConfig).length > 0) {
    configLines.push(tui.bold('Configuration'));
    const kvParts = Object.entries(metaConfig).map(([k, v]) => {
      const isSelected = selectedField === k;
      const isEditing = isSelected && editingValue !== undefined;
      const displayVal = isEditing ? editingValue! : String(v);
      const valStr = isEditing ? `[${displayVal}_]` : `[${displayVal}]`;
      const keyPart = isSelected ? tui.inverse(k) : k;
      const valPart = isSelected ? tui.inverse(valStr) : tui.cyan(valStr);
      return `${keyPart}: ${valPart}`;
    });
    configLines.push('  ' + kvParts.join('  '));
    configLines.push('');
  }

  // Match list section
  const matches = brick.meta?.matches;
  const totalMatches = brick.meta?.totalMatches;
  const matchLines: string[] = [];
  if (matches && matches.length > 0) {
    const showing = matches.length;
    const total = totalMatches ?? showing;
    matchLines.push(tui.bold(`Matches (showing ${showing} of ${total})`));
    for (const m of matches) {
      const check = m.included ? tui.green('[✓]') : tui.dim('[ ]');
      const label = m.included ? m.label : tui.dim(m.label);
      const tokStr = m.included
        ? tui.dim(`${m.tokens} tokens`)
        : tui.dim(`${m.tokens} tokens`);
      // Align tokens to the right within contentWidth
      const leftPart = `  ${check} ${label}`;
      const leftVis = `  [✓] ${m.label}`.length;
      const rightVis = `${m.tokens} tokens`.length;
      const padCount = Math.max(2, contentWidth - leftVis - rightVis);
      matchLines.push(leftPart + ' '.repeat(padCount) + tokStr);
    }
    matchLines.push('');
  }

  // Separator
  const sepLabel = '── Rendered Content ';
  const separator = tui.dim(sepLabel + '─'.repeat(Math.max(0, contentWidth - sepLabel.length)));

  // Wrap content
  const rawLines = brick.content.split('\n');
  const allWrapped = wrapLines(rawLines, contentWidth);

  // Chrome: header + blank + configLines + matchLines + sep + blank + blank + footer
  const chromeLines = 1 + 1 + configLines.length + matchLines.length + 1 + 1 + 1 + 1;
  const availableHeight = Math.max(1, termRows - chromeLines);

  const { visible } = scrollSlice(allWrapped, scrollOffset, availableHeight);

  // Footer
  const baseFooter = '[q] Back  [↑↓] Scroll  [space] Toggle  [enter] Edit config';
  const indicator = scrollIndicator(scrollOffset, availableHeight, allWrapped.length);
  let footerLine = baseFooter;
  if (indicator) {
    const footerPad = contentWidth - baseFooter.length - indicator.length;
    footerLine = baseFooter + (footerPad > 0 ? ' '.repeat(footerPad) : '  ') + indicator;
  }

  const outputLines: string[] = [
    margin + headerLine,
    '',
    ...configLines.map(l => margin + l),
    ...matchLines.map(l => margin + l),
    margin + separator,
    '',
    ...visible.map(l => margin + l),
    '',
    margin + tui.dim(footerLine),
  ];

  return outputLines.join('\n');
}
