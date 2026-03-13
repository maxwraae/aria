import Database from "better-sqlite3";
import { getObjective, findSimilarResolved } from "../../db/queries.js";

export function getSimilarResolvedContext(
  db: Database.Database,
  objectiveId: string
): string {
  const obj = getObjective(db, objectiveId);
  if (!obj) return "";

  const matches = findSimilarResolved(db, obj.objective, 3);
  // Filter out self (in case objective is already resolved)
  const filtered = matches.filter((m) => m.id !== objectiveId);
  if (filtered.length === 0) return "";

  const lines: string[] = [`# SIMILAR RESOLVED OBJECTIVES`, ``];

  for (const m of filtered) {
    lines.push(`- "${m.objective}"`);
    if (m.resolution_summary) {
      lines.push(`  Resolution: ${m.resolution_summary}`);
    }
  }

  return lines.join("\n");
}
