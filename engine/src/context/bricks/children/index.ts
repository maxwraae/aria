import { readFileSync } from "fs";
import type { Brick, BrickContext, BrickResult } from "../../types.js";
import { getChildren, getConversation, getSubtreeStats } from "../../../db/queries.js";
import type { Objective, SubtreeStats } from "../../../db/queries.js";
import { countTokens } from "../../tokens.js";
import type Database from "better-sqlite3";

function daysAgo(timestamp: number): number {
  return Math.floor((Date.now() / 1000 - timestamp) / 86400);
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000 - timestamp);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function statusLine(obj: Objective): string {
  const parts = [obj.status];
  if (obj.waiting_on) parts.push(`waiting on: ${obj.waiting_on}`);
  parts.push(`Last updated ${daysAgo(obj.updated_at)} days ago`);
  if (obj.fail_count > 0) parts.push(`${obj.fail_count} fail`);
  return parts.join(" · ");
}

function renderSubtreeSummary(stats: SubtreeStats): string {
  if (stats.totalDescendants === 0) return '';

  const parts: string[] = [];
  if (stats.activeCount > 0) parts.push(`${stats.activeCount} active`);
  if (stats.resolvedCount > 0) parts.push(`${stats.resolvedCount} resolved`);
  if (stats.failedCount > 0) parts.push(`${stats.failedCount} failed`);
  if (stats.abandonedCount > 0) parts.push(`${stats.abandonedCount} abandoned`);
  if (stats.idleCount > 0) parts.push(`${stats.idleCount} idle`);

  const depth = stats.deepestLevel > 1 ? ` · ${stats.deepestLevel} levels deep` : '';
  const ago = timeAgo(stats.mostRecentActivity);

  return `Subtree: ${parts.join(', ')}${depth} · last activity ${ago}`;
}

function grandchildSummary(db: Database.Database, grandchild: Objective): string {
  const stats = getSubtreeStats(db, grandchild.id);
  const gcStats = stats.get(grandchild.id);

  let line = `- **${grandchild.objective}** · ${grandchild.status} · updated ${timeAgo(grandchild.updated_at)}`;
  if (grandchild.waiting_on) {
    line += ` · waiting on: ${grandchild.waiting_on}`;
  }

  if (gcStats && gcStats.totalDescendants > 0) {
    const parts: string[] = [];
    if (gcStats.activeCount > 0) parts.push(`${gcStats.activeCount} active`);
    if (gcStats.resolvedCount > 0) parts.push(`${gcStats.resolvedCount} resolved`);
    if (gcStats.idleCount > 0) parts.push(`${gcStats.idleCount} idle`);
    if (gcStats.failedCount > 0) parts.push(`${gcStats.failedCount} failed`);
    if (parts.length > 0) {
      line += `\n  └ ${parts.join(', ')} below`;
    }
  }

  return line;
}

function renderGrandchildren(db: Database.Database, child: Objective): string {
  const grandchildren = getChildren(db, child.id);
  if (grandchildren.length === 0) return "### Grandchildren\nNone yet.";

  // Sort grandchildren by most recent activity
  grandchildren.sort((a, b) => b.updated_at - a.updated_at);

  const lines = ["### Grandchildren"];
  for (const gc of grandchildren) {
    lines.push(grandchildSummary(db, gc));
  }

  return lines.join("\n");
}

function renderChildDetailed(db: Database.Database, child: Objective, index: number, maxTokensPerChild: number): string {
  const parts: string[] = [];
  parts.push(`---`);
  parts.push(``);
  parts.push(`## Child ${index}: ${child.objective}`);
  parts.push(``);

  // Status section
  parts.push(`### Status`);
  if (child.status === "resolved") {
    parts.push(`resolved · ${daysAgo(child.resolved_at ?? child.updated_at)} days ago`);
    if (child.resolution_summary) {
      parts.push(`**Resolution:** ${child.resolution_summary}`);
    }
  } else {
    const statusParts = [child.status];
    if (child.waiting_on) statusParts.push(`waiting on: ${child.waiting_on}`);
    statusParts.push(`Last updated ${timeAgo(child.updated_at)}`);
    if (child.fail_count > 0) statusParts.push(`${child.fail_count} fail`);
    parts.push(statusParts.join(" · "));
  }

  // Description section
  if (child.description) {
    parts.push(``);
    parts.push(`### Description`);
    parts.push(child.description);
  }

  // Work document section
  if (child.work_path) {
    try {
      const workContent = readFileSync(child.work_path, "utf-8").trim();
      if (workContent) {
        parts.push(``);
        parts.push(`### Work`);
        parts.push(workContent);
      }
    } catch {}
  }

  // Grandchildren section
  parts.push(``);
  parts.push(renderGrandchildren(db, child));

  const headerText = parts.join("\n");

  // Messages section with token trimming
  const allMsgs = getConversation(db, child.id, 10);
  if (allMsgs.length === 0) return headerText;

  let msgs = allMsgs;
  while (msgs.length > 0) {
    const msgLines = [``, `### Messages`];
    for (const msg of msgs) {
      msgLines.push(`- [${msg.sender}] ${msg.message}`);
    }
    const fullBlock = headerText + "\n" + msgLines.join("\n");
    if (countTokens(fullBlock) <= maxTokensPerChild) {
      return fullBlock;
    }
    msgs = msgs.slice(1);
  }

  return headerText;
}

