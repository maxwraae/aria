import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { Brick, BrickContext, BrickResult } from "../../types.js";
import { countTokens } from "../../tokens.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const personaBrick: Brick = {
  name: "PERSONA",
  type: "static",
  render(_ctx: BrickContext): BrickResult {
    const raw = readFileSync(join(__dirname, "persona.md"), "utf-8");
    const content = raw;
    return {
      name: "PERSONA",
      type: "static" as const,
      content,
      tokens: countTokens(content),
      meta: { sourcePath: join(__dirname, "persona.md") },
    };
  },
};

export default personaBrick;
