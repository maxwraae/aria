import type Database from "better-sqlite3";
import { getObjective } from "../db/queries.js";

// ── Types ──────────────────────────────────────────────────────────

export interface CommandDef {
  name: string;
  syntax: string;
  args: ArgDef[];
  scope: "self" | "descendant" | "any" | "none";
  description: string;
}

export interface ArgDef {
  name: string;
  required: boolean;
  type: "string" | "boolean" | "flag-pair";
  positional?: boolean;
}

// ── Ancestry helper ────────────────────────────────────────────────

export function isDescendantOf(db: Database.Database, targetId: string, ancestorId: string): boolean {
  let current = db.prepare('SELECT parent FROM objectives WHERE id = ?').get(targetId) as { parent: string | null } | undefined;
  while (current?.parent) {
    if (current.parent === ancestorId) return true;
    current = db.prepare('SELECT parent FROM objectives WHERE id = ?').get(current.parent) as { parent: string | null } | undefined;
  }
  return false;
}

// ── Terminal status check ──────────────────────────────────────────

const TERMINAL_STATUSES = ['resolved', 'failed', 'abandoned'];

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.includes(status);
}

// ── Command definitions ────────────────────────────────────────────

export const commands: Record<string, CommandDef> = {
  create: {
    name: "create",
    syntax: 'aria create "desired state" ["instructions"] [--model <model>]',
    args: [
      { name: "objective", required: true, type: "string", positional: true },
      { name: "instructions", required: false, type: "string", positional: true },
      { name: "model", required: false, type: "string" },
    ],
    scope: "none",
    description: "Create a child objective under your current objective",
  },
  succeed: {
    name: "succeed",
    syntax: 'aria succeed <id> "summary"',
    args: [
      { name: "id", required: true, type: "string", positional: true },
      { name: "summary", required: true, type: "string", positional: true },
    ],
    scope: "descendant",
    description: "Resolve a child/descendant objective with a summary of what was achieved",
  },
  fail: {
    name: "fail",
    syntax: 'aria fail <id> "reason"',
    args: [
      { name: "id", required: true, type: "string", positional: true },
      { name: "reason", required: true, type: "string", positional: true },
    ],
    scope: "descendant",
    description: "Fail a child/descendant objective with a reason",
  },
  wait: {
    name: "wait",
    syntax: 'aria wait "reason"',
    args: [
      { name: "reason", required: true, type: "string", positional: true },
    ],
    scope: "self",
    description: "Set current objective to waiting on something external",
  },
  tell: {
    name: "tell",
    syntax: 'aria tell <id> "message"',
    args: [
      { name: "id", required: true, type: "string", positional: true },
      { name: "message", required: true, type: "string", positional: true },
    ],
    scope: "any",
    description: "Send a message to any objective",
  },
  notify: {
    name: "notify",
    syntax: 'aria notify "message" --important/--not-important --urgent/--not-urgent',
    args: [
      { name: "message", required: true, type: "string", positional: true },
      { name: "important", required: true, type: "flag-pair" },
      { name: "urgent", required: true, type: "flag-pair" },
    ],
    scope: "none",
    description: "Notify Max directly with importance and urgency flags",
  },
  find: {
    name: "find",
    syntax: 'aria find "query"',
    args: [
      { name: "query", required: true, type: "string", positional: true },
    ],
    scope: "none",
    description: "Search objectives by keyword",
  },
  show: {
    name: "show",
    syntax: "aria show <id>",
    args: [
      { name: "id", required: true, type: "string", positional: true },
    ],
    scope: "none",
    description: "Show details of an objective",
  },
  tree: {
    name: "tree",
    syntax: "aria tree",
    args: [],
    scope: "none",
    description: "Show the objective tree",
  },
  inbox: {
    name: "inbox",
    syntax: "aria inbox <id> [--limit <n>]",
    args: [
      { name: "id", required: true, type: "string", positional: true },
      { name: "limit", required: false, type: "string" },
    ],
    scope: "none",
    description: "Show conversation for an objective",
  },
};

