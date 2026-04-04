#!/usr/bin/env node

import { openDb, openDbReadonly, migrateDb } from '../db/schema.js';
import { getTree, getObjective, getChildren, createObjective, insertMessage, getConversation, updateStatus, cascadeAbandon, setWaitingOn, clearWaitingOn, setResolutionSummary, searchObjectives, getSenderRelation, createSchedule, listSchedules, getTreeUnified, getObjectiveUnified, getConversationUnified, getChildrenUnified, PROTECTED_IDS, checkDepthCap, getMaxAutonomousDepth, getActiveChildCount, getMaxChildren } from '../db/queries.js';
import { withPeer } from '../db/unified.js';
import { loadEngineConfig } from '../engine/engine-config.js';
import { generateId } from '../db/utils.js';
import { startEngine } from '../engine/loop.js';
import { startEmbedDaemon } from '../memory/embed-daemon.js';
import { startServer } from '../server/index.js';
import { isDeepWork } from '../engine/concurrency.js';
import { isWorker } from '../db/node.js';
import { initPush, sendPushToAll } from '../server/push.js';
import { validateCreate, validateSucceed, validateFail, validateReject, validateWait, validateTell, validateNotify } from '../commands/registry.js';
import type { Objective, InboxMessage } from '../db/queries.js';
import { parseInterval } from './parse-interval.js';
import { execFile, spawn } from 'child_process';
import { assembleContext } from '../context/assembler.js';
import personaBrick from '../context/bricks/persona/index.js';
import ariaBrick from '../context/bricks/contract/index.js';
import focusBrick from '../context/bricks/focus/index.js';
import environmentBrick from '../context/bricks/environment/index.js';
import similarBrick from '../context/bricks/similar/index.js';
import objectiveBrick from '../context/bricks/objective/index.js';
import parentsBrick from '../context/bricks/parents/index.js';
import siblingsBrick from '../context/bricks/siblings/index.js';
import childrenBrick from '../context/bricks/children/index.js';
import conversationBrick from '../context/bricks/conversation/index.js';
import neverBrick from '../context/bricks/never/index.js';
import { launchTUI } from '../context/tui/index.js';
import { loadConfig } from '../context/config.js';
import { MODELS } from '../context/models.js';
import fs from 'fs';

// ── Flag parsing ─────────────────────────────────────────────────

function parseFlags(args: string[]): { positional: string[], flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      // Check if next arg is a value (not another flag, and exists)
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key] = args[i + 1];
        i++;
      } else {
        flags[key] = true; // boolean flag
      }
    } else {
      positional.push(args[i]);
    }
  }
  return { positional, flags };
}

// ── TTY detection ─────────────────────────────────────────────────

const isTTY = process.stdout.isTTY ?? false;

// ── Colors (only when TTY) ────────────────────────────────────────

const color = {
  dim:       (s: string) => isTTY ? `\x1b[2m${s}\x1b[0m` : s,
  yellow:    (s: string) => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  cyan:      (s: string) => isTTY ? `\x1b[36m${s}\x1b[0m` : s,
  green:     (s: string) => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  red:       (s: string) => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  magenta:   (s: string) => isTTY ? `\x1b[35m${s}\x1b[0m` : s,
  blue:      (s: string) => isTTY ? `\x1b[34m${s}\x1b[0m` : s,
  strikethrough: (s: string) => isTTY ? `\x1b[2m\x1b[9m${s}\x1b[0m` : s,
};

function colorStatus(status: string): string {
  switch (status) {
    case 'idle':        return color.dim(`[${status}]`);
    case 'thinking':    return color.yellow(`[${status}]`);
    case 'needs-input': return color.cyan(`[${status}]`);
    case 'resolved':    return color.green(`[${status}]`);
    case 'failed':      return color.red(`[${status}]`);
    case 'abandoned':   return color.strikethrough(`[${status}]`);
    default:            return `[${status}]`;
  }
}

// ── Help ──────────────────────────────────────────────────────────

const HELP = `
aria - objective engine for Max

Usage: aria <command> [args...]

Commands:
  spawn-child "objective" "description" "message"       Create a child objective
  report-to-parent "message"                             Report result to your parent
  resolve-child <id> succeed "summary"                   Resolve a child as done
  resolve-child <id> fail "reason"                       Fail a child objective
  talk-to-child <id> "message"                           Send feedback to a child (resets to idle)
  talk <id> "message"                                    Send message to any objective
  notify-max "message" --important --urgent              Notify Max directly
  wait "reason"                                          Park until something external arrives
  tree                                                   Show objective tree
  show <id>                                              Show one objective
  inbox <id>                                             Show conversation for objective
  find "query"                                           Search objectives
  schedule <id> "message" --interval <interval>          Schedule recurring message
  schedules [id]                                         List active schedules

Monitoring & Debug:
  active                                                 Objectives currently thinking
  alive                                                  All non-terminal objectives
  recent                                                 15 most recently updated objectives
  unprocessed                                            Inbox messages not yet picked up
  stuck                                                  Failing or idle-too-long objectives
  errors                                                 Objectives with errors
  waiting                                                Objectives parked on something
  cascade [cascade_id]                                   Trace a cascade chain
  stats                                                  Counts by status, turns, messages
  today                                                  Objectives updated today
  children <id>                                          Children of an objective
  history <id>                                           Turn history for an objective

Aliases (backward compat):
  create, succeed, fail, reject, tell, notify, send

Options:
  --help                                                 Show this help message
`.trim();

// ── Tree formatting ───────────────────────────────────────────────

interface TreeNode {
  objective: Objective;
  children: TreeNode[];
}

function buildTree(objectives: Objective[]): TreeNode[] {
  const byParent = new Map<string | null, Objective[]>();
  for (const obj of objectives) {
    const key = obj.parent ?? '__root__';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(obj);
  }

  function buildNodes(parentId: string | null): TreeNode[] {
    const key = parentId ?? '__root__';
    const children = byParent.get(key) ?? [];
    return children.map(obj => ({
      objective: obj,
      children: buildNodes(obj.id),
    }));
  }

  return buildNodes(null);
}

function printTree(nodes: TreeNode[], prefix: string = ''): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const connector = prefix === '' ? '' : (isLast ? '└── ' : '├── ');
    const line = `${prefix}${connector}${node.objective.objective} ${colorStatus(node.objective.status)}`;
    console.log(line);

    const childPrefix = prefix === ''
      ? ''
      : prefix + (isLast ? '    ' : '│   ');
    printTree(node.children, childPrefix);
  }
}

function treeToJson(nodes: TreeNode[]): unknown[] {
  return nodes.map(n => ({
    id: n.objective.id,
    objective: n.objective.objective,
    status: n.objective.status,
    children: treeToJson(n.children),
  }));
}

// ── Show formatting ───────────────────────────────────────────────

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

// ── Commands ──────────────────────────────────────────────────────

function cmdTree(): void {
  const db = openDbReadonly();
  const objectives = getTreeUnified(db);
  const tree = buildTree(objectives);

  if (isTTY) {
    printTree(tree);
  } else {
    console.log(JSON.stringify(treeToJson(tree), null, 2));
  }

  db.close();
}

