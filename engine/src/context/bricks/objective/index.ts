import type { Brick, BrickContext, BrickResult } from "../../types.js";
import { getObjective, getTurnCount } from "../../../db/queries.js";
import { countTokens } from "../../tokens.js";

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

    const parts: string[] = [];
    parts.push(`# OBJECTIVE\n\n${obj.objective}`);

    if (obj.description) {
      parts.push(`## Description\n\n${obj.description}`);
    }

    parts.push(`## Status\n\n${statusLine}`);

    const content = parts.join("\n\n");

    return {
      name: "OBJECTIVE",
      type: "static" as const,
      content,
      tokens: countTokens(content),
    };
  },
};

export default objectiveBrick;
