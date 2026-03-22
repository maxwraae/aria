import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import os from "os";
import type { Brick, BrickContext, BrickResult } from "../../types.js";
import { getObjective, getUnprocessedMessages, getSenderRelation, getTurnCount } from "../../../db/queries.js";
import { countTokens } from "../../tokens.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const environmentBrick: Brick = {
  name: "ENVIRONMENT",
  type: "static",
  render(ctx: BrickContext): BrickResult {
    // Dynamic parts
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const timeStr = now.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    // Machine detection
    const hostname = os.hostname();
    const isMini =
      hostname.toLowerCase().includes("mini") ||
      hostname.toLowerCase().includes("mac-mini");
    const machineName = isMini ? "Mac Mini" : "MacBook Pro";

    // Model and CWD from objective
    let model = "sonnet";
    let cwd = process.env.HOME ?? "~";
    const objectiveId = ctx.objectiveId ?? "unknown";

    if (ctx.db && ctx.objectiveId) {
      const obj = getObjective(ctx.db, ctx.objectiveId);
      if (obj) {
        model = obj.model ?? "sonnet";
        cwd = obj.cwd ?? process.env.HOME ?? "~";
      }
    }

    // Build "This cycle" section when db is available
    let cycleSection = "";
    if (ctx.db && ctx.objectiveId) {
      const obj = getObjective(ctx.db, ctx.objectiveId);
      if (obj) {
        const previousTurns = getTurnCount(ctx.db, ctx.objectiveId);
        const turnNumber = previousTurns + 1;

        // Get unique sender labels from unprocessed messages
        const unprocessed = getUnprocessedMessages(ctx.db, ctx.objectiveId);
        const seenSenders = new Set<string>();
        const triggerLabels: string[] = [];
        for (const msg of unprocessed) {
          if (!seenSenders.has(msg.sender)) {
            seenSenders.add(msg.sender);
            const tag = getSenderRelation(ctx.db, msg.sender, ctx.objectiveId);
            triggerLabels.push(tag.label);
          }
        }

        const lines: string[] = [
          `## This cycle`,
          ``,
          `Turn: ${turnNumber}`,
        ];
        if (triggerLabels.length > 0) {
          lines.push(`Triggered by: ${triggerLabels.join(", ")}`);
        }
        lines.push(`Depth: ${obj.depth}`);
        lines.push(`Important: ${obj.important ? "yes" : "no"}`);
        lines.push(`Urgent: ${obj.urgent ? "yes" : "no"}`);
        if (obj.fail_count > 0) {
          lines.push(`Failures: ${obj.fail_count}`);
        }

        cycleSection = "\n\n" + lines.join("\n");
      }
    }

    // Build dynamic header
    const header = `# ENVIRONMENT

## You are on the ${machineName}

Model: ${model}
CWD: ${cwd}
Objective ID: ${objectiveId} (env: ARIA_OBJECTIVE_ID)

## ${dateStr} · ${timeStr}`;

    // Read machine-specific and shared content
    const machineFile = isMini ? "environment-mini.md" : "environment-macbook.md";
    const machineBody = readFileSync(join(__dirname, machineFile), "utf-8");
    const sharedBody = readFileSync(join(__dirname, "environment.md"), "utf-8");

    const content = header + cycleSection + "\n\n" + machineBody + "\n\n" + sharedBody;

    return {
      name: "ENVIRONMENT",
      type: "static" as const,
      content,
      tokens: countTokens(content),
    };
  },
};

export default environmentBrick;