function cmdShow(id: string): void {
  if (!id) {
    console.error('Usage: aria show <id>');
    process.exit(1);
  }

  const db = openDbReadonly();
  const obj = getObjectiveUnified(db, id);

  if (!obj) {
    console.error(`Objective not found: ${id}`);
    db.close();
    process.exit(1);
  }

  const children = getChildrenUnified(db, id);

  if (isTTY) {
    console.log(`ID:          ${obj.id}`);
    console.log(`Objective:   ${obj.objective}`);
    console.log(`Status:      ${obj.status}`);
    console.log(`Parent:      ${obj.parent ?? 'none'}`);
    console.log(`Children:    ${children.length}`);
    if (obj.description) {
      console.log(`Description: ${obj.description}`);
    }
    if (obj.work_path) {
      try {
        const workContent = fs.readFileSync(obj.work_path, "utf-8").trim();
        if (workContent) {
          console.log(`\nWork document:`);
          console.log(workContent);
        }
      } catch {}
    }
    if (obj.waiting_on) {
      console.log(`Waiting on:  ${obj.waiting_on}`);
    }
    console.log(`Created:     ${formatTimestamp(obj.created_at)}`);
    console.log(`Updated:     ${formatTimestamp(obj.updated_at)}`);
    if (obj.resolved_at) {
      console.log(`Resolved:    ${formatTimestamp(obj.resolved_at)}`);
    }
  } else {
    console.log(JSON.stringify({
      ...obj,
      children_count: children.length,
    }, null, 2));
  }

  db.close();
}

function cmdCreate(rawArgs: string[]): void {
  const { positional, flags } = parseFlags(rawArgs);

  const objectiveText = positional[0];
  const error = validateCreate(objectiveText);
  if (error) {
    console.error(error);
    process.exit(1);
  }

  // 3-arg form: aria spawn-child "obj" "desc" "msg"
  // 2-arg form: aria create "obj" "instructions" (backward compat: instructions → both description and inbox)
  const hasThreeArgs = positional.length >= 3;
  const description = positional[1] ?? null;
  const instructions = hasThreeArgs ? (positional[2] ?? null) : (positional[1] ?? null);
  const parentId = process.env.ARIA_OBJECTIVE_ID ?? 'root';
  const model = (flags['model'] as string) ?? 'sonnet';

  const db = openDb();

  // Verify parent exists
  const parent = getObjective(db, parentId);
  if (!parent) {
    console.error(`Parent objective not found: ${parentId}`);
    db.close();
    process.exit(1);
  }

  // Depth cap: only enforced when called by an agent (ARIA_OBJECTIVE_ID is set)
  if (process.env.ARIA_OBJECTIVE_ID) {
    const { allowed, autonomousDepth } = checkDepthCap(db, parentId);
    if (!allowed) {
      console.error(`Maximum autonomous depth reached (${autonomousDepth} >= ${getMaxAutonomousDepth()}). Report to your parent instead of decomposing further.`);
      db.close();
      process.exit(1);
    }

    const childCount = getActiveChildCount(db, parentId);
    const maxChildren = getMaxChildren();
    if (childCount >= maxChildren) {
      console.error(`Maximum children reached (${childCount} >= ${maxChildren}). Resolve, fail, or rethink existing children before creating more.`);
      db.close();
      process.exit(1);
    }
  }

  const newObj = createObjective(db, {
    objective: objectiveText,
    description: description ?? undefined,
    parent: parentId,
    model,
    machine: parent.machine ?? undefined,
  });

  if (instructions) {
    const cascadeId = process.env.ARIA_CASCADE_ID || undefined;
    insertMessage(db, {
      objective_id: newObj.id,
      message: instructions,
      sender: process.env.ARIA_OBJECTIVE_ID ?? 'system',
      type: 'message',
      cascade_id: cascadeId,
    });
  }

  if (isTTY) {
    const shortId = newObj.id.slice(0, 8);
    const parentName = parent.objective.length > 40
      ? parent.objective.slice(0, 40) + '...'
      : parent.objective;
    console.log(`Created: ${color.cyan(shortId)} "${objectiveText}" under ${color.dim(parentName)}`);
  } else {
    console.log(JSON.stringify({
      id: newObj.id,
      objective: newObj.objective,
      parent: newObj.parent,
      status: newObj.status,
    }, null, 2));
  }

  db.close();
}

function cmdSend(rawArgs: string[]): void {
  const id = rawArgs[0];
  const message = rawArgs[1];

  if (!id || !message) {
    console.error('Usage: aria send <id> "message"');
    process.exit(1);
  }

  const db = openDb();
  const obj = getObjective(db, id);

  if (!obj) {
    console.error(`Objective not found: ${id}`);
    db.close();
    process.exit(1);
  }

  const msg = insertMessage(db, {
    objective_id: id,
    message,
    sender: 'max',
    cascade_id: generateId(),
  });

  // Auto-resume stopped objectives when Max messages them
  if (obj.status === 'stopped') {
    updateStatus(db, id, 'idle');
  }

  if (isTTY) {
    const shortId = id.slice(0, 8);
    const name = obj.objective.length > 40
      ? obj.objective.slice(0, 40) + '...'
      : obj.objective;
    console.log(`Sent to ${color.cyan(shortId)} "${name}"`);
  } else {
    console.log(JSON.stringify(msg, null, 2));
  }

  db.close();
}

function cmdInbox(rawArgs: string[]): void {
  const { positional, flags } = parseFlags(rawArgs);
  const id = positional[0];

  if (!id) {
    console.error('Usage: aria inbox <id> [--limit <n>]');
    process.exit(1);
  }

  const limit = flags['limit'] ? parseInt(flags['limit'] as string, 10) : 50;

  const db = openDbReadonly();
  const obj = getObjectiveUnified(db, id);

  if (!obj) {
    console.error(`Objective not found: ${id}`);
    db.close();
    process.exit(1);
  }

  const messages = getConversationUnified(db, id).slice(0, limit);

  if (isTTY) {
    if (messages.length === 0) {
      console.log(color.dim('No messages.'));
    } else {
      for (const msg of messages) {
        const ts = formatTimestamp(msg.created_at);
        const tag = getSenderRelation(db, msg.sender, id);
        let senderLabel: string;
        switch (tag.relation) {
          case 'max':     senderLabel = color.cyan(`[${tag.label}]`); break;
          case 'parent':  senderLabel = color.magenta(`[${tag.label}]`); break;
          case 'child':   senderLabel = color.yellow(`[${tag.label}]`); break;
          case 'sibling': senderLabel = color.blue(`[${tag.label}]`); break;
          case 'system':  senderLabel = color.dim(`[${tag.label}]`); break;
          default:        senderLabel = `[${tag.label}]`; break;
        }
        const marker = msg.turn_id === null ? '• ' : '  ';
        console.log(`${marker}${senderLabel} ${color.dim(ts)}   ${msg.message}`);
      }
    }
  } else {
    console.log(JSON.stringify(messages, null, 2));
  }

  db.close();
}

