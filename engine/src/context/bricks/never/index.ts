import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { Brick, BrickContext, BrickResult } from "../../types.js";
import { countTokens } from "../../tokens.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const neverBrick: Brick = {
  name: "NEVER DO THIS",
  type: "static",
  render(_ctx: BrickContext): BrickResult {
    const sourcePath = join(__dirname, "never.md");
    const raw = readFileSync(sourcePath, "utf-8");
    const content = raw;
    return {
      name: "NEVER DO THIS",
      type: "static" as const,
      content,
      tokens: countTokens(content),
      meta: { sourcePath },
    };
  },
};

export default neverBrick;