function renderOverviewLine(child: Objective, index: number, db: Database.Database, statsMap: Map<string, SubtreeStats>): string {
  const stats = statsMap.get(child.id);
  const grandchildren = getChildren(db, child.id);
  const grandchildCount = grandchildren.length;

  let line = `${index}. **${child.objective}** · ${child.status} · ${timeAgo(child.updated_at)}`;

  if (grandchildCount === 0) {
    line += ` · no children`;
  } else {
    // Use stats to show active/resolved counts among grandchildren
    if (stats && stats.totalDescendants > 0) {
      const parts: string[] = [];
      if (stats.activeCount > 0) parts.push(`${stats.activeCount} active`);
      if (stats.resolvedCount > 0) parts.push(`${stats.resolvedCount} resolved`);
      if (parts.length > 0) {
        line += ` · ${parts.join(', ')} grandchildren`;
      } else {
        line += ` · ${grandchildCount} grandchildren`;
      }
    } else {
      line += ` · ${grandchildCount} grandchildren`;
    }
  }

  return line;
}

const childrenBrick: Brick = {
  name: "CHILDREN",
  type: "tree",
  render(ctx: BrickContext): BrickResult | null {
    if (!ctx.db || !ctx.objectiveId) return null;

    const children = getChildren(ctx.db, ctx.objectiveId);
    const totalCount = children.length;
    if (totalCount === 0) return null;

    const maxTokens = (ctx.config?.children as any)?.max_tokens ?? 10000;
    const maxTokensPerChild = (ctx.config?.children as any)?.max_tokens_per_child ?? 1200;

    // Get subtree stats and sort by most recent activity
    const statsMap = getSubtreeStats(ctx.db, ctx.objectiveId);

    // Sort children: most recently active branch first
    children.sort((a, b) => {
      const statsA = statsMap.get(a.id);
      const statsB = statsMap.get(b.id);
      const actA = statsA?.mostRecentActivity ?? a.updated_at;
      const actB = statsB?.mostRecentActivity ?? b.updated_at;
      return actB - actA;
    });

    // Build overview list (all children)
    const overviewLines = ["## Overview", ""];
    for (let i = 0; i < children.length; i++) {
      overviewLines.push(renderOverviewLine(children[i], i + 1, ctx.db, statsMap));
    }
    const overviewSection = overviewLines.join("\n");

    // Greedy fill: render detailed sections until total budget hit
    let detailedBlocks: string[] = [];
    let detailedCount = 0;

    // Seed cumulative text with header placeholder + overview
    const headerPlaceholder = `# CHILDREN\n\n__HEADER__`;
    let cumulativeText = headerPlaceholder + "\n\n" + overviewSection;
    let overflowStartIndex = -1;

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const block = renderChildDetailed(ctx.db, child, i + 1, maxTokensPerChild);
      const candidate = cumulativeText + "\n\n" + block;

      if (countTokens(candidate) > maxTokens) {
        overflowStartIndex = i;
        break;
      }

      detailedBlocks.push(block);
      cumulativeText = candidate;
      detailedCount++;
    }

    const headerLine =
      detailedCount < totalCount
        ? `${totalCount} children, ${detailedCount} shown in detail (~${maxTokensPerChild} tok/child, ${maxTokens} tok total)`
        : `${totalCount} children, all shown in detail (~${maxTokensPerChild} tok/child, ${maxTokens} tok total)`;

    const content =
      `# CHILDREN\n\n${headerLine}\n\n` +
      overviewSection +
      (detailedBlocks.length > 0 ? "\n\n" + detailedBlocks.join("\n\n") : "");

    const tokens = countTokens(content);

    return {
      name: "CHILDREN",
      type: "tree" as const,
      content,
      tokens,
      meta: {
        config: { max_tokens: maxTokens, max_tokens_per_child: maxTokensPerChild },
        condition: `${totalCount} children`,
        conditionMet: totalCount > 0,
      },
    };
  },
};

export default childrenBrick;