function cmdSucceed(rawArgs: string[]): void {
  const targetId = rawArgs[0];
  const summary = rawArgs[1];
  const callerId = process.env.ARIA_OBJECTIVE_ID;

  const db = openDb();
  const error = validateSucceed(db, targetId, summary, callerId);
  if (error) {
    console.error(error);
    db.close();
    process.exit(1);
  }

  if (PROTECTED_IDS.has(targetId!)) {
    console.error(`Cannot resolve protected objective: ${targetId}`);
    db.close();
    process.exit(1);
  }

  const obj = getObjective(db, targetId!)!;

  // Count active children before cascade
  const children = getChildren(db, targetId!);
  const activeChildren = children.filter(c => ['idle', 'needs-input'].includes(c.status));

  updateStatus(db, targetId!, 'resolved');
  setResolutionSummary(db, targetId!, summary!);
  cascadeAbandon(db, targetId!);

  const cascadeId = process.env.ARIA_CASCADE_ID || undefined;
  insertMessage(db, {
    objective_id: targetId!,
    message: summary!,
    sender: 'system',
    type: 'reply',
    cascade_id: cascadeId,
  });

  // Notify parent
  const resultMsg = `[resolved] ${obj.objective}: ${summary}`;
  insertMessage(db, {
    objective_id: obj.parent!,
    message: resultMsg,
    sender: targetId!,
    type: 'reply',
    cascade_id: cascadeId,
  });

  if (isTTY) {
    const shortId = targetId!.slice(0, 8);
    console.log(`Resolved: ${color.green(shortId)} "${obj.objective}"`);
    if (activeChildren.length > 0) {
      console.log(color.dim(`  ${activeChildren.length} child(ren) abandoned`));
    }
  } else {
    console.log(JSON.stringify({
      id: targetId,
      status: 'resolved',
      abandoned_children: activeChildren.length,
    }, null, 2));
  }

  db.close();
}

function cmdFail(rawArgs: string[]): void {
  const targetId = rawArgs[0];
  const reason = rawArgs[1];
  const callerId = process.env.ARIA_OBJECTIVE_ID;

  const db = openDb();
  const error = validateFail(db, targetId, reason, callerId);
  if (error) {
    console.error(error);
    db.close();
    process.exit(1);
  }

  if (PROTECTED_IDS.has(targetId!)) {
    console.error(`Cannot fail protected objective: ${targetId}`);
    db.close();
    process.exit(1);
  }

  const obj = getObjective(db, targetId!)!;

  updateStatus(db, targetId!, 'failed');

  if (obj.parent) {
    const cascadeId = process.env.ARIA_CASCADE_ID || undefined;
    insertMessage(db, {
      objective_id: obj.parent,
      message: `[failed] ${obj.objective}: ${reason}`,
      sender: targetId!,
      type: 'reply',
      cascade_id: cascadeId,
    });
  }

  if (isTTY) {
    const shortId = targetId!.slice(0, 8);
    console.log(`Failed: ${color.red(shortId)} "${obj.objective}"`);
  } else {
    console.log(JSON.stringify({
      id: targetId,
      status: 'failed',
    }, null, 2));
  }

  db.close();
}

function cmdReject(rawArgs: string[]): void {
  const targetId = rawArgs[0];
  const feedback = rawArgs[1];
  const callerId = process.env.ARIA_OBJECTIVE_ID;

  const db = openDb();
  const error = validateReject(db, targetId, feedback, callerId);
  if (error) {
    console.error(error);
    db.close();
    process.exit(1);
  }

  const obj = getObjective(db, targetId!)!;

  updateStatus(db, targetId!, 'idle');
  clearWaitingOn(db, targetId!);

  const cascadeId = process.env.ARIA_CASCADE_ID || undefined;
  insertMessage(db, {
    objective_id: targetId!,
    message: feedback!,
    sender: callerId ?? 'max',
    type: 'message',
    cascade_id: cascadeId,
  });

  if (isTTY) {
    const shortId = targetId!.slice(0, 8);
    console.log(`Rejected: ${color.yellow(shortId)} "${obj.objective}" — sent feedback`);
  } else {
    console.log(JSON.stringify({
      id: targetId,
      status: 'idle',
    }, null, 2));
  }

  db.close();
}

function cmdWait(rawArgs: string[]): void {
  const { positional } = parseFlags(rawArgs);
  const reason = positional[0];
  const id = process.env.ARIA_OBJECTIVE_ID;

  const error = validateWait(reason, id);
  if (error) {
    console.error(error);
    process.exit(1);
  }

  const db = openDb();
  const obj = getObjective(db, id!);

  if (!obj) {
    console.error(`Objective not found: ${id}`);
    db.close();
    process.exit(1);
  }

  setWaitingOn(db, id!, reason!);
  updateStatus(db, id!, 'idle');

  if (isTTY) {
    const shortId = id!.slice(0, 8);
    console.log(`Waiting: ${color.yellow(shortId)} "${obj.objective}" — ${reason}`);
  } else {
    console.log(JSON.stringify({
      id,
      status: 'idle',
      waiting_on: reason,
    }, null, 2));
  }

  db.close();
}

function cmdTell(rawArgs: string[]): void {
  const targetId = rawArgs[0];
  const message = rawArgs[1];

  const db = openDb();
  const error = validateTell(db, targetId, message);
  if (error) {
    console.error(error);
    db.close();
    process.exit(1);
  }

  const senderId = process.env.ARIA_OBJECTIVE_ID ?? 'max';
  const obj = getObjective(db, targetId!)!;

  const cascadeId = process.env.ARIA_CASCADE_ID || undefined;
  const msg = insertMessage(db, {
    objective_id: targetId!,
    message: message!,
    sender: senderId,
    cascade_id: cascadeId,
  });

  if (isTTY) {
    const shortId = targetId!.slice(0, 8);
    const name = obj.objective.length > 40
      ? obj.objective.slice(0, 40) + '...'
      : obj.objective;
    console.log(`Told ${color.cyan(shortId)} "${name}"`);
  } else {
    console.log(JSON.stringify(msg, null, 2));
  }

  db.close();
}

