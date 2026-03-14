import type { Brick, BrickContext, BrickResult } from "../../types.js";
import { countTokens } from "../../tokens.js";
import Database from "better-sqlite3";
import {
  getObjective,
  getAncestors,
  getSiblings,
  getChildren,
  getConversation,
  type Objective,
} from "../../../db/queries.js";

function statusTag(obj: Objective): string {
  let tag = obj.status;
  if (obj.waiting_on) {
    tag += `, waiting on: ${obj.waiting_on}`;
  }
  return tag;
}

function formatSelf(obj: Objective): string {
  const lines: string[] = [
    `# YOUR OBJECTIVE`,
    ``,
    `"${obj.objective}"`,
    `Status: ${obj.status}`,
  ];
  if (obj.waiting_on) lines.push(`Waiting on: ${obj.waiting_on}`);
  if (obj.description) lines.push(`Description: ${obj.description}`);
  return lines.join("\n");
}

function formatAncestors(ancestors: Objective[], self: Objective): string {
  if (ancestors.length === 0) return "";

  const lines: string[] = [`# WHY CHAIN`, ``];
  let indent = "";
  for (const a of ancestors) {
    lines.push(`${indent}${a.parent === null ? "root" : ""} → "${a.objective}"`);
    indent += "  ";
  }
  lines.push(`${indent}→ YOUR OBJECTIVE: "${self.objective}"`);
  return lines.join("\n");
}

function formatSiblings(siblings: Objective[]): string {
  if (siblings.length === 0) return "";

  const lines: string[] = [`# SIBLINGS (same parent)`, ``];
  for (const s of siblings) {
    lines.push(`- "${s.objective}" [${statusTag(s)}]`);
  }
  return lines.join("\n");
}

function formatChildren(
  db: Database.Database,
  children: Objective[]
): string {
  if (children.length === 0) return "";

  const cap = 20;
  const detailed = 5;
  const capped = children.slice(0, cap);
  const lines: string[] = [`# CHILDREN`, ``];

  for (let i = 0; i < capped.length; i++) {
    const child = capped[i];
    if (i < detailed) {
      const msgs = getConversation(db, child.id, 1);
      const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1].message : "(none)";
      lines.push(`${i + 1}. "${child.objective}" [${statusTag(child)}]`);
      lines.push(`   Last message: ${lastMsg}`);
      lines.push(``);
    } else {
      lines.push(`- "${child.objective}" [${statusTag(child)}]`);
    }
  }

  if (children.length > cap) {
    lines.push(
      `--- ${children.length - cap} more children (use \`aria find\` to search) ---`
    );
  }

  return lines.join("\n");
}

function getObjectiveContext(
  db: Database.Database,
  objectiveId: string
): string {
  const obj = getObjective(db, objectiveId);
  if (!obj) return `# YOUR OBJECTIVE\n\n(objective ${objectiveId} not found)`;

  const ancestors = getAncestors(db, objectiveId);
  const siblings = getSiblings(db, objectiveId);
  const children = getChildren(db, objectiveId);

  const sections = [
    formatSelf(obj),
    formatAncestors(ancestors, obj),
    formatSiblings(siblings),
    formatChildren(db, children),
  ].filter((s) => s.length > 0);

  return sections.join("\n\n");
}

const treeBrick: Brick = {
  name: "OBJECTIVE_TREE",
  type: "tree",
  render(ctx: BrickContext): BrickResult | null {
    if (!ctx.db || !ctx.objectiveId) return null;

    const content = getObjectiveContext(ctx.db, ctx.objectiveId);
    const tokens = countTokens(content);

    return {
      name: "OBJECTIVE_TREE",
      type: "tree" as const,
      content,
      tokens,
    };
  },
};

export default treeBrick;
