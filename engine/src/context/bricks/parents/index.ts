import { readFileSync } from "fs";
import type { Brick, BrickContext, BrickResult } from "../../types.js";
import { getAncestors, getConversation } from "../../../db/queries.js";
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

function renderFullAncestor(
  heading: string,
  obj: Objective,
  db: Database.Database,
  msgLimit: number
): string {
  const lines: string[] = [];

  lines.push(`# ${heading}`, ``);
  lines.push(obj.objective, ``);

  if (obj.description) {
    lines.push(`## Description`, ``);
    lines.push(obj.description, ``);
  }

  if (obj.work_path) {
    try {
      const workContent = readFileSync(obj.work_path, "utf-8").trim();
      if (workContent) {
        lines.push(`## Work`, ``);
        lines.push(workContent, ``);
      }
    } catch {}
  }

  lines.push(`## Status`, ``);
  lines.push(statusLine(obj), ``);

  const messages = getConversation(db, obj.id, msgLimit);
  if (messages.length > 0) {
    lines.push(`## Recent messages`, ``);
    for (const msg of messages) {
      lines.push(`- [${msg.sender}] ${msg.message}`);
    }
    lines.push(``);
  }

  return lines.join("\n").trimEnd();
}

function renderMoreAncestors(
  remaining: Objective[],
  db: Database.Database,
  maxTokens: number
): string {
  // remaining is ordered root-first; display closest-first (reverse)
  const displayed = [...remaining].reverse();
  const n = displayed.length;

  const overviewLines: string[] = [];
  overviewLines.push(`# ${n} MORE ANCESTORS`, ``);
  overviewLines.push(`Token budget: ${maxTokens}. Messages trimmed to fit.`, ``);

  for (let i = 0; i < displayed.length; i++) {
    const obj = displayed[i];
    // i=0 is 3 levels up (closest), i=last is furthest (possibly root)
    const levelsUp = 3 + i;
    const isRoot = obj.parent === null;
    const label = isRoot ? "root" : `${levelsUp} levels up`;
    overviewLines.push(`${i + 1}. ${obj.objective} · ${statusLine(obj)} (${label})`);
  }

  const overviewText = overviewLines.join("\n");

  // Greedily expand detail sections from closest (i=0) to farthest
  const detailSections: string[] = [];
  let tokensSoFar = countTokens(overviewText);

  for (let i = 0; i < displayed.length; i++) {
    const obj = displayed[i];
    const messages = getConversation(db, obj.id, 3);

    const sectionLines: string[] = [];
    sectionLines.push(`## ${i + 1}. ${obj.objective}`, ``);

    if (obj.description) {
      sectionLines.push(obj.description, ``);
    }

    if (obj.work_path) {
      try {
        const workContent = readFileSync(obj.work_path, "utf-8").trim();
        if (workContent) {
          sectionLines.push(`**Work:**`);
          sectionLines.push(workContent, ``);
        }
      } catch {}
    }

    sectionLines.push(`**Status:** ${statusLine(obj)}`);

    if (messages.length > 0) {
      sectionLines.push(``);
      sectionLines.push(`**Recent messages:**`);
      for (const msg of messages) {
        sectionLines.push(`- [${msg.sender}] ${msg.message}`);
      }
    }

    const sectionText = sectionLines.join("\n");
    const sectionTokens = countTokens(sectionText);

    if (tokensSoFar + sectionTokens > maxTokens) {
      break;
    }

    detailSections.push(sectionText);
    tokensSoFar += sectionTokens;
  }

  const parts = [overviewText];
  if (detailSections.length > 0) {
    parts.push(``);
    parts.push(...detailSections);
  }

  return parts.join("\n").trimEnd();
}

const parentsBrick: Brick = {
  name: "PARENTS",
  type: "tree",
  render(ctx: BrickContext): BrickResult | null {
    if (!ctx.db || !ctx.objectiveId) return null;

    const ancestors = getAncestors(ctx.db, ctx.objectiveId);
    if (ancestors.length === 0) return null;

    const maxTokens = (ctx.config?.parents as any)?.max_tokens ?? 2000;

    const parent = ancestors[ancestors.length - 1];
    const grandparent = ancestors.length >= 2 ? ancestors[ancestors.length - 2] : undefined;
    const remaining = ancestors.length >= 2 ? ancestors.slice(0, ancestors.length - 2) : [];

    const sections: string[] = [];

    // Section 1: YOUR PARENT (always)
    sections.push(renderFullAncestor("YOUR PARENT", parent, ctx.db, 5));

    // Section 2: YOUR PARENT'S PARENT (if exists)
    if (grandparent) {
      sections.push(renderFullAncestor("YOUR PARENT'S PARENT", grandparent, ctx.db, 5));
    }

    // Section 3: MORE ANCESTORS (if any remaining beyond grandparent)
    if (remaining.length > 0) {
      sections.push(renderMoreAncestors(remaining, ctx.db, maxTokens));
    }

    const content = sections.join("\n\n");

    return {
      name: "PARENTS",
      type: "tree" as const,
      content,
      tokens: countTokens(content),
      ...(remaining.length > 0 && {
        meta: {
          config: { max_tokens: maxTokens },
          condition: `${ancestors.length} ancestors`,
          conditionMet: ancestors.length > 0,
        },
      }),
    };
  },
};

export default parentsBrick;