function cmdNotify(rawArgs: string[]): void {
  const { positional, flags } = parseFlags(rawArgs);
  const message = positional[0];

  const error = validateNotify(message, flags);
  if (error) {
    console.error(error);
    process.exit(1);
  }

  const important = 'important' in flags;
  const urgent = 'urgent' in flags;

  const db = openDb();
  const objectiveId = process.env.ARIA_OBJECTIVE_ID;

  // Set the calling objective to needs-input with important/urgent flags.
  // This makes it show up in the "needs you" list on the surface.
  // No message to root — notify is a flag, not a conversation.
  if (objectiveId) {
    updateStatus(db, objectiveId, 'needs-input');
    db.prepare('UPDATE objectives SET important = ?, urgent = ? WHERE id = ?')
      .run(important ? 1 : 0, urgent ? 1 : 0, objectiveId);
  }

  // Always print to stdout (this is a notification)
  const markers = [
    urgent ? 'URGENT' : '',
    important ? 'IMPORTANT' : '',
  ].filter(Boolean).join(' ');
  const prefix = markers ? `[NOTIFY ${markers}]` : '[NOTIFY]';
  console.log(`${prefix} ${message}`);

  if (!isTTY) {
    console.log(JSON.stringify({ message, important, urgent }, null, 2));
  }

  // Check deep work state — suppress non-urgent notifications when Max is focused
  const deepWork = isDeepWork(db);
  if (deepWork && !urgent) {
    console.log('[NOTIFY] Suppressed (deep work detected, non-urgent)');
    db.close();
    return;
  }

  // Fire-and-forget macOS notification via terminal-notifier
  const titleMarkers = [
    urgent && important ? '[!!]' : '',
    !urgent && important ? '[!]' : '',
    urgent && !important ? '[!]' : '',
  ].filter(Boolean).join('');
  const notifTitle = titleMarkers ? `ARIA ${titleMarkers}` : 'ARIA';
  const notifArgs = ['-title', notifTitle, '-message', message!, '-open', 'http://localhost:8080'];
  try {
    const child = execFile('terminal-notifier', notifArgs, () => {});
    child.unref();
  } catch {
    // terminal-notifier not available — silently ignore
  }

  // Web push notification — fire-and-forget alongside terminal-notifier
  try {
    initPush(db);
    sendPushToAll(db, { message: message!, sender: process.env.ARIA_OBJECTIVE_ID, important, urgent });
  } catch {
    // push not available
  }

  db.close();
}

function cmdFind(rawArgs: string[]): void {
  const query = rawArgs[0];

  if (!query) {
    console.error('Usage: aria find "query"');
    process.exit(1);
  }

  const db = openDbReadonly();
  const results = searchObjectives(db, query);

  if (results.length === 0) {
    console.log('No objectives found.');
    db.close();
    return;
  }

  if (isTTY) {
    for (const obj of results) {
      const shortId = obj.id.slice(0, 8);
      const name = obj.objective.length > 50
        ? obj.objective.slice(0, 50) + '...'
        : obj.objective;
      console.log(`${color.cyan(shortId)}  "${name}"  ${colorStatus(obj.status)}`);
    }
  } else {
    console.log(JSON.stringify(results.map(obj => ({
      id: obj.id,
      objective: obj.objective,
      status: obj.status,
      parent: obj.parent,
    })), null, 2));
  }

  db.close();
}

function cmdContext(rawArgs: string[]): void {
  const { positional, flags } = parseFlags(rawArgs);
  const objectiveId = positional[0] ?? null;

  if (objectiveId) {
    // Objective-specific context
    const db = openDbReadonly();
    const obj = getObjective(db, objectiveId);
    if (!obj) {
      console.error(`Objective not found: ${objectiveId}`);
      db.close();
      process.exit(1);
    }

    const config = loadConfig();
    const bricks = [personaBrick, ariaBrick, environmentBrick, objectiveBrick, parentsBrick, siblingsBrick, childrenBrick, similarBrick, conversationBrick, neverBrick, focusBrick];
    const result = assembleContext(bricks, { db, objectiveId, config: config as unknown as Record<string, unknown> });
    const content = result.content;

    if (flags['tui']) {

      if (!isTTY) {
        console.error('TUI requires a terminal. Use --dump for non-interactive output.');
        db.close();
        process.exit(1);
      }

      launchTUI(result, bricks, config);
      db.close();
      return;
    }

    // Default and --dump: print full assembled context
    const budget = MODELS.sonnet.contextWindow;
    const tokens = Math.ceil(content.length / 4); // rough estimate
    console.log(color.dim('─'.repeat(60)));
    console.log(color.cyan(`Context Assembly for ${objectiveId.slice(0, 8)} "${obj.objective}"`));
    console.log(color.dim('─'.repeat(60)));
    console.log(`  ${'~tokens'.padEnd(14)} ${String(tokens).padStart(6)} tok  ${((tokens / budget) * 100).toFixed(1).padStart(5)}%  of ${budget.toLocaleString()} budget`);
    console.log(color.dim('─'.repeat(60)));
    console.log('');
    console.log(content);

    db.close();
    return;
  }

  // No objective_id: context window allocation view
  const config = loadConfig();
  const bricks = [personaBrick, ariaBrick, environmentBrick, similarBrick];
  const result = assembleContext(bricks, { config: config as unknown as Record<string, unknown> });

  // Add placeholder entries for db-dependent bricks showing their configured caps
  const rawBricks = (config as unknown as Record<string, unknown>).bricks as Record<string, Record<string, unknown>>;

  const placeholders: Array<{ name: string; type: 'tree' | 'matched' | 'flex'; configKey: string }> = [
    { name: 'Objective', type: 'tree', configKey: 'objective' },
    { name: 'Parents', type: 'tree', configKey: 'parents' },
    { name: 'Siblings', type: 'tree', configKey: 'siblings' },
    { name: 'Children', type: 'tree', configKey: 'children' },
    { name: 'Similar', type: 'matched', configKey: 'similar_resolved' },
    { name: 'Skills', type: 'matched', configKey: 'skills' },
    { name: 'Memories', type: 'matched', configKey: 'memories' },
    { name: 'Conversation', type: 'flex', configKey: 'conversation' },
  ];

  const existingNames = new Set(result.sections.map(s => s.name.toLowerCase()));

  for (const ph of placeholders) {
    if (existingNames.has(ph.name.toLowerCase())) continue; // already rendered
    const brickConfig = rawBricks?.[ph.configKey] as Record<string, number> | undefined;
    const rawMax = brickConfig?.max_tokens;
    const maxTokens = typeof rawMax === 'object' && rawMax !== null
      ? (rawMax as Record<string, number>).sonnet ?? Object.values(rawMax as Record<string, number>)[0] ?? 0
      : (rawMax as number) ?? brickConfig?.per_message_max ?? 0;

    result.sections.push({
      name: ph.name,
      type: ph.type,
      content: `[Placeholder — requires objective context]\nConfigured cap: ${maxTokens.toLocaleString()} tokens`,
      tokens: maxTokens,
      meta: {
        config: brickConfig as Record<string, number> | undefined,
      },
    });
    result.totalTokens += maxTokens;
  }

  // Focus brick placeholder (closing section)
  if (!existingNames.has('focus')) {
    result.sections.push({
      name: 'Focus',
      type: 'static',
      content: '[Placeholder — restates objective + two questions at end of context]\nConfigured: ~100 tokens (fixed)',
      tokens: 100,
    });
    result.totalTokens += 100;
  }

  const budget = MODELS.sonnet.contextWindow;

  if (flags['dump']) {
    // Non-interactive dump to stdout
    console.log(color.dim('─'.repeat(60)));
    console.log(color.cyan('Context Window Allocation (all brick slots)'));
    console.log(color.dim('─'.repeat(60)));

    for (const section of result.sections) {
      const pct = ((section.tokens / budget) * 100).toFixed(1);
      const bar = '█'.repeat(Math.max(1, Math.round(section.tokens / budget * 40)));
      console.log(`  ${section.name.padEnd(14)} ${String(section.tokens).padStart(6)} tok  ${pct.padStart(5)}%  ${color.green(bar)}`);
    }

    console.log(color.dim('─'.repeat(60)));
    console.log(`  ${'TOTAL'.padEnd(14)} ${String(result.totalTokens).padStart(6)} tok  ${((result.totalTokens / budget) * 100).toFixed(1).padStart(5)}%  of ${budget.toLocaleString()} budget`);
    console.log(color.dim('─'.repeat(60)));
    console.log('');
    console.log(result.content);
    return;
  }

  // Interactive TUI
  if (!isTTY) {
    console.error('TUI requires a terminal. Use --dump for non-interactive output.');
    process.exit(1);
  }

  launchTUI(result, bricks, config);
}

