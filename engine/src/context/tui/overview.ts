// Budget bar overview screen for the context assembly TUI.
// Pure rendering function — no side effects.

import { tui } from './render.js';
import type { AssemblyResult } from '../assembler-v2.js';
import type { ContextConfig } from '../config.js';
import { validateCaps } from '../config.js';

// Strip ANSI escape codes to measure the visible length of a string.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visibleLength(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

// Pad a string (which may contain ANSI codes) to a target visible width.
function padVisible(s: string, width: number, char = ' '): string {
  const len = visibleLength(s);
  const pad = Math.max(0, width - len);
  return s + char.repeat(pad);
}

// Model definitions with context window sizes and per-model fill targets.
interface ModelSpec {
  name: string;
  contextWindow: number; // total tokens
  fillTarget: number;    // fraction of contextWindow
}

const MODELS: ModelSpec[] = [
  { name: 'Opus',   contextWindow: 200_000, fillTarget: 0.50 },  // 100K budget
  { name: 'Sonnet', contextWindow: 200_000, fillTarget: 0.40 },  //  80K budget
  { name: 'Haiku',  contextWindow: 200_000, fillTarget: 0.30 },  //  60K budget
];

export function renderOverview(
  result: AssemblyResult,
  selectedIndex: number,
  budget: number,
  config?: ContextConfig,
): string {
  const MARGIN = '  '; // 2-space left margin
  const termWidth = process.stdout.columns ?? 80;
  const contentWidth = termWidth - MARGIN.length;

  // Column layout:
  //   marker(2) + number(4) + name(14) + type(10) + tokens(12) + bar(22) + model_pct * 3 (14 each)
  const COL_NUM = 4;
  const COL_NAME = 14;
  const COL_TYPE = 10;
  const COL_TOKENS = 12;
  const COL_BAR = 22; // 20 chars of bar + 2-space gap
  const COL_MODEL = 14; // per model, right-aligned

  // Max bar scale is Opus budget: 200K * 0.50 = 100K tokens
  const OPUS_BUDGET = 200_000 * 0.50; // 100_000
  const BAR_WIDTH = 20;

  function budgetBar(tokens: number): string {
    if (tokens === 0) return ' '.repeat(COL_BAR);
    const pct = tokens / OPUS_BUDGET;
    const filled = Math.max(1, Math.round(pct * BAR_WIDTH));
    const bar = '█'.repeat(filled);
    const coloredBar = pct < 0.25
      ? tui.green(bar)
      : pct < 0.50
        ? tui.yellow(bar)
        : tui.red(bar);
    // pad to BAR_WIDTH visible chars then add 2-space gap
    return padVisible(coloredBar, BAR_WIDTH) + '  ';
  }

  // Each model's budget = contextWindow * fillTarget
  function fmtPct(tokens: number, m: ModelSpec): string {
    const budget = m.contextWindow * m.fillTarget;
    return `${((tokens / budget) * 100).toFixed(1)}%`;
  }

  function formatRow(
    index: number,
    name: string,
    type: string,
    tokens: number,
    selected: boolean,
  ): string {
    const marker = selected ? tui.cyan('>') : ' ';
    const num = `${index + 1}.`;
    const nameStr = name.toUpperCase().slice(0, COL_NAME);
    const styledNum = selected ? tui.cyan(num) : tui.dim(num);
    const styledName = selected ? tui.cyan(nameStr) : nameStr;

    const tokStr = `${tokens.toLocaleString('en-US')} tok`;

    const modelPcts = MODELS.map(m =>
      fmtPct(tokens, m).padStart(COL_MODEL),
    ).join('');

    const numField = padVisible(styledNum, COL_NUM);
    const nameField = padVisible(styledName, COL_NAME);
    const typeField = padVisible(tui.dim(type), COL_TYPE);
    const tokField = tokStr.padStart(COL_TOKENS);
    const barField = budgetBar(tokens);

    return `${MARGIN}${marker} ${numField}${nameField}${typeField}${tokField}${barField}${modelPcts}`;
  }

  // Title + model column headers on the same line, aligned to the data grid.
  // Data rows: MARGIN + marker(1) + space(1) + num + name + type + tokens + bar = left portion
  const leftCols = 2 + COL_NUM + COL_NAME + COL_TYPE + COL_TOKENS + COL_BAR; // marker+space + fields
  const title = 'Context Assembly';
  const modelHeaders = MODELS.map(m => {
    const windowK = (m.contextWindow / 1000).toFixed(0);
    const label = `${m.name} ${windowK}K`;
    return label.padStart(COL_MODEL);
  }).join('');
  const titleLine = MARGIN + padVisible(title, leftCols) + tui.dim(modelHeaders);

  // Divider spanning content width
  const divider = MARGIN + tui.dim('─'.repeat(contentWidth));

  // Brick rows
  const brickRows = result.sections.map((brick, i) =>
    formatRow(i, brick.name, brick.type, brick.tokens, i === selectedIndex),
  );

  // Total row
  const totalNum = padVisible('', COL_NUM);
  const totalName = padVisible(tui.dim('TOTAL'), COL_NAME + COL_TYPE);
  const totalTok = tui.dim(`${result.totalTokens.toLocaleString('en-US')} tok`.padStart(COL_TOKENS));
  const totalModelPcts = MODELS.map(m =>
    tui.dim(fmtPct(result.totalTokens, m).padStart(COL_MODEL)),
  ).join('');
  const totalBar = budgetBar(result.totalTokens);
  // Total row uses 2-space margin + space for marker column
  const totalRow = `${MARGIN}  ${totalNum}${totalName}${totalTok}${totalBar}${totalModelPcts}`;

  // Help line
  const helpLine = MARGIN + tui.dim('[↑↓] Navigate  [enter] View brick  [a] Full assembly  [q] Quit');

  // Cap validation warnings/errors
  const validationLines: string[] = [];
  if (config) {
    const { warnings, errors } = validateCaps(config, budget);
    for (const w of warnings) {
      validationLines.push(MARGIN + tui.yellow(`⚠ Warning: ${w}`));
    }
    for (const e of errors) {
      validationLines.push(MARGIN + tui.red(`✗ Error: ${e}`));
    }
  }

  const lines: string[] = [
    titleLine,
    '',
    ...brickRows,
    '',
    divider,
    totalRow,
    '',
    ...validationLines,
    ...(validationLines.length > 0 ? [''] : []),
    helpLine,
  ];

  return lines.join('\n');
}
