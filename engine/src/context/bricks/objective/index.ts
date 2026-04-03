import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { Brick, BrickContext, BrickResult } from "../../types.js";
import { getObjective, getTurnCount } from "../../../db/queries.js";
import { countTokens } from "../../tokens.js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const objectiveBrick: Brick = {
  name: "OBJECTIVE",
  type: "static",
  render(ctx: BrickContext): BrickResult | null {
    if (!ctx.db || !ctx.objectiveId) return null;

    const obj = getObjective(ctx.db, ctx.objectiveId);
    if (!obj) return null;

    const now = Date.now() / 1000;
    const daysSinceUpdate = Math.floor((now - obj.updated_at) / 86400);
    const turnCount = getTurnCount(ctx.db, ctx.objectiveId);

    let statusLine = obj.status;
    if (obj.waiting_on) statusLine += ` — waiting on: ${obj.waiting_on}`;
    statusLine += ` · Turn ${turnCount} · Last updated ${daysSinceUpdate} days ago`;

    const template = readFileSync(join(__dirname, "objective.md"), "utf-8");

    const ongoingNotice = obj.depth === 1
      ? `> **⚠ ONGOING OBJECTIVE — YOU CANNOT RESOLVE THIS**\n>\n> This objective has no finish line that you can reach. Only Max closes it. Do not call resolve-child or any resolution action on yourself. When nothing can move forward autonomously, park and wait. Do not report to your parent unless something has **genuinely changed** — a new result, a blocker, a decision needed. Routine status confirmations are noise.`
      : "";

    const descriptionSection = obj.description
      ? `## Description\n\n${obj.description}`
      : "";

    let workSection = "";
    if (obj.work_path) {
      try {
        const workContent = readFileSync(obj.work_path, "utf-8").trim();
        if (workContent) {
          workSection = `## Work\n\nFile: ${obj.work_path}\n\n${workContent}`;
        } else {
          workSection = `## Work\n\nFile: ${obj.work_path}\n\n(empty — update this before you exit)`;
        }
      } catch {
        // File missing or unreadable — skip
      }
    }

    const content = template
      .replace("{{OBJECTIVE}}", obj.objective)
      .replace("{{STATUS_LINE}}", statusLine)
      .replace(ongoingNotice ? "{{ONGOING_NOTICE}}" : "\n{{ONGOING_NOTICE}}\n", ongoingNotice)
      .replace(obj.description ? "{{DESCRIPTION_SECTION}}" : "\n{{DESCRIPTION_SECTION}}\n", descriptionSection || "")
      .replace(workSection ? "{{WORK_SECTION}}" : "\n{{WORK_SECTION}}\n", workSection || "");

    return {
      name: "OBJECTIVE",
      type: "static" as const,
      content,
      tokens: countTokens(content),
      meta: { sourcePath: join(__dirname, "objective.md") },
    };
  },
};

export default objectiveBrick;