function cmdSchedule(rawArgs: string[]): void {
  const { positional, flags } = parseFlags(rawArgs);
  const objectiveId = positional[0];
  const message = positional[1];
  const intervalStr = flags['interval'] as string | undefined;

  if (!objectiveId || !message) {
    console.error('Usage: aria schedule <objective_id> "message" --interval <interval>');
    process.exit(1);
  }

  const db = openDb();
  const obj = getObjective(db, objectiveId);
  if (!obj) {
    console.error(`Objective not found: ${objectiveId}`);
    db.close();
    process.exit(1);
  }

  let intervalSeconds: number | null = null;
  if (intervalStr) {
    intervalSeconds = parseInterval(intervalStr);
    if (intervalSeconds === null) {
      console.error(`Invalid interval format: ${intervalStr}. Use: 5s, 1m, 1h, 1d`);
      db.close();
      process.exit(1);
    }
  }

  const nextAt = Math.floor(Date.now() / 1000) + (intervalSeconds ?? 0);
  const schedule = createSchedule(db, objectiveId, message, intervalStr ?? null, nextAt);

  if (isTTY) {
    const shortId = schedule.id.slice(0, 8);
    const objShort = objectiveId.slice(0, 8);
    const intervalLabel = intervalStr ? ` every ${intervalStr}` : ' (one-time)';
    console.log(`Scheduled: ${color.cyan(shortId)} → ${color.dim(objShort)}${intervalLabel} "${message}"`);
  } else {
    console.log(JSON.stringify(schedule, null, 2));
  }

  db.close();
}

function cmdSchedules(rawArgs: string[]): void {
  const objectiveId = rawArgs[0] || undefined;

  const db = openDbReadonly();

  if (objectiveId) {
    const obj = getObjective(db, objectiveId);
    if (!obj) {
      console.error(`Objective not found: ${objectiveId}`);
      db.close();
      process.exit(1);
    }
  }

  const schedules = listSchedules(db, objectiveId);

  if (isTTY) {
    if (schedules.length === 0) {
      console.log(color.dim('No active schedules.'));
    } else {
      for (const s of schedules) {
        const shortId = s.id.slice(0, 8);
        const objShort = s.objective_id.slice(0, 8);
        const nextAtStr = formatTimestamp(s.next_at);
        const intervalLabel = s.interval ? ` every ${s.interval}` : ' (one-time)';
        console.log(`${color.cyan(shortId)} → ${color.dim(objShort)}${intervalLabel}  next: ${nextAtStr}  "${s.message}"`);
      }
    }
  } else {
    console.log(JSON.stringify(schedules, null, 2));
  }

  db.close();
}

function cmdReportToParent(rawArgs: string[]): void {
  const message = rawArgs[0];
  const id = process.env.ARIA_OBJECTIVE_ID;

  if (!id) {
    console.error('report-to-parent requires ARIA_OBJECTIVE_ID');
    process.exit(1);
  }
  if (!message) {
    console.error('Usage: aria report-to-parent "message"');
    process.exit(1);
  }

  const db = openDb();
  const obj = getObjective(db, id);
  if (!obj) {
    console.error(`Objective not found: ${id}`);
    db.close();
    process.exit(1);
  }
  if (!obj.parent) {
    console.error('This objective has no parent');
    db.close();
    process.exit(1);
  }

  const cascadeId = process.env.ARIA_CASCADE_ID || undefined;
  insertMessage(db, {
    objective_id: obj.parent,
    message,
    sender: id,
    cascade_id: cascadeId,
  });

  if (isTTY) {
    const shortId = obj.parent.slice(0, 8);
    console.log(`Reported to parent ${color.cyan(shortId)}`);
  } else {
    console.log(JSON.stringify({ parent: obj.parent, message }, null, 2));
  }

  db.close();
}

function cmdResolveChild(rawArgs: string[]): void {
  const id = rawArgs[0];
  const action = rawArgs[1]; // 'succeed' or 'fail'
  const text = rawArgs[2];   // summary or reason

  if (!id || !action || !text) {
    console.error('Usage: aria resolve-child <id> succeed "summary"  OR  aria resolve-child <id> fail "reason"');
    process.exit(1);
  }

  if (action === 'succeed') {
    cmdSucceed([id, text]);
  } else if (action === 'fail') {
    cmdFail([id, text]);
  } else {
    console.error(`Unknown action: ${action}. Use "succeed" or "fail".`);
    process.exit(1);
  }
}

// ── Monitoring & Debug Commands ───────────────────────────────────

function trunc(s: string | null | undefined, len: number): string {
  if (!s) return '';
  return s.length > len ? s.slice(0, len) + '...' : s;
}

function cmdActive(): void {
  const db = openDbReadonly();
  const rows = withPeer(db, (hasPeer) => {
    const local = `SELECT id, objective, machine, model, datetime(updated_at/1000,'unixepoch','localtime') as updated FROM objectives WHERE status = 'thinking'`;
    if (!hasPeer) return db.prepare(local).all();
    const peer = `SELECT id, objective, machine, model, datetime(updated_at/1000,'unixepoch','localtime') as updated FROM peer.objectives WHERE status = 'thinking' AND id NOT IN (SELECT id FROM objectives WHERE status = 'thinking')`;
    return db.prepare(`${local} UNION ALL ${peer}`).all();
  }) as any[];

  if (!isTTY) { console.log(JSON.stringify(rows, null, 2)); db.close(); return; }
  if (rows.length === 0) { console.log(color.dim('No active (thinking) objectives.')); db.close(); return; }
  for (const r of rows) {
    console.log(`${color.cyan(r.id.slice(0, 8))}  ${trunc(r.objective, 50)}  ${color.yellow('[thinking]')}  ${color.dim(r.machine ?? '?')}  ${color.dim(r.model ?? '')}  ${color.dim(r.updated)}`);
  }
  db.close();
}

