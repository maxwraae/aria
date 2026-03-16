import { spawn } from "child_process";
import fs from "fs";
import Database from "better-sqlite3";
import {
  getObjective,
  getUnprocessedMessages,
  getSenderRelation,
  updateStatus,
  createTurn,
  stampMessages,
  insertMessage,
  InboxMessage,
} from "../db/queries.js";
import { assembleContext } from "../context/assembler.js";
import personaBrick from "../context/bricks/persona/index.js";
import contractBrick from "../context/bricks/contract/index.js";
import environmentBrick from "../context/bricks/environment/index.js";
import objectiveBrick from "../context/bricks/objective/index.js";
import parentsBrick from "../context/bricks/parents/index.js";
import siblingsBrick from "../context/bricks/siblings/index.js";
import childrenBrick from "../context/bricks/children/index.js";
import similarBrick from "../context/bricks/similar/index.js";
import conversationBrick from "../context/bricks/conversation/index.js";
import { processOutput } from "./output.js";
import { loadConfig } from "../context/config.js";

const BRICKS = [personaBrick, contractBrick, environmentBrick, objectiveBrick, parentsBrick, siblingsBrick, childrenBrick, similarBrick, conversationBrick];

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

  // 2. Collect all unprocessed messages for this objective
  const messages = getUnprocessedMessages(db, objectiveId);

  // 3. Assemble context → write to temp file
  const config = loadConfig();
  const { content } = assembleContext(BRICKS, { db, objectiveId, config: config as unknown as Record<string, unknown> });
  const contextPath = `/tmp/aria-context-${objectiveId}.md`;
  fs.writeFileSync(contextPath, content, "utf-8");

  // 4. Build user message from bundled inbox messages
  const userMessage = formatMessages(db, messages, objectiveId);

  // 5. Get the objective's model
  const obj = getObjective(db, objectiveId);
  const model = obj?.model ?? "sonnet";

  // 6. Create turn record
  const turn = createTurn(db, { objective_id: objectiveId });

  // 7. Stamp inbox messages with turn ID
  stampMessages(db, objectiveId, turn.id);

  // 8. Spawn claude -p
  const claudePath = process.env.CLAUDE_PATH ?? "claude";
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
    });
    try { fs.unlinkSync(`/tmp/aria-context-${objectiveId}.md`); } catch {}
  });

  // 9. Process output asynchronously
  processOutput(proc, turn.id, objectiveId, db);
}
