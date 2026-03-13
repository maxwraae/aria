import type { Brick, BrickContext, BrickResult } from "../../types.js";
import { countTokens } from "../../tokens.js";

const environmentBrick: Brick = {
  name: "ENVIRONMENT",
  type: "static",
  render(_ctx: BrickContext): BrickResult {
    const now = new Date();
    const date = now.toISOString().split("T")[0];
    const time = now.toTimeString().slice(0, 5);

    const content = `# ENVIRONMENT

Date: ${date}
Time: ${time}
Machine: MacBook Pro M4, ~/aria as working root
Objective DB: ~/.aria/objectives.db`;

    return {
      name: "ENVIRONMENT",
      type: "static" as const,
      content,
      tokens: countTokens(content),
      meta: {},
    };
  },
};

export default environmentBrick;
