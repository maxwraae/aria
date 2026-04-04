import Database from 'better-sqlite3';
import fs from 'fs';
import { openDb, migrateDb } from './db/schema.js';
import { createObjective, insertMessage, getObjective, getChildren } from './db/queries.js';
import { generateId } from './db/utils.js';
import { spawnTurn } from './engine/spawn.js';

// ── Types ─────────────────────────────────────────────────────────

interface SimMessage {
  role: 'max' | 'child' | 'parent' | 'sibling' | 'system';
  name?: string;
  message: string;
}

interface SimScenario {
  objective: string;
  description?: string;
  messages?: SimMessage[];
}

// ── Helpers ───────────────────────────────────────────────────────

function parseFlags(args: string[]): { flags: Record<string, string | boolean> } {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key] = args[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return { flags };
}

async function waitForTurn(db: Database.Database, objectiveId: string, timeoutMs = 300_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const obj = getObjective(db, objectiveId);
    if (obj?.status !== 'thinking') {
      // Wait for reply to be stored in inbox before closing — output.js writes it
      // just before its final getObjective call, so this ensures we don't close early
      const reply = db.prepare(
        `SELECT id FROM inbox WHERE objective_id = ? AND type = 'reply' LIMIT 1`
      ).get(objectiveId);
      if (reply) {
        await new Promise(r => setTimeout(r, 500)); // small buffer for remaining callbacks
        return;
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('[sim] timed out');
}

function buildReport(db: Database.Database, objectiveId: string, objective: string): string {
  const lines: string[] = [];

  const obj = getObjective(db, objectiveId);

  lines.push(`# Sim: ${objective}`);
  lines.push('');

  // Agent reasoning
  const reply = db.prepare(
    `SELECT message FROM inbox WHERE objective_id = ? AND sender = ? AND type = 'reply' ORDER BY created_at DESC LIMIT 1`
  ).get(objectiveId, objectiveId) as { message: string } | undefined;

  if (reply) {
    lines.push('## Message');
    lines.push('');
    lines.push(reply.message);
    lines.push('');
  }

  // Decision
  lines.push('## Decision');
  lines.push('');
  lines.push(`**Status:** ${obj?.status ?? 'unknown'}`);
  if (obj?.waiting_on) {
    lines.push('');
    lines.push(`**Waiting on:** ${obj.waiting_on}`);
  }
  lines.push('');

  // Children
  const children = getChildren(db, objectiveId);
  if (children.length > 0) {
    lines.push(`## Children spawned (${children.length})`);
    lines.push('');
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      lines.push(`### ${i + 1}. ${child.objective}`);
      lines.push('');

      // Get the instructions sent to this child
      const instructions = db.prepare(
        `SELECT message FROM inbox WHERE objective_id = ? ORDER BY created_at ASC LIMIT 1`
      ).get(child.id) as { message: string } | undefined;

      if (instructions) {
        lines.push('**Instructions given:**');
        lines.push('');
        lines.push(instructions.message);
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

function printSummary(db: Database.Database, objectiveId: string, objective: string, outputPath?: string): void {
  const report = buildReport(db, objectiveId, objective);

  if (outputPath) {
    fs.writeFileSync(outputPath, report, 'utf-8');
    console.log(`\n[sim] report saved to ${outputPath}`);
  } else {
    console.log('\n' + report);
  }
}

// ── Main ──────────────────────────────────────────────────────────

export async function runSim(args: string[]): Promise<void> {
  const { flags } = parseFlags(args);

  let scenario: SimScenario;

  if (flags.scenario) {
    scenario = JSON.parse(fs.readFileSync(flags.scenario as string, 'utf-8'));
  } else if (flags.objective) {
    const messages: SimMessage[] = [];
    if (flags.message) messages.push({ role: 'max', message: flags.message as string });
    scenario = { objective: flags.objective as string, messages };
  } else {
    console.error('Usage: aria sim --objective "..." [--message "..."]');
    console.error('       aria sim --scenario path/to/scenario.json');
    process.exit(1);
  }

  const tempPath = `/tmp/aria-sim-${Date.now()}.db`;
  process.env.ARIA_DB = tempPath;

  const db = openDb(tempPath);
  migrateDb(db);

  try {
    // Create test objective under root
    const obj = createObjective(db, {
      objective: scenario.objective,
      description: scenario.description,
      parent: 'root',
    });

    // Inject inbox messages
    for (const msg of scenario.messages ?? []) {
      let sender: string;

      if (msg.role === 'max') {
        sender = 'max';
      } else if (msg.role === 'parent') {
        sender = 'root'; // root is the parent of our test objective
      } else if (msg.role === 'system') {
        sender = 'system';
      } else if (msg.role === 'child') {
        const stub = createObjective(db, {
          objective: msg.name ?? '[sim] child',
          parent: obj.id,
        });
        sender = stub.id;
      } else { // sibling
        const stub = createObjective(db, {
          objective: msg.name ?? '[sim] sibling',
          parent: 'root',
        });
        sender = stub.id;
      }

      insertMessage(db, {
        objective_id: obj.id,
        message: msg.message,
        sender,
        cascade_id: generateId(),
      });
    }

    console.log(`\n[sim] "${scenario.objective}"`);
    console.log(`[sim] ${(scenario.messages ?? []).length} message(s) | ${tempPath}\n`);

    const slug = scenario.objective.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
    const outputPath = flags.output as string | undefined
      ?? `/Users/maxwraae/Library/Mobile Documents/com~apple~CloudDocs/Aria/engine/src/context/bricks/sim/${slug}.md`;

    spawnTurn(db, obj.id);
    await waitForTurn(db, obj.id);
    printSummary(db, obj.id, scenario.objective, outputPath);

  } finally {
    db.close();
    try { fs.unlinkSync(tempPath); } catch {}
    delete process.env.ARIA_DB;
  }
}
