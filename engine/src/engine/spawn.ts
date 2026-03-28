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
  InboxMessage,
} from "../db/queries.js";
import { generateId } from "../db/utils.js";
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

const BRICKS = [personaBrick, contractBrick, environmentBrick, objectiveBrick, parentsBrick, siblingsBrick, childrenBrick, similarBrick, memoryBrick, conversationBrick, neverBrick, focusBrick];

export function resolveModel(db: Database.Database, objectiveId: string): string {
  const obj = getObjective(db, objectiveId);
  if (obj?.model && obj.model !== "sonnet") return obj.model;

  const unprocessed = getUnprocessedMessages(db, objectiveId);
  if (unprocessed.some((m) => m.sender === "max")) return "opus";

  return "sonnet";
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

export function spawnTurn(
  db: Database.Database,
  objectiveId: string
): void {
  // 1. Set status → 'thinking'
  updateStatus(db, objectiveId, "thinking");

  // 2. Collect all unprocessed messages for this objective
  const messages = getUnprocessedMessages(db, objectiveId);

  // 3. Assemble context → write to temp file
  const config = loadConfig();
  const { content } = assembleContext(BRICKS, { db, objectiveId, config: config as unknown as Record<string, unknown> });
  const contextPath = `/tmp/aria-context-${objectiveId}.md`;
  fs.writeFileSync(contextPath, content, "utf-8");

  // 4. Build user message from bundled inbox messages
  const userMessage = formatMessages(db, messages, objectiveId);

  // 5. Resolve model: explicit override > Max in unprocessed → opus > default sonnet
  const obj = getObjective(db, objectiveId);
  const model = resolveModel(db, objectiveId);
  console.log(`[spawn] ${objectiveId.slice(0, 8)} model=${model} (resolved)`);

  // 6. Create turn record
  const turn = createTurn(db, { objective_id: objectiveId });

  // 7. Resolve cascade_id from unprocessed messages (before stamping)
  const cascadeId = resolveCascadeId(db, objectiveId);

  // 8. Stamp inbox messages with turn ID
  stampMessages(db, objectiveId, turn.id);

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