function cmdAlive(): void {
  const db = openDbReadonly();
  const rows = withPeer(db, (hasPeer) => {
    const local = `SELECT * FROM objectives WHERE status NOT IN ('resolved','failed','abandoned')`;
    if (!hasPeer) return db.prepare(`${local} ORDER BY updated_at DESC LIMIT 20`).all();
    const peer = `SELECT * FROM peer.objectives WHERE status NOT IN ('resolved','failed','abandoned') AND id NOT IN (SELECT id FROM objectives)`;
    return db.prepare(`SELECT * FROM (${local} UNION ALL ${peer}) ORDER BY updated_at DESC LIMIT 20`).all();
  }) as Objective[];

  if (!isTTY) { console.log(JSON.stringify(rows.map(r => ({ id: r.id, objective: r.objective, status: r.status, machine: r.machine, waiting_on: r.waiting_on })), null, 2)); db.close(); return; }
  if (rows.length === 0) { console.log(color.dim('No alive objectives.')); db.close(); return; }
  for (const r of rows) {
    console.log(`${color.cyan(r.id.slice(0, 8))}  ${trunc(r.objective, 50)}  ${colorStatus(r.status)}  ${color.dim(r.machine ?? '')}  ${r.waiting_on ? color.magenta(trunc(r.waiting_on, 50)) : ''}`);
  }
  db.close();
}

function cmdRecent(): void {
  const db = openDbReadonly();
  const rows = withPeer(db, (hasPeer) => {
    const local = `SELECT id, objective, status, datetime(updated_at/1000,'unixepoch','localtime') as updated, updated_at FROM objectives`;
    if (!hasPeer) return db.prepare(`${local} ORDER BY updated_at DESC LIMIT 15`).all();
    const peer = `SELECT id, objective, status, datetime(updated_at/1000,'unixepoch','localtime') as updated, updated_at FROM peer.objectives WHERE id NOT IN (SELECT id FROM objectives)`;
    return db.prepare(`SELECT * FROM (${local} UNION ALL ${peer}) ORDER BY updated_at DESC LIMIT 15`).all();
  }) as any[];

  if (!isTTY) { console.log(JSON.stringify(rows, null, 2)); db.close(); return; }
  if (rows.length === 0) { console.log(color.dim('No objectives.')); db.close(); return; }
  for (const r of rows) {
    console.log(`${color.cyan(r.id.slice(0, 8))}  ${trunc(r.objective, 50)}  ${colorStatus(r.status)}  ${color.dim(r.updated)}`);
  }
  db.close();
}

function cmdUnprocessed(): void {
  const db = openDbReadonly();
  const rows = withPeer(db, (hasPeer) => {
    const local = `SELECT i.objective_id, i.sender, i.type, i.message, datetime(i.created_at/1000,'unixepoch','localtime') as created FROM inbox i WHERE i.turn_id IS NULL ORDER BY i.created_at DESC LIMIT 20`;
    if (!hasPeer) return db.prepare(local).all();
    const localAll = `SELECT i.objective_id, i.sender, i.type, i.message, datetime(i.created_at/1000,'unixepoch','localtime') as created, i.created_at as sort_ts FROM inbox i WHERE i.turn_id IS NULL`;
    const peerAll = `SELECT i.objective_id, i.sender, i.type, i.message, datetime(i.created_at/1000,'unixepoch','localtime') as created, i.created_at as sort_ts FROM peer.inbox i WHERE i.turn_id IS NULL AND i.id NOT IN (SELECT id FROM inbox)`;
    return db.prepare(`SELECT objective_id, sender, type, message, created FROM (${localAll} UNION ALL ${peerAll}) ORDER BY sort_ts DESC LIMIT 20`).all();
  }) as any[];

  if (!isTTY) { console.log(JSON.stringify(rows, null, 2)); db.close(); return; }
  if (rows.length === 0) { console.log(color.dim('No unprocessed messages.')); db.close(); return; }
  for (const r of rows) {
    console.log(`${color.cyan((r.objective_id ?? '').slice(0, 8))}  ${color.yellow(r.sender)}  ${color.dim(r.type)}  ${trunc(r.message, 60)}  ${color.dim(r.created)}`);
  }
  db.close();
}

function cmdStuck(): void {
  const db = openDbReadonly();
  const rows = withPeer(db, (hasPeer) => {
    const local = `SELECT id, objective, status, fail_count, last_error, updated_at, datetime(updated_at/1000,'unixepoch','localtime') as updated FROM objectives
      WHERE status NOT IN ('resolved','failed','abandoned')
        AND (fail_count > 0 OR (status = 'idle' AND updated_at < (strftime('%s','now') - 86400) * 1000))`;
    if (!hasPeer) return db.prepare(`${local} ORDER BY fail_count DESC, updated_at ASC`).all();
    const peer = `SELECT id, objective, status, fail_count, last_error, updated_at, datetime(updated_at/1000,'unixepoch','localtime') as updated FROM peer.objectives
      WHERE status NOT IN ('resolved','failed','abandoned')
        AND (fail_count > 0 OR (status = 'idle' AND updated_at < (strftime('%s','now') - 86400) * 1000))
        AND id NOT IN (SELECT id FROM objectives)`;
    return db.prepare(`SELECT id, objective, status, fail_count, last_error, updated FROM (${local} UNION ALL ${peer}) ORDER BY fail_count DESC, updated_at ASC`).all();
  }) as any[];

  if (!isTTY) { console.log(JSON.stringify(rows, null, 2)); db.close(); return; }
  if (rows.length === 0) { console.log(color.dim('No stuck objectives.')); db.close(); return; }
  for (const r of rows) {
    console.log(`${color.cyan(r.id.slice(0, 8))}  ${trunc(r.objective, 50)}  ${colorStatus(r.status)}  ${r.fail_count > 0 ? color.red(`fails:${r.fail_count}`) : ''}  ${r.last_error ? color.red(trunc(r.last_error, 60)) : ''}`);
  }
  db.close();
}

function cmdErrors(): void {
  const db = openDbReadonly();
  const rows = withPeer(db, (hasPeer) => {
    const sql = `SELECT id, objective, status, fail_count, last_error FROM objectives WHERE last_error IS NOT NULL OR fail_count > 0 ORDER BY updated_at DESC LIMIT 15`;
    if (!hasPeer) return db.prepare(sql).all();
    const localSql = `SELECT id, objective, status, fail_count, last_error, updated_at FROM objectives WHERE last_error IS NOT NULL OR fail_count > 0`;
    const peerSql = `SELECT id, objective, status, fail_count, last_error, updated_at FROM peer.objectives WHERE (last_error IS NOT NULL OR fail_count > 0) AND id NOT IN (SELECT id FROM objectives)`;
    return db.prepare(`SELECT id, objective, status, fail_count, last_error FROM (${localSql} UNION ALL ${peerSql}) ORDER BY updated_at DESC LIMIT 15`).all();
  }) as any[];

  if (!isTTY) { console.log(JSON.stringify(rows, null, 2)); db.close(); return; }
  if (rows.length === 0) { console.log(color.dim('No errors.')); db.close(); return; }
  for (const r of rows) {
    console.log(`${color.cyan(r.id.slice(0, 8))}  ${trunc(r.objective, 40)}  ${colorStatus(r.status)}  ${r.fail_count > 0 ? color.red(`fails:${r.fail_count}`) : ''}  ${r.last_error ? color.red(trunc(r.last_error, 80)) : ''}`);
  }
  db.close();
}

