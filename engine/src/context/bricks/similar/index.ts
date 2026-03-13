import type { Brick, BrickContext, BrickResult } from "../../types.js";
import { countTokens } from "../../tokens.js";
import { getObjective, findSimilarResolved } from "../../../db/queries.js";

const similarBrick: Brick = {
  name: "SIMILAR_RESOLVED",
  type: "matched",
  render(ctx: BrickContext): BrickResult | null {
    if (!ctx.db || !ctx.objectiveId) return null;

    const obj = getObjective(ctx.db, ctx.objectiveId);
    if (!obj) return null;

    const maxResults = (ctx.config?.bricks as any)?.similar_resolved?.max_results ?? 3;
    const matches = findSimilarResolved(ctx.db, obj.objective, maxResults);
    const filtered = matches.filter((m) => m.id !== ctx.objectiveId);

    if (filtered.length === 0) return null;

    const lines: string[] = [`# SIMILAR RESOLVED OBJECTIVES`, ``];

    for (const m of filtered) {
      lines.push(`- "${m.objective}"`);
      if (m.resolution_summary) {
        lines.push(`  Resolution: ${m.resolution_summary}`);
      }
    }

    const content = lines.join("\n");
    const tokens = countTokens(content);

    return {
      name: "SIMILAR_RESOLVED",
      type: "matched" as const,
      content,
      tokens,
      meta: {
        totalMatches: filtered.length,
        matches: filtered.map((m) => ({
          label: m.objective,
          tokens: countTokens(m.resolution_summary ?? ""),
          included: true,
        })),
      },
    };
  },
};

export default similarBrick;
