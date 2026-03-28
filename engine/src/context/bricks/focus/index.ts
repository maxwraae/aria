import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { Brick, BrickContext, BrickResult } from "../../types.js";
import { getObjective } from "../../../db/queries.js";
import { countTokens } from "../../tokens.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const focusBrick: Brick = {
  name: "FOCUS",
  type: "static",
  render(ctx: BrickContext): BrickResult | null {
    if (!ctx.db || !ctx.objectiveId) return null;

    const obj = getObjective(ctx.db, ctx.objectiveId);
    if (!obj) return null;

    const template = readFileSync(join(__dirname, "focus.md"), "utf-8");

    const content = obj.waiting_on
      ? template
          .replace("{{OBJECTIVE}}", obj.objective)
          .replace("{{WAITING_ON_LINE}}", `You are waiting on: ${obj.waiting_on}`)
      : template
          .replace("{{OBJECTIVE}}", obj.objective)
          .replace("\n{{WAITING_ON_LINE}}\n", "");

    return {
      name: "FOCUS",
      type: "static" as const,
      content,
      tokens: countTokens(content),
      meta: { sourcePath: join(__dirname, "focus.md") },
    };
  },
};

export default focusBrick;
