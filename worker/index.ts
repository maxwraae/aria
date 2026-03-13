import { spawn } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ── Config ────────────────────────────────────────────────────────

const COORDINATOR = process.env.ARIA_COORDINATOR;
const MACHINE = process.env.ARIA_MACHINE;

if (!COORDINATOR) {
  console.error("ARIA_COORDINATOR env var is required (e.g. http://192.168.1.100:8080)");
  process.exit(1);
}
if (!MACHINE) {
  console.error("ARIA_MACHINE env var is required (e.g. macbook)");
  process.exit(1);
}

const POLL_INTERVAL = 5_000;
const MAX_BACKOFF = 60_000;

// ── Types ─────────────────────────────────────────────────────────

interface WorkItem {
  objectiveId: string;
  objective: string;
  context: string;
  messages: { message: string; sender: string; type: string }[];
}

// ── Helpers ───────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] ${msg}`);
}

async function fetchObjectives(): Promise<WorkItem[]> {
  const res = await fetch(
    `${COORDINATOR}/api/worker/objectives?machine=${encodeURIComponent(MACHINE!)}`
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as WorkItem[];
}

async function postResult(objectiveId: string, result: string): Promise<void> {
  const res = await fetch(
    `${COORDINATOR}/api/worker/turns/${objectiveId}/complete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result }),
    }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function buildUserMessage(item: WorkItem): string {
  if (item.messages.length === 0) return item.objective;
  return item.messages.map((m) => m.message).join("\n\n");
}

function runClaude(userMessage: string, contextPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", [
      "-p", userMessage,
      "--system-prompt-file", contextPath,
      "--output-format", "stream-json",
      "--allowedTools", "Bash,Edit,Read,Write,Glob,Grep",
      "--model", "sonnet",
      "--dangerously-skip-permissions",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let lastAssistantText = "";
    let buffer = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line);
          if (frame.type === "assistant" && frame.message?.content) {
            for (const block of frame.message.content) {
              if (block.type === "text" && typeof block.text === "string") {
                lastAssistantText = block.text;
              }
            }
          } else if (frame.type === "result" && frame.result) {
            // Some versions emit a result frame with the final text
            if (typeof frame.result === "string") {
              lastAssistantText = frame.result;
            }
          }
        } catch {
          // Not valid JSON, skip
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    proc.on("error", reject);

    proc.on("close", (code) => {
      if (code !== 0 && code !== null && !lastAssistantText) {
        reject(new Error(`claude exited with code ${code}`));
      } else {
        resolve(lastAssistantText || "(no output)");
      }
    });
  });
}

// ── Process a single objective ────────────────────────────────────

async function processObjective(item: WorkItem): Promise<void> {
  const tag = item.objectiveId.slice(0, 8);
  log(`Processing ${tag}: ${item.objective.slice(0, 60)}`);

  const contextPath = join(tmpdir(), `aria-worker-${item.objectiveId}.md`);
  writeFileSync(contextPath, item.context);

  try {
    const userMessage = buildUserMessage(item);
    const result = await runClaude(userMessage, contextPath);
    log(`Completed ${tag}, posting result (${result.length} chars)`);
    await postResult(item.objectiveId, result);
    log(`Posted ${tag}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Error on ${tag}: ${msg}`);
    try {
      await postResult(item.objectiveId, `[worker error] ${msg}`);
    } catch {
      log(`Failed to report error for ${tag}`);
    }
  } finally {
    try { unlinkSync(contextPath); } catch { /* ignore */ }
  }
}

// ── Poll loop ─────────────────────────────────────────────────────

let backoff = POLL_INTERVAL;
let running = true;

async function poll(): Promise<void> {
  while (running) {
    try {
      const items = await fetchObjectives();
      backoff = POLL_INTERVAL; // reset on success

      if (items.length > 0) {
        log(`Received ${items.length} objective(s)`);
        for (const item of items) {
          if (!running) break;
          await processObjective(item);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Coordinator unreachable: ${msg} (retry in ${backoff / 1000}s)`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
      continue;
    }

    await sleep(POLL_INTERVAL);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Graceful shutdown ─────────────────────────────────────────────

process.on("SIGINT", () => {
  log("Shutting down (SIGINT)");
  running = false;
});

process.on("SIGTERM", () => {
  log("Shutting down (SIGTERM)");
  running = false;
});

// ── Start ─────────────────────────────────────────────────────────

log(`Worker starting: machine=${MACHINE}, coordinator=${COORDINATOR}`);
poll().then(() => log("Worker stopped"));
