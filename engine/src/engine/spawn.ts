import { spawn } from "child_process";
import fs from "fs";
import { join } from "path";
import { homedir } from "os";
import Database from "better-sqlite3";
import {
  getObjective,
  getUnprocessedMessages,
  getSenderRelation,
  updateStatus,
  createTurn,
  stampMessages,
  insertMessage,
  resolveCascadeId,
  getCascadeTurnCount,
  stopCascade,
  hasUnprocessedMaxMessage,
  InboxMessage,
} from "../db/queries.js";
import { generateId } from "../db/utils.js";
import { loadEngineConfig } from './engine-config.js';
import { assembleContext } from "../context/assembler.js";
import personaBrick from "../context/bricks/persona/index.js";
import contractBrick from "../context/bricks/contract/index.js";
import environmentBrick from "../context/bricks/environment/index.js";
import objectiveBrick from "../context/bricks/objective/index.js";
import parentsBrick from "../context/bricks/parents/index.js";
import siblingsBrick from "../context/bricks/siblings/index.js";
import childrenBrick from "../context/bricks/children/index.js";
import similarBrick from "../context/bricks/similar/index.js";
import memoryBrick from "../context/bricks/memory/index.js";
import conversationBrick from "../context/bricks/conversation/index.js";
import neverBrick from "../context/bricks/never/index.js";
import focusBrick from "../context/bricks/focus/index.js";
import { processOutput } from "./output.js";
import { loadConfig } from "../context/config.js";
import { getEmbedding } from '../memory/embeddings.js';
import type { BrickContext } from '../context/types.js';

const BRICKS = [personaBrick, contractBrick, environmentBrick, objectiveBrick, parentsBrick, siblingsBrick, childrenBrick, similarBrick, memoryBrick, conversationBrick, neverBrick, focusBrick];

export function resolveModel(db: Database.Database, objectiveId: string): string {
  const obj = getObjective(db, objectiveId);
  const stored = obj?.model ?? "sonnet";
  if (stored === "sonnet" && hasUnprocessedMaxMessage(db, objectiveId)) {
    return "opus";
  }
  return stored;
}

function formatMessages(
  db: Database.Database,
  messages: InboxMessage[],
  objectiveId: string
): string {
  // Separate by type: context messages first, Max's messages last
  const context = messages.filter((m) => m.sender !== "max");
  const fromMax = messages.filter((m) => m.sender === "max");
  const ordered = [...context, ...fromMax];

  return ordered
    .map((m) => {
      const tag = getSenderRelation(db, m.sender, objectiveId);
      const suffix = m.type === "reply" ? " (reply)" : "";
      return `[${tag.label}${suffix}] ${m.message}`;
    })
    .join("\n\n");
}

