import type { Brick, BrickContext, BrickResult } from "../../types.js";
import { getObjective } from "../../../db/queries.js";
import { countTokens } from "../../tokens.js";

const focusBrick: Brick = {
  name: "FOCUS",
  type: "static",
  render(ctx: BrickContext): BrickResult | null {
    if (!ctx.db || !ctx.objectiveId) return null;

    const obj = getObjective(ctx.db, ctx.objectiveId);
    if (!obj) return null;

    const lines: string[] = [];
    lines.push('---');
    lines.push('');
    lines.push('## Now make your objective true');
    lines.push('');
    lines.push(`Your objective is: **${obj.objective}**`);
    lines.push('');
    if (obj.waiting_on) {
      lines.push(`You are waiting on: ${obj.waiting_on}`);
      lines.push('');
    }
    lines.push('**Do I have the knowledge to act?** Write down your honest answer. What do you know? What don\'t you know? Can you connect what you know to a concrete step forward?');
    lines.push('');
    lines.push('**What is the highest-value action to move closer to my objective becoming true?** Given your answer above, what should you do right now?');

    const content = lines.join('\n');

    return {
      name: "FOCUS",
      type: "static" as const,
      content,
      tokens: countTokens(content),
    };
  },
};

export default focusBrick;
