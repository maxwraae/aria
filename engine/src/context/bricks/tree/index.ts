import type { Brick, BrickContext, BrickResult } from "../../types.js";
import { countTokens } from "../../tokens.js";
import { getObjectiveContext } from "../../layers/objective.js";

const treeBrick: Brick = {
  name: "OBJECTIVE_TREE",
  type: "tree",
  render(ctx: BrickContext): BrickResult | null {
    if (!ctx.db || !ctx.objectiveId) return null;

    const content = getObjectiveContext(ctx.db, ctx.objectiveId);
    const tokens = countTokens(content);

    return {
      name: "OBJECTIVE_TREE",
      type: "tree" as const,
      content,
      tokens,
    };
  },
};

export default treeBrick;
