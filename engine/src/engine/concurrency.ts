import Database from "better-sqlite3";
import { getThinkingCount, getLastMaxMessageTime, getDeepWorkCount } from "../db/queries.js";
import { now } from "../db/utils.js";
import { loadEngineConfig } from './engine-config.js';

const MAX_ACTIVE_THRESHOLD = 15 * 60; // 15 minutes in seconds
const DEEP_WORK_THRESHOLD = 5; // messages in window
const DEEP_WORK_WINDOW = 300; // 5 minutes in seconds

export function isMaxActive(db: Database.Database): boolean {
  const lastMsg = getLastMaxMessageTime(db);
  if (!lastMsg) return false;
  return now() - lastMsg < MAX_ACTIVE_THRESHOLD;
}

export function isDeepWork(db: Database.Database): boolean {
  const cutoff = now() - DEEP_WORK_WINDOW;
  const count = getDeepWorkCount(db, cutoff);
  return count >= DEEP_WORK_THRESHOLD;
}

/**
 * Compute the set of objective IDs that are "max_active" — objectives in Max's
 * priority lane. An objective is max_active if:
 *   1. Max messaged it in the last 15 minutes, OR
 *   2. A max_active objective sent it a message in the last 15 minutes (transitive)
 */
export function getMaxActiveSet(db: Database.Database): Set<string> {
  const cutoff = now() - MAX_ACTIVE_THRESHOLD;

  // Step 1: Seed — objectives Max messaged recently
  const seeds = db.prepare(
    `SELECT DISTINCT objective_id FROM inbox
     WHERE sender = 'max' AND created_at >= ?`
  ).all(cutoff) as { objective_id: string }[];

  const active = new Set<string>();
  for (const row of seeds) {
    active.add(row.objective_id);
  }

  if (active.size === 0) return active;

  // Step 2+3: Propagate — find objectives that received messages FROM active objectives
  // Iterate until no new objectives are added (transitive closure bounded by 15-min window)
  let frontier = [...active];

  while (frontier.length > 0) {
    // Find all objectives that received messages from any frontier objective recently
    const placeholders = frontier.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT DISTINCT objective_id FROM inbox
       WHERE sender IN (${placeholders})
         AND created_at >= ?
         AND sender != 'max'
         AND sender != 'system'`
    ).all(...frontier, cutoff) as { objective_id: string }[];

    const newFrontier: string[] = [];
    for (const row of rows) {
      if (!active.has(row.objective_id)) {
        active.add(row.objective_id);
        newFrontier.push(row.objective_id);
      }
    }
    frontier = newFrontier;
  }

  return active;
}

export function getConcurrencyLimit(maxActiveSet: Set<string>): number {
  const config = loadEngineConfig();
  return maxActiveSet.size > 0 ? config.concurrency_active : config.concurrency_idle;
}

export function atConcurrencyLimit(db: Database.Database, machineId: string, cap?: number): boolean {
  const limit = cap ?? loadEngineConfig().concurrency_idle;
  return getThinkingCount(db, machineId) >= limit;
}

export function getAvailableSlots(db: Database.Database, machineId: string, cap?: number): number {
  const limit = cap ?? loadEngineConfig().concurrency_idle;
  return limit - getThinkingCount(db, machineId);
}