function cmdWaiting(): void {
  const db = openDbReadonly();
  const rows = withPeer(db, (hasPeer) => {
    const local = `SELECT id, objective, waiting_on, updated_at FROM objectives WHERE waiting_on IS NOT NULL AND waiting_on != '' AND status NOT IN ('resolved','failed','abandoned')`;
    if (!hasPeer) return db.prepare(`${local} ORDER BY updated_at DESC`).all();
    const peer = `SELECT id, objective, waiting_on, updated_at FROM peer.objectives WHERE waiting_on IS NOT NULL AND waiting_on != '' AND status NOT IN ('resolved','failed','abandoned') AND id NOT IN (SELECT id FROM objectives)`;
    return db.prepare(`SELECT id, objective, waiting_on FROM (${local} UNION ALL ${peer}) ORDER BY updated_at DESC`).all();
  }) as any[];

  if (!isTTY) { console.log(JSON.stringify(rows, null, 2)); db.close(); return; }
  if (rows.length === 0) { console.log(color.dim('No waiting objectives.')); db.close(); return; }
  for (const r of rows) {
    console.log(`${color.cyan(r.id.slice(0, 8))}  ${trunc(r.objective, 40)}  ${color.magenta(trunc(r.waiting_on, 80))}`);
  }
  db.close();
}

function cmdCascade(rawArgs: string[]): void {
  const cascadeId = rawArgs[0];
  const db = openDbReadonly();

  if (!cascadeId) {
    // List recent cascade IDs
    const rows = withPeer(db, (hasPeer) => {
      const localSql = `SELECT DISTINCT cascade_id, datetime(created_at/1000,'unixepoch','localtime') as started, created_at FROM inbox WHERE cascade_id IS NOT NULL`;
      if (!hasPeer) return db.prepare(`SELECT cascade_id, started FROM (${localSql}) ORDER BY created_at DESC LIMIT 10`).all();
      const peerSql = `SELECT DISTINCT cascade_id, datetime(created_at/1000,'unixepoch','localtime') as started, created_at FROM peer.inbox WHERE cascade_id IS NOT NULL`;
      return db.prepare(`SELECT cascade_id, MAX(started) as started FROM (${localSql} UNION ALL ${peerSql}) GROUP BY cascade_id ORDER BY MAX(created_at) DESC LIMIT 10`).all();
    }) as any[];

    if (!isTTY) { console.log(JSON.stringify(rows, null, 2)); db.close(); return; }
    if (rows.length === 0) { console.log(color.dim('No cascades found.')); db.close(); return; }
    console.log(color.dim('Recent cascades:'));
    for (const r of rows) {
      console.log(`  ${color.cyan(r.cascade_id)}  ${color.dim(r.started)}`);
    }
    db.close();
    return;
  }

  const rows = withPeer(db, (hasPeer) => {
    const localSql = `SELECT objective_id, sender, type, message, datetime(created_at/1000,'unixepoch','localtime') as ts, created_at as sort_ts FROM inbox WHERE cascade_id = ?`;
    if (!hasPeer) return db.prepare(`SELECT objective_id, sender, type, message, ts FROM (${localSql}) ORDER BY sort_ts`).all(cascadeId);
    const peerSql = `SELECT objective_id, sender, type, message, datetime(created_at/1000,'unixepoch','localtime') as ts, created_at as sort_ts FROM peer.inbox WHERE cascade_id = ? AND id NOT IN (SELECT id FROM inbox WHERE cascade_id = ?)`;
    return db.prepare(`SELECT objective_id, sender, type, message, ts FROM (${localSql} UNION ALL ${peerSql}) ORDER BY sort_ts`).all(cascadeId, cascadeId, cascadeId);
  }) as any[];

  if (!isTTY) { console.log(JSON.stringify(rows, null, 2)); db.close(); return; }
  if (rows.length === 0) { console.log(color.dim('No messages in this cascade.')); db.close(); return; }
  for (const r of rows) {
    console.log(`${color.cyan((r.objective_id ?? '').slice(0, 8))}  ${color.yellow(r.sender)}  ${color.dim(r.type)}  ${trunc(r.message, 60)}  ${color.dim(r.ts)}`);
  }
  db.close();
}

function cmdStats(): void {
  const db = openDbReadonly();
  const statusCounts = withPeer(db, (hasPeer) => {
    if (!hasPeer) return db.prepare(`SELECT status, count(*) as count FROM objectives GROUP BY status ORDER BY count DESC`).all();
    // Deduplicated count
    return db.prepare(`SELECT status, count(*) as count FROM (
      SELECT id, status FROM objectives
      UNION ALL
      SELECT id, status FROM peer.objectives WHERE id NOT IN (SELECT id FROM objectives)
    ) GROUP BY status ORDER BY count DESC`).all();
  }) as any[];

  const turnCount = withPeer(db, (hasPeer) => {
    if (!hasPeer) return (db.prepare(`SELECT count(*) as count FROM turns`).get() as any).count;
    return (db.prepare(`SELECT count(*) as count FROM (
      SELECT id FROM turns UNION ALL SELECT id FROM peer.turns WHERE id NOT IN (SELECT id FROM turns)
    )`).get() as any).count;
  }) as number;

  const inboxCount = withPeer(db, (hasPeer) => {
    if (!hasPeer) return (db.prepare(`SELECT count(*) as count FROM inbox`).get() as any).count;
    return (db.prepare(`SELECT count(*) as count FROM (
      SELECT id FROM inbox UNION ALL SELECT id FROM peer.inbox WHERE id NOT IN (SELECT id FROM inbox)
    )`).get() as any).count;
  }) as number;

  if (!isTTY) { console.log(JSON.stringify({ statuses: statusCounts, turns: turnCount, inbox_messages: inboxCount }, null, 2)); db.close(); return; }
  console.log(color.cyan('Objectives by status:'));
  for (const r of statusCounts) {
    console.log(`  ${colorStatus(r.status)}  ${r.count}`);
  }
  console.log(`\n  Turns:          ${turnCount}`);
  console.log(`  Inbox messages: ${inboxCount}`);
  db.close();
}

function cmdToday(): void {
  const db = openDbReadonly();
  const rows = withPeer(db, (hasPeer) => {
    const sql = `SELECT id, objective, status, datetime(updated_at/1000,'unixepoch','localtime') as updated, updated_at FROM objectives WHERE date(updated_at/1000,'unixepoch','localtime') = date('now','localtime')`;
    if (!hasPeer) return db.prepare(`${sql} ORDER BY updated_at DESC`).all();
    const peerSql = `SELECT id, objective, status, datetime(updated_at/1000,'unixepoch','localtime') as updated, updated_at FROM peer.objectives WHERE date(updated_at/1000,'unixepoch','localtime') = date('now','localtime') AND id NOT IN (SELECT id FROM objectives)`;
    return db.prepare(`SELECT * FROM (${sql} UNION ALL ${peerSql}) ORDER BY updated_at DESC`).all();
  }) as any[];

  if (!isTTY) { console.log(JSON.stringify(rows, null, 2)); db.close(); return; }
  if (rows.length === 0) { console.log(color.dim('No objectives updated today.')); db.close(); return; }
  for (const r of rows) {
    console.log(`${color.cyan(r.id.slice(0, 8))}  ${trunc(r.objective, 50)}  ${colorStatus(r.status)}  ${color.dim(r.updated)}`);
  }
  db.close();
}

