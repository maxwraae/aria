import Database from 'better-sqlite3';
import {
  getPendingObjectives,
  getStuckObjectives,
  updateStatus,
  incrementFailCount,
  insertMessage,
  getReadySchedules,
  deleteSchedule,
  bumpSchedule,
} from '../db/queries.js';
import { parseInterval } from '../cli/parse-interval.js';
import { isMaxActive, atConcurrencyLimit } from './concurrency.js';
import { spawnTurn } from './spawn.js';

const POLL_INTERVAL = 5000; // 5 seconds
const STUCK_THRESHOLD = 10 * 60; // 10 minutes
const MAX_FAIL_COUNT = 3;

export function startEngine(db: Database.Database): { nudge: () => void } {
  // Recover objectives left in 'thinking' from a previous engine crash
  const staleThinking = db.prepare(
    "SELECT id FROM objectives WHERE status = 'thinking'"
  ).all() as { id: string }[];
  for (const { id } of staleThinking) {
    updateStatus(db, id, 'needs-input');
    console.log(`[engine] Recovered ${id.slice(0, 8)} from stale thinking state`);
  }

  console.log('[engine] ARIA engine started');
  console.log('[engine] Poll interval: 5s, Max concurrent: 3');
  console.log('[engine] Waiting for messages...');

  function fireReadySchedules() {
    const ready = getReadySchedules(db);
    for (const schedule of ready) {
      insertMessage(db, {
        objective_id: schedule.objective_id,
        message: schedule.message,
        sender: 'system',
        type: 'message',
      });
      console.log(`[engine] Fired schedule ${schedule.id.slice(0, 8)} → ${schedule.objective_id.slice(0, 8)}`);

      if (schedule.interval) {
        const seconds = parseInterval(schedule.interval);
        if (seconds && seconds > 0) {
          bumpSchedule(db, schedule.id, seconds);
        } else {
          deleteSchedule(db, schedule.id);
        }
      } else {
        deleteSchedule(db, schedule.id);
      }
    }
  }

  async function poll() {
    try {
      // 0. Fire any ready schedules
      fireReadySchedules();

      // 1. Get objectives with unprocessed messages
      const pending = getPendingObjectives(db);
      const maxActive = isMaxActive(db);

      for (const obj of pending) {
        if (atConcurrencyLimit(db)) break;

        // When Max is active, only run Max's messages and urgent items
        if (maxActive && !obj.urgent) {
          const hasMaxMessage = db.prepare(
            "SELECT 1 FROM inbox WHERE objective_id = ? AND turn_id IS NULL AND sender = 'max' LIMIT 1"
          ).get(obj.id);

          if (!hasMaxMessage) continue;
        }

        console.log(`[engine] Spawning turn for ${obj.id.slice(0, 8)} "${obj.objective}"`);
        spawnTurn(db, obj.id);
      }

      // 2. Recover stuck objectives (thinking > 10 min)
      const stuck = getStuckObjectives(db, STUCK_THRESHOLD);
      for (const obj of stuck) {
        const failCount = incrementFailCount(db, obj.id);
        if (failCount >= MAX_FAIL_COUNT) {
          updateStatus(db, obj.id, 'needs-input');
          insertMessage(db, {
            objective_id: obj.id,
            message: `[system] This objective has failed ${failCount} times. Needs your attention.`,
            sender: 'system',
          });
          console.log(`[engine] ${obj.id.slice(0, 8)} stuck ${failCount} times, set to needs-input`);
        } else {
          updateStatus(db, obj.id, 'idle');
          console.log(`[engine] ${obj.id.slice(0, 8)} stuck, reset to idle (fail ${failCount}/${MAX_FAIL_COUNT})`);
        }
      }
    } catch (err) {
      console.error('[engine] Poll error:', err);
    }
  }

  // Run immediately, then on interval
  poll();
  let intervalId = setInterval(poll, POLL_INTERVAL);

  function nudge(): void {
    clearInterval(intervalId);
    poll();
    intervalId = setInterval(poll, POLL_INTERVAL);
  }

  return { nudge };
}
