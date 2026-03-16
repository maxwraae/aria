import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import os from "os";
import type { Brick, BrickContext, BrickResult } from "../../types.js";
import { getObjective } from "../../../db/queries.js";
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
    const machineSpec = isMini
      ? "**Mac Mini M1** (8GB, 256GB) · Running autonomously. Max may not be at his computer."
      : "**MacBook Pro M4 Pro** (24GB, 1TB) · Max is likely nearby.";

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

    // Build dynamic header
    const header = `# ENVIRONMENT

## You are on the ${machineName}

${machineSpec}
Model: ${model}
CWD: ${cwd}
Objective ID: ${objectiveId} (env: ARIA_OBJECTIVE_ID)

## ${dateStr} · ${timeStr}`;

    // Read static template
    const staticBody = readFileSync(
      join(__dirname, "environment.md"),
      "utf-8"
    );

    const content = header + "\n\n" + staticBody;

    return {
      name: "ENVIRONMENT",
      type: "static" as const,
      content,
      tokens: countTokens(content),
    };
  },
};

export default environmentBrick;
