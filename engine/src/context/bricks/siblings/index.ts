import { readFileSync } from "fs";
import type { Brick, BrickContext, BrickResult } from "../../types.js";
import { getSiblings, getObjective, getConversation } from "../../../db/queries.js";
import type { Objective } from "../../../db/queries.js";
import { countTokens } from "../../tokens.js";
import type Database from "better-sqlite3";

function daysAgo(timestamp: number): number {
  return Math.floor((Date.now() / 1000 - timestamp) / 86400);
}

function statusLine(obj: Objective): string {
  const parts = [obj.status];
  if (obj.waiting_on) parts.push(`waiting on: ${obj.waiting_on}`);
  parts.push(`Last updated ${daysAgo(obj.updated_at)} days ago`);
  return parts.join(" · ");
}

function renderSiblingDetailed(db: Database.Database, sibling: Objective): string {
  const lines: string[] = [];
  lines.push(`---`);
  lines.push(``);
  lines.push(`### ${sibling.objective}`);

  if (sibling.status === "resolved") {
    lines.push(``);
    lines.push(`resolved · ${daysAgo(sibling.resolved_at ?? sibling.updated_at)} days ago`);

    if (sibling.description) {
      lines.push(``);
      lines.push(`> ${sibling.description}`);
    }

    if (sibling.resolution_summary) {
      lines.push(``);
      lines.push(`**Resolution:** ${sibling.resolution_summary}`);
    }

    return lines.join("\n");
  }

  // Active / idle siblings
  lines.push(``);
  lines.push(statusLine(sibling));

  if (sibling.description) {
    lines.push(``);
    lines.push(`> ${sibling.description}`);
  }

  if (sibling.work_path) {
    try {
      const workContent = readFileSync(sibling.work_path, "utf-8").trim();
      if (workContent) {
        lines.push(``);
        lines.push(`**Work:**`);
        lines.push(workContent);
      }
    } catch {}
  }

  const messages = getConversation(db, sibling.id, 5);
  if (messages.length > 0) {
    lines.push(``);
    lines.push(`Messages:`);
    for (const msg of messages) {
      lines.push(`- [${msg.sender}] ${msg.message}`);
    }
  }

  return lines.join("\n");
}

function renderSiblingOneLiner(sibling: Objective): string {
  return `- **${sibling.objective}** · ${statusLine(sibling)}`;
}

const siblingsBrick: Brick = {
  name: "SIBLINGS",
  type: "tree",
  render(ctx: BrickContext): BrickResult | null {
    if (!ctx.db || !ctx.objectiveId) return null;

    const siblings = getSiblings(ctx.db, ctx.objectiveId);
    const totalCount = siblings.length;
    if (totalCount === 0) return null;

    const obj = getObjective(ctx.db, ctx.objectiveId);
    const parent = obj?.parent ? getObjective(ctx.db, obj.parent) : undefined;
    const parentName = parent?.objective ?? "unknown";

    const maxTokens = (ctx.config?.siblings as any)?.max_tokens ?? 2000;

    const header = `# SIBLINGS\n\n${totalCount} siblings under "${parentName}" (your parent). Token budget: ${maxTokens}`;

    const detailedBlocks: string[] = [];
    let cumulativeText = header;
    let overflowStartIndex = -1;

    for (let i = 0; i < siblings.length; i++) {
      const block = renderSiblingDetailed(ctx.db, siblings[i]);
      const candidate = cumulativeText + "\n\n" + block;

      if (countTokens(candidate) > maxTokens) {
        overflowStartIndex = i;
        break;
      }

      detailedBlocks.push(block);
      cumulativeText = candidate;
    }

    let overflowSection = "";
    if (overflowStartIndex !== -1) {
      const overflowSiblings = siblings.slice(overflowStartIndex);
      const overflowCount = overflowSiblings.length;
      const oneLiners = overflowSiblings.map(renderSiblingOneLiner).join("\n");
      const overflowCandidate = cumulativeText + `\n\n${overflowCount} more siblings not shown:\n` + oneLiners;

      if (countTokens(overflowCandidate) <= maxTokens) {
        overflowSection = `\n\n${overflowCount} more siblings not shown:\n` + oneLiners;
      } else {
        overflowSection = `\n\n${overflowCount} more siblings not shown.`;
      }
    }

    const content = header + "\n" + detailedBlocks.join("\n\n") + overflowSection;
    const tokens = countTokens(content);

    return {
      name: "SIBLINGS",
      type: "tree" as const,
      content,
      tokens,
      meta: {
        config: { max_tokens: maxTokens },
        condition: `${totalCount} siblings`,
        conditionMet: totalCount > 0,
      },
    };
  },
};

export default siblingsBrick;
