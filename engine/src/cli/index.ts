#!/usr/bin/env node

import { initDb } from '../db/schema.js';
import { getTree, getObjective, getChildren, createObjective, insertMessage, getConversation, updateStatus, cascadeAbandon, setWaitingOn, clearWaitingOn, setResolutionSummary, searchObjectives, getSenderRelation, createSchedule, listSchedules, getTreeUnified, getObjectiveUnified, getConversationUnified, getChildrenUnified } from '../db/queries.js';
import { startEngine } from '../engine/loop.js';
import { startServer } from '../server/index.js';
import { isDeepWork } from '../engine/concurrency.js';
import { validateCreate, validateSucceed, validateFail, validateReject, validateWait, validateTell, validateNotify } from '../commands/registry.js';
import type { Objective, InboxMessage } from '../db/queries.js';
import { parseInterval } from './parse-interval.js';
import { execFile } from 'child_process';
import { assembleContext } from '../context/assembler.js';
import { assembleContextV2 } from '../context/assembler-v2.js';
import personaBrick from '../context/bricks/persona/index.js';
import contractBrick from '../context/bricks/contract/index.js';
import environmentBrick from '../context/bricks/environment/index.js';
import similarBrick from '../context/bricks/similar/index.js';
import treeBrick from '../context/bricks/tree/index.js';
import conversationBrick from '../context/bricks/conversation/index.js';
import { launchTUI } from '../context/tui/index.js';
import { loadConfig } from '../context/config.js';
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
  create "desired state" ["instructions"]                Create a child objective
  tree                                                   Show objective tree
  show <id>                                              Show one objective
  send <id> "message"                                    Send message to objective's inbox
  inbox <id>                                             Show conversation for objective
  succeed <id> "summary"                                 Resolve a child objective (summary required)
  fail <id> "reason"                                     Fail a child objective (reason required)
  reject <id> "feedback"                                 Reject a child objective with feedback (retry)
  wait "reason"                                          Set current objective to waiting
  tell <id> "message"                                    Send message to any objective
  notify "message" --important/--not-important --urgent/--not-urgent  Notify Max directly
  schedule <id> "message" --interval <interval>           Create a schedule (5s, 1m, 1h, 1d)
  schedules [objective_id]                               List active schedules
  find "query"                                           Search objectives
  engine                                                 Start the engine
  context [objective_id] [--dump|--tui]                   Print assembled context

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
  const db = initDb();
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

  const db = initDb();
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

  const instructions = positional[1] ?? null;
  const parentId = process.env.ARIA_OBJECTIVE_ID ?? 'root';
  const model = (flags['model'] as string) ?? 'sonnet';

  const db = initDb();

  // Verify parent exists
  const parent = getObjective(db, parentId);
  if (!parent) {
    console.error(`Parent objective not found: ${parentId}`);
    db.close();
    process.exit(1);
  }

  const newObj = createObjective(db, {
    objective: objectiveText,
    parent: parentId,
    model,
  });

  if (instructions) {
    insertMessage(db, {
      objective_id: newObj.id,
      message: instructions,
      sender: process.env.ARIA_OBJECTIVE_ID ?? 'system',
      type: 'message',
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

  const db = initDb();
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
  });

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

  const db = initDb();
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

  const db = initDb();
  const error = validateSucceed(db, targetId, summary, callerId);
  if (error) {
    console.error(error);
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

  insertMessage(db, {
    objective_id: targetId!,
    message: summary!,
    sender: 'system',
    type: 'reply',
  });

  // Notify parent
  const resultMsg = `[resolved] ${obj.objective}: ${summary}`;
  insertMessage(db, {
    objective_id: obj.parent!,
    message: resultMsg,
    sender: targetId!,
    type: 'reply',
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

  const db = initDb();
  const error = validateFail(db, targetId, reason, callerId);
  if (error) {
    console.error(error);
    db.close();
    process.exit(1);
  }

  const obj = getObjective(db, targetId!)!;

  updateStatus(db, targetId!, 'failed');

  if (obj.parent) {
    insertMessage(db, {
      objective_id: obj.parent,
      message: `[failed] ${obj.objective}: ${reason}`,
      sender: targetId!,
      type: 'reply',
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

  const db = initDb();
  const error = validateReject(db, targetId, feedback, callerId);
  if (error) {
    console.error(error);
    db.close();
    process.exit(1);
  }

  const obj = getObjective(db, targetId!)!;

  updateStatus(db, targetId!, 'idle');
  clearWaitingOn(db, targetId!);

  insertMessage(db, {
    objective_id: targetId!,
    message: feedback!,
    sender: callerId ?? 'max',
    type: 'message',
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

  const db = initDb();
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

  const db = initDb();
  const error = validateTell(db, targetId, message);
  if (error) {
    console.error(error);
    db.close();
    process.exit(1);
  }

  const senderId = process.env.ARIA_OBJECTIVE_ID ?? 'max';
  const obj = getObjective(db, targetId!)!;

  const msg = insertMessage(db, {
    objective_id: targetId!,
    message: message!,
    sender: senderId,
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

  const db = initDb();

  insertMessage(db, {
    objective_id: 'root',
    message: '[notify] ' + message,
    sender: process.env.ARIA_OBJECTIVE_ID ?? 'system',
    type: 'signal',
  });

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

  db.close();
}

function cmdFind(rawArgs: string[]): void {
  const query = rawArgs[0];

  if (!query) {
    console.error('Usage: aria find "query"');
    process.exit(1);
  }

  const db = initDb();
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
    // Objective-specific context: use v1 assembler for full context
    const db = initDb();
    const obj = getObjective(db, objectiveId);
    if (!obj) {
      console.error(`Objective not found: ${objectiveId}`);
      db.close();
      process.exit(1);
    }

    const outPath = assembleContext(db, objectiveId);
    const content = fs.readFileSync(outPath, 'utf-8');

    if (flags['tui']) {
      // For TUI mode with objective, use v2 assembler with all bricks
      const config = loadConfig();
      const bricks = [personaBrick, contractBrick, environmentBrick, treeBrick, conversationBrick, similarBrick];
      const result = assembleContextV2(bricks, { db, objectiveId, config: config as unknown as Record<string, unknown> });

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
    const budget = 80_000;
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

  // No objective_id: static brick dump (existing behavior)
  const config = loadConfig();
  const bricks = [personaBrick, contractBrick, environmentBrick, similarBrick];
  const result = assembleContextV2(bricks, { config: config as unknown as Record<string, unknown> });

  if (flags['dump']) {
    // Non-interactive dump to stdout
    const budget = 80_000;
    console.log(color.dim('─'.repeat(60)));
    console.log(color.cyan('Context Assembly (static bricks only)'));
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

  const db = initDb();
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

  const db = initDb();

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

  case 'engine': {
    const engineDb = initDb();
    const { nudge } = startEngine(engineDb);
    const surfaceDist = new URL('../../../surface/dist', import.meta.url).pathname;
    const server = startServer(engineDb, nudge, surfaceDist);
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

  default:
    console.error(`Unknown command: ${command}`);
    console.log(HELP);
    process.exit(1);
}
