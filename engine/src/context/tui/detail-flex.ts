import { tui, wrapLines, scrollSlice, scrollIndicator } from './render.js';
import type { BrickResult } from '../types.js';
import { MODEL_SPECS } from '../models.js';

/**
 * Renders a full-screen detail view for a flex/conversation brick.
 * Pure function — no side effects.
 */
export function renderFlexDetail(
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

  const tokStr = brick.tokens.toLocaleString('en-US');
  const modelPctStr = MODEL_SPECS.map(m => {
    const pct = ((brick.tokens / m.contextWindow) * 100).toFixed(1);
    return `${m.name} ${pct}%`;
  }).join('  ');

  // Header
  const name = tui.bold(brick.name.toUpperCase());
  const badge = tui.cyan('[flex]');
  const tokInfo = tui.dim(`${tokStr} tok · ${modelPctStr}`);
  const headerRight = `${badge} ${tokInfo}`;
  const nameVis = brick.name.toUpperCase().length;
  const rightVis = '[flex]'.length + 1 + `${tokStr} tok · ${modelPctStr}`.length;
  const gap = contentWidth - nameVis - rightVis;
  const headerLine = gap > 0
    ? name + ' '.repeat(gap) + headerRight
    : name + '  ' + headerRight;

  // Config section
  const metaConfig = brick.meta?.config;
  const configLines: string[] = [];
  if (metaConfig && Object.keys(metaConfig).length > 0) {
    configLines.push(tui.bold('Configuration'));
    for (const [k, v] of Object.entries(metaConfig)) {
      const isSelected = selectedField === k;
      const isEditing = isSelected && editingValue !== undefined;
      const displayVal = isEditing ? editingValue! : String(v);
      const valStr = isEditing ? `[${displayVal}_]` : `[${displayVal}]`;
      const keyPart = isSelected ? tui.inverse(k) : k;
      const valPart = isSelected ? tui.inverse(valStr) : tui.cyan(valStr);

      const numVal = Number(v);
      if (!isNaN(numVal) && numVal > 0) {
        const modelPcts = MODEL_SPECS.map(m => {
          const pct = ((numVal / m.contextWindow) * 100).toFixed(1);
          return `${m.name} ${pct}%`;
        }).join('  ');
        configLines.push(`  ${keyPart}: ${valPart}  ${tui.dim(modelPcts)}`);
      } else {
        configLines.push(`  ${keyPart}: ${valPart}`);
      }
    }
    configLines.push('');
  }

  // Stats section — only show lines where meta value exists
  const meta = brick.meta;
  const statsLines: string[] = [];
  if (meta) {
    const statRows: string[] = [];
    if (meta.totalMessages !== undefined) {
      statRows.push(`Total messages: ${meta.totalMessages}`);
    }
    if (meta.messagesFit !== undefined) {
      statRows.push(`Messages included: ${meta.messagesFit}`);
    }
    if (meta.oldestIncluded !== undefined) {
      statRows.push(`Oldest included: ${meta.oldestIncluded}`);
    }
    if (meta.truncatedCount !== undefined) {
      statRows.push(`Truncated: ${meta.truncatedCount}`);
    }
    if (statRows.length > 0) {
      statsLines.push(tui.bold('Stats'));
      for (const row of statRows) {
        statsLines.push('  ' + tui.dim(row));
      }
      statsLines.push('');
    }
  }

  // Separator
  const sepLabel = '── Conversation Preview ';
  const separator = tui.dim(sepLabel + '─'.repeat(Math.max(0, contentWidth - sepLabel.length)));

  // Wrap content
  const rawLines = brick.content.split('\n');
  const allWrapped = wrapLines(rawLines, contentWidth);

  // Chrome: header + blank + configLines + statsLines + sep + blank + blank + footer
  const chromeLines = 1 + 1 + configLines.length + statsLines.length + 1 + 1 + 1 + 1;
  const availableHeight = Math.max(1, termRows - chromeLines);

  const { visible } = scrollSlice(allWrapped, scrollOffset, availableHeight);

  // Footer
  const hasConfig = Boolean(metaConfig && Object.keys(metaConfig).length > 0);
  const baseFooter = hasConfig
    ? '[q] Back  [↑↓] Scroll  [enter] Edit config'
    : '[q] Back  [↑↓] Scroll';
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
    ...statsLines.map(l => margin + l),
    margin + separator,
    '',
    ...visible.map(l => margin + l),
    '',
    margin + tui.dim(footerLine),
  ];

  return outputLines.join('\n');
}
