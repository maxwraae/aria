import { ChildProcess, spawn } from "child_process";
import fs from "fs";
import { join } from "path";
import { homedir } from "os";
import Database from "better-sqlite3";
import { emit } from './streams.js';
import {
  updateTurnSession,
  getObjective,
  insertMessage,
  updateStatus,
  updateLastError,
  resetFailCount,
} from "../db/queries.js";
import { isWorker, getCoordinatorUrl } from "../db/node.js";

interface PromotedAction {
  tool: string;
  summary: string;
}

function classifyToolUse(name: string, input: Record<string, unknown>): PromotedAction | null {
  if (name === 'Edit') {
    const fp = (input.file_path as string) ?? '';
    const filename = fp.split('/').pop() ?? fp;
    return { tool: 'Edit', summary: `edited ${filename}` };
  }
  if (name === 'Write') {
    const fp = (input.file_path as string) ?? '';
    const filename = fp.split('/').pop() ?? fp;
    return { tool: 'Write', summary: `wrote ${filename}` };
  }
  if (name === 'Bash') {
    const cmd = ((input.command as string) ?? '').trim();
    if (cmd.startsWith('aria spawn-child')) {
      const match = cmd.match(/aria spawn-child\s+["']([^"']+)["']/);
      const obj = match?.[1] ?? 'child';
      return { tool: 'spawn-child', summary: `spawned "${obj}"` };
    }
    return null;
  }
  if (name === 'WebSearch') {
    const query = (input.query as string) ?? (input.search_query as string) ?? '';
    return { tool: 'WebSearch', summary: `searched "${query.slice(0, 50)}"` };
  }
  if (name === 'WebFetch') {
    const url = (input.url as string) ?? '';
    const domain = url.replace(/^https?:\/\//, '').split('/')[0] ?? url;
    return { tool: 'WebFetch', summary: `fetched ${domain}` };
  }
  return null;
}

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
  db: Database.Database,
  cascadeId?: string,
): void {
  const tag = objectiveId.slice(0, 8);
  let lastAssistantText = "";
  let streamedText = "";
  let buffer = "";
  const actions: PromotedAction[] = [];
  // Capture last N stderr lines for diagnostics on silent failure
  const MAX_STDERR_LINES = 20;
  const stderrLines: string[] = [];

  // ── Activity watchdog ─────────────────────────────────────────────
  const ACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 minutes with no I/O = hung
  const WATCHDOG_INTERVAL = 30_000;        // check every 30s
  let lastActivityTime = Date.now();
  let watchdogKilled = false;

  const watchdog = setInterval(() => {
    if (Date.now() - lastActivityTime > ACTIVITY_TIMEOUT) {
      watchdogKilled = true;
      process.stderr.write(`[${tag}] No I/O for 5m — killing hung process (pid ${proc.pid})\n`);
      proc.kill('SIGTERM');
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
      }, 5000);
    }
  }, WATCHDOG_INTERVAL);

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

          // Classify tool calls for action annotations
          if (block.type === "tool_use") {
            const action = classifyToolUse(
              block.name as string,
              (block.input as Record<string, unknown>) ?? {}
            );
            if (action) actions.push(action);
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

      case "stream_event": {
        const event = frame.event as Record<string, unknown> | undefined;
        if (!event) break;
        const eventType = event.type as string | undefined;
        if (eventType === "content_block_delta") {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            streamedText += delta.text;
            emit(objectiveId, streamedText, false);
          }
        }
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
    lastActivityTime = Date.now();
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
    lastActivityTime = Date.now();
    const text = chunk.toString();
    process.stderr.write(`[${tag}] ${text}`);
    // Capture lines for diagnostics, trimming the ring buffer
    const newLines = text.split("\n").filter(l => l.trim());
    for (const line of newLines) {
      stderrLines.push(line);
      if (stderrLines.length > MAX_STDERR_LINES) stderrLines.shift();
    }
  });

  // ── API wake-up watchdog ─────────────────────────────────────────
  // If no stdout bytes arrive within 10s, the API may be stalled.
  // Fire a throwaway haiku ping to unblock it, then log the event.
  const WAKE_TIMEOUT_MS = 10_000;
  let wakeTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    wakeTimer = null;
    process.stderr.write(`[wake-up] ${tag} no output in 10s — firing haiku ping\n`);

    const logLine = `${new Date().toISOString()} ${objectiveId} triggered\n`;
    try {
      fs.appendFileSync(join(homedir(), ".aria", "wake-up.log"), logLine);
    } catch { /* dir may not exist yet — non-fatal */ }

    const claudePath = process.env.CLAUDE_PATH ?? join(homedir(), ".local", "bin", "claude");
    const ping = spawn(claudePath, ["-p", "hi", "--model", "haiku"], {
      env: { ...process.env },
      stdio: "ignore",
    });
    const killTimer = setTimeout(() => ping.kill(), 5_000);
    ping.on("close", () => clearTimeout(killTimer));
  }, WAKE_TIMEOUT_MS);

  // Cancel the watchdog if output arrives in time or process ends early
  proc.stdout?.once("data", () => { if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = null; } });
  proc.on("close", () => { if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = null; } });

  // ── Turn completion ──────────────────────────────────────────────

  proc.on("close", (code) => {
    clearInterval(watchdog);
    if (code !== 0 && code !== null) {
      process.stderr.write(`[${tag}] Process exited with code ${code}\n`);
    }

    // 1. Read objective's current status (agent may have changed it via CLI)
    const obj = getObjective(db, objectiveId);
    const currentStatus = obj?.status ?? "thinking";

    // 2. If still 'thinking', agent didn't change status itself — determine outcome
    const hasOutput = !!(streamedText || lastAssistantText);
    if (currentStatus === "thinking") {
      updateStatus(db, objectiveId, "needs-input");

      if (hasOutput) {
        // Normal turn — agent responded but didn't change status (the common case)
        resetFailCount(db, objectiveId);
        process.stderr.write(`[${tag}] Turn complete, status: needs-input\n`);
      } else {
        // Actual failure — agent produced no output
        const parts: string[] = [];
        if (code !== 0 && code !== null) {
          parts.push(`Exit code: ${code}`);
        }
        if (stderrLines.length > 0) {
          parts.push(`Last stderr:\n${stderrLines.join("\n")}`);
        } else {
          parts.push("Agent exited without producing output or changing status.");
        }
        if (watchdogKilled) {
          parts.push("Killed by watchdog after 5m of no I/O — likely stalled after machine sleep.");
        }
        const errorContext = parts.join("\n\n");
        updateLastError(db, objectiveId, errorContext);

        process.stderr.write(
          `[${tag}] Turn complete, status: needs-input (silent failure — no output)\n`
        );
      }
    } else {
      // Agent changed status itself (e.g. via aria CLI) — successful turn
      resetFailCount(db, objectiveId);
      process.stderr.write(
        `[${tag}] Turn complete, status: ${currentStatus}\n`
      );
    }

    // 3. Store the assistant's full output in the objective's own inbox
    //    Uses streamedText (all text deltas) rather than lastAssistantText (last block only)
    //    so intermediate text before tool calls is preserved.

    // Persist promoted tool actions as individual inbox messages
    const deduped: PromotedAction[] = [];
    for (const action of actions) {
      const prev = deduped[deduped.length - 1];
      if (prev && prev.summary === action.summary) {
        const countMatch = prev.summary.match(/ \((\d+)x\)$/);
        const count = countMatch ? parseInt(countMatch[1]) + 1 : 2;
        prev.summary = prev.summary.replace(/ \(\d+x\)$/, '') + ` (${count}x)`;
      } else {
        deduped.push({ ...action });
      }
    }
    for (const action of deduped) {
      const actionMsg = insertMessage(db, {
        objective_id: objectiveId,
        message: action.summary,
        sender: objectiveId,
        type: "action",
        cascade_id: cascadeId,
      });
      db.prepare("UPDATE inbox SET turn_id = ? WHERE id = ?").run(turnId, actionMsg.id);
    }

    const fullOutput = streamedText || lastAssistantText;
    if (fullOutput) {

      const selfMsg = insertMessage(db, {
        objective_id: objectiveId,
        message: fullOutput,
        sender: objectiveId,
        type: "reply",
        cascade_id: cascadeId,
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
            message: fullOutput,
            sender: objectiveId,
            type: "reply",
            cascade_id: cascadeId,
          });
        }
      }
    }

    // Notify stream subscribers that this turn is complete
    emit(objectiveId, '', true);

    // 5. Push result to coordinator (worker mode only)
    if (isWorker() && fullOutput) {
      const coordUrl = getCoordinatorUrl();
      if (coordUrl) {
        const finalStatus = obj?.status === 'thinking' ? 'needs-input' : (obj?.status ?? 'needs-input');
        fetch(`${coordUrl}/api/worker/turns/${turnId}/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            objectiveId,
            status: finalStatus,
            lastAssistantText: fullOutput,
            sessionId: null, // already set during stream
          }),
        }).then(res => {
          if (res.ok) {
            process.stderr.write(`[${tag}] Pushed result to coordinator\n`);
          } else {
            process.stderr.write(`[${tag}] Coordinator push failed: ${res.status}\n`);
          }
        }).catch(err => {
          process.stderr.write(`[${tag}] Coordinator unreachable: ${err.message}\n`);
        });
      }
    }

    // 6. Clean up context temp file
    const contextPath = `/tmp/aria-context-${objectiveId}.md`;
    try {
      fs.unlinkSync(contextPath);
    } catch {
      // Already cleaned up or never written — fine
    }
  });
}
