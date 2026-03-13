import Database from "better-sqlite3";
import { getThinkingCount, getLastMaxMessageTime, getDeepWorkCount } from "../db/queries.js";
import { now } from "../db/utils.js";

const MAX_CONCURRENT = 3;
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

export function atConcurrencyLimit(db: Database.Database): boolean {
  return getThinkingCount(db) >= MAX_CONCURRENT;
}

export function getAvailableSlots(db: Database.Database): number {
  return MAX_CONCURRENT - getThinkingCount(db);
}
