/**
 * MEMORY BRICK
 *
 * Retrieves memories relevant to the current objective from the memories database
 * and injects them into the agent's context.
 *
 * Database: ~/Library/Mobile Documents/com~apple~CloudDocs/Aria/data/memories.db
 * (separate from the main engine DB — written by the Python extraction pipeline)
 *
 * Extraction pipeline format (memory/extract/FLOW.md):
 *   - content: free-text string extracted from Claude Code conversation sessions
 *   - type: "world" (general knowledge/observations about Max's world)
 *   - source: "session:<filename>" — the .jsonl session file it came from
 *   - created_at: Unix timestamp from the session file's mtime (accurate to original date)
 *
 * Relevance scoring (from memory/queries.ts searchMemories):
 *   score = BM25 * 0.7 + recency_decay * 0.3
 *   where recency_decay uses a 30-day half-life (2592000 seconds)
 *
 * Config keys (context.json → bricks.memories):
 *   max_tokens: number   — token budget for this brick (default 3000)
 *   max_results: number  — max memories to retrieve from DB (default 20)
 *
 * Token budget: memories are included in relevance order until the token cap is hit.
 * The brick returns null if the memories DB doesn't exist or returns no matches.
 */

import os from "os";
import path from "path";
import fs from "fs";
import Database from "better-sqlite3";
import type { Brick, BrickContext, BrickResult } from "../../types.js";
import { countTokens } from "../../tokens.js";
import { searchMemories, type MemorySearchResult } from "../../../memory/queries.js";

export const MEMORIES_DB_PATH = path.join(
  os.homedir(),
  "Library",
  "Mobile Documents",
  "com~apple~CloudDocs",
  "Aria",
  "data",
  "memories.db"
);

const DEFAULT_MAX_TOKENS = 3000;
const DEFAULT_MAX_RESULTS = 20;

/**
 * Open a connection to a memories DB file.
 * Returns null if the file doesn't exist.
 * Exported so tests can inject a path to an in-memory / temp DB.
 */
export function openMemoriesDb(dbPath: string = MEMORIES_DB_PATH): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

/**
 * Build a keyword query string for FTS5 from objective text.
 * Strips punctuation, takes the first 12 words >= 3 chars,
 * and joins with OR so partial matches are included.
 */
export function buildFtsQuery(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);

  if (words.length === 0) return "";

  // Escape FTS5 special characters and quote each term
  const escaped = words.slice(0, 12).map((w) => `"${w.replace(/"/g, '""')}"`);
  return escaped.join(" OR ");
}

const memoryBrick: Brick = {
  name: "MEMORIES",
  type: "matched",

  render(ctx: BrickContext): BrickResult | null {
    if (!ctx.db || !ctx.objectiveId) return null;

    // Get the objective text to use as the search query
    const obj = (ctx.db as Database.Database)
      .prepare("SELECT objective FROM objectives WHERE id = ?")
      .get(ctx.objectiveId) as { objective: string } | undefined;

    if (!obj?.objective) return null;

    const ftsQuery = buildFtsQuery(obj.objective);
    if (!ftsQuery) return null;

    // Open memories DB (separate file from main engine DB)
    const memoriesDb = openMemoriesDb();
    if (!memoriesDb) return null;

    // Config — follows the same pattern as other bricks
    const brickConf = (ctx.config as Record<string, unknown>);
    const memoriesConf = (brickConf?.bricks as Record<string, unknown>)?.memories as Record<string, number> | undefined;
    const maxTokens = memoriesConf?.max_tokens ?? DEFAULT_MAX_TOKENS;
    const maxResults = memoriesConf?.max_results ?? DEFAULT_MAX_RESULTS;

    let results: MemorySearchResult[];
    try {
      results = searchMemories(memoriesDb, ftsQuery, maxResults);
    } catch {
      // FTS table may not exist yet or query may fail — degrade gracefully
      return null;
    } finally {
      memoriesDb.close();
    }

    if (results.length === 0) return null;

    // Format memories, respecting token budget
    const header = `# RELEVANT MEMORIES\n`;
    let usedTokens = countTokens(header);
    const lines: string[] = [];
    const metaMatches: Array<{ label: string; tokens: number; included: boolean }> = [];

    for (const r of results) {
      const date = new Date(r.created_at * 1000).toISOString().slice(0, 10);
      const line = `- [${date}] ${r.content}`;
      const lineTokens = countTokens(line);

      const wouldFit = usedTokens + lineTokens <= maxTokens;
      metaMatches.push({
        label: r.content.slice(0, 60),
        tokens: lineTokens,
        included: wouldFit,
      });

      if (wouldFit) {
        lines.push(line);
        usedTokens += lineTokens;
      }
    }

    if (lines.length === 0) return null;

    const content = header + "\n" + lines.join("\n");
    const tokens = countTokens(content);

    return {
      name: "MEMORIES",
      type: "matched" as const,
      content,
      tokens,
      meta: {
        totalMatches: results.length,
        matches: metaMatches,
      },
    };
  },
};

export default memoryBrick;
