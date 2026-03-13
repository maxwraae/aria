import { ChildProcess } from "child_process";
import fs from "fs";
import Database from "better-sqlite3";
import { emit } from './streams.js';
import {
  updateTurnSession,
  getObjective,
  insertMessage,
  updateStatus,
} from "../db/queries.js";

/**
 * Process the NDJSON stream from `claude -p --output-format stream-json`.
 *
 * Captures session ID, extracts assistant text, detects `aria` CLI calls,
 * finalizes turn status, and routes results to parent inboxes.
 */
export function processOutput(
  proc: ChildProcess,
  turnId: string,
  objectiveId: string,
  db: Database.Database
): void {
  const tag = objectiveId.slice(0, 8);
  let lastAssistantText = "";
  let buffer = "";

  // ── NDJSON line parser ───────────────────────────────────────────

  function handleFrame(frame: Record<string, unknown>): void {
    const type = frame.type as string | undefined;
    if (!type) return;

    switch (type) {
      case "system": {
        const subtype = frame.subtype as string | undefined;
        if (subtype === "init") {
          const sessionId = frame.session_id as string | undefined;
          if (sessionId) {
            updateTurnSession(db, turnId, sessionId);
            process.stderr.write(`[${tag}] Session: ${sessionId}\n`);
          }
        } else if (subtype === "error") {
          const errorMsg =
            (frame.error as string) ?? JSON.stringify(frame);
          process.stderr.write(`[${tag}] System error: ${errorMsg}\n`);
        }
        break;
      }

      case "assistant": {
        const message = frame.message as
          | { content?: Array<Record<string, unknown>> }
          | undefined;
        if (!message?.content) break;

        for (const block of message.content) {
          // Extract assistant text
          if (block.type === "text" && typeof block.text === "string") {
            lastAssistantText = block.text;
            emit(objectiveId, block.text, false);
          }

          // Detect aria CLI calls inside Bash tool_use blocks
          if (block.type === "tool_use" && block.name === "Bash") {
            const input = block.input as
              | { command?: string }
              | undefined;
            if (
              input?.command &&
              typeof input.command === "string" &&
              input.command.trimStart().startsWith("aria ")
            ) {
              process.stderr.write(
                `[${tag}] ${input.command.trim()}\n`
              );
            }
          }
        }
        break;
      }

      case "user": {
        // Tool results auto-emitted by the CLI — skip
        break;
      }

      case "result": {
        // Turn complete signal from the stream — finalize handled on 'close'
        break;
      }

      case "error": {
        const errorMsg =
          (frame.error as Record<string, unknown>)?.message ??
          JSON.stringify(frame);
        process.stderr.write(`[${tag}] Error: ${errorMsg}\n`);
        break;
      }
    }
  }

  // ── Stream processing ────────────────────────────────────────────

  proc.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep incomplete last line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const frame = JSON.parse(line);
        handleFrame(frame);
      } catch {
        // Not valid JSON, skip
      }
    }
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[${tag}] ${chunk}`);
  });

  // ── Turn completion ──────────────────────────────────────────────

  proc.on("close", (code) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`[${tag}] Process exited with code ${code}\n`);
    }

    // 1. Read objective's current status (agent may have changed it via CLI)
    const obj = getObjective(db, objectiveId);
    const currentStatus = obj?.status ?? "thinking";

    // 2. If still 'thinking', fall back to 'needs-input'
    if (currentStatus === "thinking") {
      updateStatus(db, objectiveId, "needs-input");
      process.stderr.write(
        `[${tag}] Turn complete, status: needs-input\n`
      );
    } else {
      process.stderr.write(
        `[${tag}] Turn complete, status: ${currentStatus}\n`
      );
    }

    // 3. Store the assistant's response in the objective's own inbox
    //    Stamp with turnId so it doesn't re-trigger the engine
    if (lastAssistantText) {
      const selfMsg = insertMessage(db, {
        objective_id: objectiveId,
        message: lastAssistantText,
        sender: objectiveId,
        type: "reply",
      });
      db.prepare("UPDATE inbox SET turn_id = ? WHERE id = ?").run(turnId, selfMsg.id);

      // 4. Route result to non-Max senders (child objectives that sent messages)
      const triggeredMessages = db
        .prepare(
          "SELECT DISTINCT sender FROM inbox WHERE turn_id = ? AND sender != ? AND sender != ? AND sender != ?"
        )
        .all(turnId, "max", "system", objectiveId) as { sender: string }[];

      for (const { sender } of triggeredMessages) {
        const senderObj = getObjective(db, sender);
        if (senderObj) {
          insertMessage(db, {
            objective_id: sender,
            message: lastAssistantText,
            sender: objectiveId,
            type: "reply",
          });
        }
      }
    }

    // Notify stream subscribers that this turn is complete
    emit(objectiveId, '', true);

    // 5. Clean up context temp file
    const contextPath = `/tmp/aria-context-${objectiveId}.md`;
    try {
      fs.unlinkSync(contextPath);
    } catch {
      // Already cleaned up or never written — fine
    }
  });
}