function cmdChildren(id: string): void {
  if (!id) {
    console.error('Usage: aria children <id>');
    process.exit(1);
  }
  const db = openDbReadonly();
  const children = getChildrenUnified(db, id);

  if (!isTTY) { console.log(JSON.stringify(children.map(c => ({ id: c.id, objective: c.objective, status: c.status, model: c.model, updated_at: c.updated_at })), null, 2)); db.close(); return; }
  if (children.length === 0) { console.log(color.dim('No children.')); db.close(); return; }
  for (const c of children) {
    console.log(`${color.cyan(c.id.slice(0, 8))}  ${trunc(c.objective, 50)}  ${colorStatus(c.status)}  ${color.dim(c.model ?? '')}  ${color.dim(formatTimestamp(c.updated_at))}`);
  }
  db.close();
}

function cmdHistory(id: string): void {
  if (!id) {
    console.error('Usage: aria history <id>');
    process.exit(1);
  }
  const db = openDbReadonly();
  const rows = withPeer(db, (hasPeer) => {
    const sql = `SELECT turn_number, session_id, cascade_id, datetime(created_at/1000,'unixepoch','localtime') as ts FROM turns WHERE objective_id = ? ORDER BY turn_number`;
    if (!hasPeer) return db.prepare(sql).all(id);
    const peerSql = `SELECT turn_number, session_id, cascade_id, datetime(created_at/1000,'unixepoch','localtime') as ts FROM peer.turns WHERE objective_id = ? AND id NOT IN (SELECT id FROM turns WHERE objective_id = ?) ORDER BY turn_number`;
    return db.prepare(`SELECT * FROM (${sql} UNION ALL ${peerSql}) ORDER BY turn_number`).all(id, id, id);
  }) as any[];

  if (!isTTY) { console.log(JSON.stringify(rows, null, 2)); db.close(); return; }
  if (rows.length === 0) { console.log(color.dim('No turns.')); db.close(); return; }
  for (const r of rows) {
    console.log(`  #${String(r.turn_number).padStart(3)}  session:${(r.session_id ?? '-').slice(0, 8)}  cascade:${(r.cascade_id ?? '-').slice(0, 8)}  ${color.dim(r.ts)}`);
  }
  db.close();
}

// ── Dispatch ──────────────────────────────────────────────────────

const command = process.argv[2];
const args = process.argv.slice(3);

// ── Dispatch ──────────────────────────────────────────────────────

switch (command) {
  case undefined:
  case '--help':
  case '-h':
  case 'help':
    console.log(HELP);
    break;

  case 'tree':
    cmdTree();
    break;

  case 'show':
    cmdShow(args[0]);
    break;

  case 'create':
    cmdCreate(args);
    break;

  case 'spawn-child':
    cmdCreate(args);
    break;

  case 'send':
    cmdSend(args);
    break;

  case 'inbox':
    cmdInbox(args);
    break;

  case 'succeed':
    cmdSucceed(args);
    break;

  case 'fail':
    cmdFail(args);
    break;

  case 'reject':
    cmdReject(args);
    break;

  case 'wait':
    cmdWait(args);
    break;

  case 'tell':
    cmdTell(args);
    break;

  case 'notify':
    cmdNotify(args);
    break;

  case 'notify-max':
    cmdNotify(args);
    break;

  case 'report-to-parent':
    cmdReportToParent(args);
    break;

  case 'resolve-child':
    cmdResolveChild(args);
    break;

  case 'talk-to-child':
    cmdReject(args);
    break;

  case 'talk':
    cmdTell(args);
    break;

  case 'schedule':
    cmdSchedule(args);
    break;

  case 'schedules':
    cmdSchedules(args);
    break;

  case 'find':
    cmdFind(args);
    break;

  case 'context':
    cmdContext(args);
    break;

  case 'sim': {
    const { runSim } = await import('../sim.js');
    await runSim(args);
    break;
  }

  case 'dev': {
    const selfScript = decodeURIComponent(new URL(import.meta.url).pathname);
    const surfaceDir = decodeURIComponent(new URL('../../../surface', import.meta.url).pathname);

    console.log(color.cyan('[dev]') + ' Starting engine + surface...');

    const engineProc = spawn(process.execPath, [selfScript, 'engine'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const viteBin = decodeURIComponent(new URL('../../../surface/node_modules/.bin/vite', import.meta.url).pathname);
    const surfaceProc = spawn(viteBin, ['--port', '5173'], {
      cwd: surfaceDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    engineProc.stdout?.on('data', (data: Buffer) => {
      process.stdout.write(data);
    });
    engineProc.stderr?.on('data', (data: Buffer) => {
      process.stderr.write(data);
    });

    surfaceProc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) process.stdout.write(color.magenta('[surface] ') + line + '\n');
      }
    });
    surfaceProc.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) process.stderr.write(color.magenta('[surface] ') + line + '\n');
      }
    });

    const cleanup = () => {
      console.log('\n[dev] Shutting down...');
      engineProc.kill('SIGINT');
      surfaceProc.kill('SIGINT');
      setTimeout(() => process.exit(0), 2000);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    engineProc.on('exit', (code) => {
      console.log(`[dev] Engine exited (${code})`);
    });
    surfaceProc.on('exit', (code) => {
      console.log(`[dev] Surface exited (${code})`);
    });

    break;
  }

  case 'build': {
    const { execSync } = await import('child_process');
    const engineDir = decodeURIComponent(new URL('../../', import.meta.url).pathname);
    console.log('Building engine...');
    execSync('npm run build', { cwd: engineDir, stdio: 'inherit' });
    console.log('Done.');
    break;
  }

  case 'up':
  case 'engine': {
    const engineDb = openDb();
    migrateDb(engineDb);
    const nudge = startEngine(engineDb);
    startEmbedDaemon();
    const surfaceDist = isWorker() ? null : decodeURIComponent(new URL('../../../surface/dist', import.meta.url).pathname);
    const server = startServer(engineDb, surfaceDist, undefined, nudge);
    process.on('SIGINT', () => {
      console.log('\n[engine] Shutting down...');
      server.close();
      engineDb.close();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      console.log('\n[engine] Shutting down...');
      server.close();
      engineDb.close();
      process.exit(0);
    });
    break;
  }

  case 'active':
    cmdActive();
    break;

  case 'alive':
    cmdAlive();
    break;

  case 'recent':
    cmdRecent();
    break;

  case 'unprocessed':
    cmdUnprocessed();
    break;

  case 'stuck':
    cmdStuck();
    break;

  case 'errors':
    cmdErrors();
    break;

  case 'waiting':
    cmdWaiting();
    break;

  case 'cascade':
    cmdCascade(args);
    break;

  case 'stats':
    cmdStats();
    break;

  case 'today':
    cmdToday();
    break;

  case 'children':
    cmdChildren(args[0]);
    break;

  case 'history':
    cmdHistory(args[0]);
    break;

  default:
    console.error(`Unknown command: ${command}`);
    console.log(HELP);
    process.exit(1);
}