export async function spawnTurn(
  db: Database.Database,
  objectiveId: string
): Promise<void> {
  // 1. Set status → 'thinking'
  updateStatus(db, objectiveId, "thinking");

  // 2. Collect unprocessed messages — process one at a time (FIFO)
  const allPending = getUnprocessedMessages(db, objectiveId);
  const messages = allPending.slice(0, 1);

  // 3. Resolve cascade and check limit (before expensive context assembly)
  const engineConfig = loadEngineConfig();
  const cascadeId = resolveCascadeId(db, objectiveId);

  if (cascadeId && engineConfig.cascade_turn_limit > 0) {
    const count = getCascadeTurnCount(db, cascadeId);
    if (count >= engineConfig.cascade_turn_limit) {
      const stoppedIds = stopCascade(db, cascadeId);
      insertMessage(db, {
        objective_id: objectiveId,
        message: `[system] Cascade limit reached (${engineConfig.cascade_turn_limit} turns). Stopped ${stoppedIds.length} objective(s).`,
        sender: 'system',
        cascade_id: generateId(),
      });
      console.log(`[engine] Cascade ${cascadeId.slice(0, 8)} hit limit (${engineConfig.cascade_turn_limit}), stopped ${stoppedIds.length} objective(s)`);
      return;
    }
  }

  // 4. Assemble context → write to temp file
  const config = loadConfig();
  // Pre-compute query embeddings for memory brick vector searches
  let memoryEmbeddings: BrickContext['memoryEmbeddings'] = null;
  try {
    const embObj = getObjective(db, objectiveId);
    const embParent = embObj?.parent
      ? db.prepare('SELECT objective, description FROM objectives WHERE id = ?').get(embObj.parent) as { objective: string; description: string | null } | undefined
      : undefined;
    const embCurrentMsg = db
      .prepare('SELECT message FROM inbox WHERE objective_id = ? AND turn_id IS NULL ORDER BY created_at ASC LIMIT 1')
      .get(objectiveId) as { message: string } | undefined;
    const embPrevMsgs = db
      .prepare('SELECT message FROM inbox WHERE objective_id = ? AND turn_id IS NOT NULL ORDER BY created_at DESC LIMIT 2')
      .all(objectiveId) as { message: string }[];

    const messageText = embCurrentMsg?.message ?? '';
    const prevText = embPrevMsgs.map(m => m.message).join(' ');
    const objectiveText = [embObj?.objective, embObj?.description].filter(Boolean).join(' ');
    const parentText = [embParent?.objective, embParent?.description].filter(Boolean).join(' ');

    // Read work document if it exists
    let workText = '';
    if (embObj?.work_path) {
      try { workText = fs.readFileSync(embObj.work_path, 'utf-8').trim(); } catch {}
    }

    const sources = [messageText, prevText, objectiveText, parentText, workText];
    const embeddings = await Promise.allSettled(
      sources.map(t => t ? getEmbedding(t) : Promise.resolve(null))
    );
    memoryEmbeddings = {
      message:   embeddings[0].status === 'fulfilled' ? embeddings[0].value : null,
      prevTurn:  embeddings[1].status === 'fulfilled' ? embeddings[1].value : null,
      objective: embeddings[2].status === 'fulfilled' ? embeddings[2].value : null,
      parent:    embeddings[3].status === 'fulfilled' ? embeddings[3].value : null,
      work:      embeddings[4].status === 'fulfilled' ? embeddings[4].value : null,
    };
  } catch {
    // Ollama unavailable — brick will fall back to BM25-only
  }
  const { content, sections } = assembleContext(BRICKS, { db, objectiveId, config: config as unknown as Record<string, unknown>, memoryEmbeddings });
  const contextPath = `/tmp/aria-context-${objectiveId}.md`;
  fs.writeFileSync(contextPath, content, "utf-8");

  // 4. Build user message from bundled inbox messages
  const userMessage = formatMessages(db, messages, objectiveId);

  // 5. Resolve model: explicit override > Max in unprocessed → opus > default sonnet
  const obj = getObjective(db, objectiveId);
  const model = resolveModel(db, objectiveId);
  console.log(`[spawn] ${objectiveId.slice(0, 8)} model=${model} (resolved)`);

  // 6. Create turn record (with cascade_id)
  const turn = createTurn(db, { objective_id: objectiveId, cascade_id: cascadeId ?? undefined });

  // 7. Stamp only the one message we processed (rest stay pending for next turn)
  db.prepare("UPDATE inbox SET turn_id = ? WHERE id = ?").run(turn.id, messages[0].id);

  // Write injected memory IDs to turn record for edge tracking
  const memSection = sections.find(s => s.name === 'MEMORIES');
  const injectedIds = memSection?.meta?.injectedIds ?? [];
  if (injectedIds.length > 0) {
    db.prepare('UPDATE turns SET injected_memory_ids = ? WHERE id = ?')
      .run(JSON.stringify(injectedIds), turn.id);
  }

  // 9. Spawn claude -p
  const claudePath = process.env.CLAUDE_PATH ?? join(homedir(), '.local', 'bin', 'claude');
  const proc = spawn(
    claudePath,
    [
      "-p",
      userMessage,
      "--system-prompt-file",
      contextPath,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--allowedTools",
      "Bash,Edit,Read,Write,Glob,Grep",
      "--disallowedTools",
      "Agent",
      "--model",
      model,
      "--dangerously-skip-permissions",
    ],
    {
      env: {
        ...process.env,
        CLAUDECODE: "",
        CLAUDE_CODE_ENTRYPOINT: "",
        ARIA_OBJECTIVE_ID: objectiveId,
        ARIA_CASCADE_ID: cascadeId ?? "",
      },
      cwd: obj?.cwd ?? process.env.HOME,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

  // Close stdin immediately (one-shot, prompt is in -p flag)
  proc.stdin?.end();

  // Handle spawn errors (binary not found, permissions, etc.)
  proc.on("error", (err) => {
    const tag = objectiveId.slice(0, 8);
    process.stderr.write(`[${tag}] Spawn error: ${err.message}\n`);
    updateStatus(db, objectiveId, "needs-input");
    insertMessage(db, {
      objective_id: objectiveId,
      message: `[system] Agent spawn failed: ${err.message}`,
      sender: "system",
      cascade_id: generateId(),
    });
    try { fs.unlinkSync(`/tmp/aria-context-${objectiveId}.md`); } catch {}
  });

  // 9. Process output asynchronously
  processOutput(proc, turn.id, objectiveId, db, cascadeId ?? undefined);
}
