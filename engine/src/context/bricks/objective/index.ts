import { readFileSync } from "fs";
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

    const descriptionSection = obj.description
      ? `## Description\n\n${obj.description}`
      : "";

    const content = template
      .replace("{{OBJECTIVE}}", obj.objective)
      .replace("{{STATUS_LINE}}", statusLine)
      .replace(obj.description ? "{{DESCRIPTION_SECTION}}" : "\n{{DESCRIPTION_SECTION}}\n", descriptionSection || "");

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