// ── Validation functions ───────────────────────────────────────────
// Each returns null on success, or an error string.

export function validateCreate(objectiveText: string | undefined): string | null {
  if (!objectiveText) {
    return `Usage: ${commands.create.syntax}`;
  }
  return null;
}

export function validateSucceed(
  db: Database.Database,
  targetId: string | undefined,
  summary: string | undefined,
  callerId: string | undefined,
): string | null {
  if (!targetId) {
    return `Usage: ${commands.succeed.syntax}`;
  }

  if (!summary || summary.trim() === "") {
    return 'aria succeed requires a resolution summary. Usage: aria succeed <id> "what was achieved and how". The summary helps your parent understand the outcome.';
  }

  const obj = getObjective(db, targetId);
  if (!obj) {
    return `Objective not found: ${targetId}`;
  }

  if (!obj.parent) {
    return "Cannot succeed the root objective.";
  }

  if (isTerminal(obj.status)) {
    return `Cannot succeed objective ${targetId}: status is already '${obj.status}'. No action needed.`;
  }

  if (callerId && callerId === targetId) {
    return "Cannot succeed yourself. Your parent decides when you're done. Use aria notify to signal completion if needed.";
  }

  if (callerId && callerId !== 'max') {
    if (!isDescendantOf(db, targetId, callerId)) {
      return `Cannot succeed objective ${targetId}: it is not your child or descendant. You can only resolve objectives you created. To report your own completion, your parent will succeed you.`;
    }
  }

  return null;
}

export function validateFail(
  db: Database.Database,
  targetId: string | undefined,
  reason: string | undefined,
  callerId: string | undefined,
): string | null {
  if (!targetId) {
    return `Usage: ${commands.fail.syntax}`;
  }

  if (!reason || reason.trim() === "") {
    return 'aria fail requires a reason. Usage: aria fail <id> "why it failed". The reason helps your parent decide what to try next.';
  }

  const obj = getObjective(db, targetId);
  if (!obj) {
    return `Objective not found: ${targetId}`;
  }

  if (isTerminal(obj.status)) {
    return `Cannot fail: objective is already ${obj.status}`;
  }

  if (callerId && callerId === targetId) {
    return "Cannot fail yourself. Your parent decides your fate. Use aria notify to report problems.";
  }

  if (callerId && callerId !== 'max') {
    if (!isDescendantOf(db, targetId, callerId)) {
      return `Cannot fail objective ${targetId}: it is not your child or descendant. You can only fail objectives you created.`;
    }
  }

  return null;
}

export function validateWait(
  reason: string | undefined,
  callerId: string | undefined,
): string | null {
  if (!reason) {
    return 'Usage: aria wait "reason"';
  }

  if (!callerId) {
    return "Cannot wait: no ARIA_OBJECTIVE_ID set. This command only works during an engine turn.";
  }

  return null;
}

export function validateTell(
  db: Database.Database,
  targetId: string | undefined,
  message: string | undefined,
): string | null {
  if (!targetId || !message) {
    return `Usage: ${commands.tell.syntax}`;
  }

  const obj = getObjective(db, targetId);
  if (!obj) {
    return `Objective ${targetId} not found. Use aria find "keyword" to search for objectives, or aria tree to see the active tree.`;
  }

  return null;
}

export function validateNotify(
  message: string | undefined,
  flags: Record<string, string | boolean>,
): string | null {
  if (!message) {
    return `Usage: ${commands.notify.syntax}`;
  }

  const hasImportant = 'important' in flags;
  const hasNotImportant = 'not-important' in flags;
  if (!hasImportant && !hasNotImportant) {
    return "aria notify requires an importance flag. Add --important or --not-important.";
  }

  const hasUrgent = 'urgent' in flags;
  const hasNotUrgent = 'not-urgent' in flags;
  if (!hasUrgent && !hasNotUrgent) {
    return "aria notify requires an urgency flag. Add --urgent or --not-urgent.";
  }

  return null;
}
