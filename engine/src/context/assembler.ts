import type { Brick, BrickContext, BrickResult } from "./types.js";
import { MODELS } from "./models.js";

export interface AssemblyResult {
  sections: BrickResult[];
  totalTokens: number;
  content: string;
}

const DEFAULT_BUDGET = MODELS.sonnet.contextWindow;

export function assembleContext(
  bricks: Brick[],
  ctx: Partial<BrickContext> = {}
): AssemblyResult {
  const fullCtx: BrickContext = {
    db: ctx.db ?? null,
    objectiveId: ctx.objectiveId ?? null,
    budget: ctx.budget ?? DEFAULT_BUDGET,
    config: ctx.config ?? {},
    memoryEmbeddings: ctx.memoryEmbeddings ?? null,
  };

  const sections: BrickResult[] = [];
  let totalTokens = 0;

  for (const brick of bricks) {
    const result = brick.render(fullCtx);
    if (result) {
      sections.push({ ...result, type: brick.type });
      totalTokens += result.tokens;
    }
  }

  const content = sections.map(s => s.content).join("\n\n---\n\n");

  return { sections, totalTokens, content };
}
