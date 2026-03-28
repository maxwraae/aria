import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { execSync } from 'child_process';
import {
  getPendingObjectives,
  getStuckObjectives,
  getStaleObjectives,
  updateStatus,
  cascadeAbandon,
  incrementFailCount,
  insertMessage,
  getObjective,
  getReadySchedules,
  deleteSchedule,
  bumpSchedule,
  syncFromPeer,
  hasUnprocessedMaxMessage,
} from '../db/queries.js';
import { getMachineId } from '../db/node.js';
import { generateId } from '../db/utils.js';
import { parseInterval } from '../cli/parse-interval.js';
import { getMaxActiveSet, getConcurrencyLimit, atConcurrencyLimit } from './concurrency.js';
import { spawnTurn } from './spawn.js';

const POLL_INTERVAL = 1000; // 1 second
const STUCK_THRESHOLD = 30 * 60; // 30 minutes
const MAX_FAIL_COUNT = 2;
const PRUNE_INTERVAL = 60 * 60; // 1 hour between prune sweeps
const STALE_THRESHOLD_DAYS = 14;
const BACKUP_CHECK_INTERVAL = 60 * 60; // 1 hour between backup health checks
const BACKUP_MAX_AGE_HOURS = 25;

let lastPruneTime = 0;
let lastBackupCheckTime = 0;

export function startEngine(db: Database.Database): () => void {
  const machineId = getMachineId();
  console.log(`[engine] Machine: ${machineId}`);

  // Recover objectives left in 'thinking' from a previous engine crash
  const staleThinking = db.prepare(
    "SELECT id FROM objectives WHERE status = 'thinking'"
  ).all() as { id: string }[];
  for (const { id } of staleThinking) {
    updateStatus(db, id, 'needs-input');
    console.log(`[engine] Recovered ${id.slice(0, 8)} from stale thinking state`);
  }

  console.log('[engine] ARIA engine started');
  console.log('[engine] Poll interval: 1s, Max concurrent: 3');
  console.log('[engine] Waiting for messages...');

  function fireReadySchedules() {
    const ready = getReadySchedules(db);
    for (const schedule of ready) {
      insertMessage(db, {
        objective_id: schedule.objective_id,
        message: schedule.message,
        sender: 'system',
        type: 'message',
        cascade_id: generateId(),
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

  function pruneStale() {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds - lastPruneTime < PRUNE_INTERVAL) return;
    lastPruneTime = nowSeconds;

    const thresholdSeconds = STALE_THRESHOLD_DAYS * 24 * 60 * 60;
    const staleIds = getStaleObjectives(db, thresholdSeconds);
    for (const id of staleIds) {
      updateStatus(db, id, 'abandoned');
      cascadeAbandon(db, id);
      console.log(`[engine] Pruned stale objective ${id.slice(0, 8)}`);
    }
    if (staleIds.length > 0) {
      console.log(`[engine] Pruned ${staleIds.length} stale objective(s)`);
    }
  }

  function checkBackupHealth() {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds - lastBackupCheckTime < BACKUP_CHECK_INTERVAL) return;
    lastBackupCheckTime = nowSeconds;

    const statusPath = `${homedir()}/.aria/backup-status.json`;
    if (!existsSync(statusPath)) {
      console.log('[engine] Backup status file not found — skipping health check');
      return;
    }

    try {
      const raw = readFileSync(statusPath, 'utf-8');
      const status = JSON.parse(raw);

      if (!status.success) {
        console.warn('[engine] ⚠ Last backup failed:', status.error || 'unknown error');
      }

      const ageHours = (Date.now() - new Date(status.timestamp).getTime()) / (1000 * 60 * 60);
      if (ageHours > BACKUP_MAX_AGE_HOURS) {
        console.warn(`[engine] ⚠ Backup is ${Math.round(ageHours)}h old (threshold: ${BACKUP_MAX_AGE_HOURS}h)`);
      }
    } catch (err) {
      console.warn('[engine] Failed to read backup status:', err);
    }
  }

  function processQueue() {
    const pending = getPendingObjectives(db);
    const maxActiveSet = getMaxActiveSet(db);
    const cap = getConcurrencyLimit(maxActiveSet);

    const myPending = pending.filter(obj => {
      if (!obj.machine) return machineId === 'mini';
      return obj.machine === machineId;
    });

    const maxDirect: typeof myPending = [];
    const autonomous: typeof myPending = [];
    for (const obj of myPending) {
      if (hasUnprocessedMaxMessage(db, obj.id)) {
        maxDirect.push(obj);
      } else {
        autonomous.push(obj);
      }
    }

    for (const obj of maxDirect) {
      console.log(`[engine] Spawning turn for ${obj.id.slice(0, 8)} "${obj.objective}" (max-direct, bypasses cap)`);
      spawnTurn(db, obj.id);
    }

    autonomous.sort((a, b) => {
      const aActive = maxActiveSet.has(a.id) ? 1 : 0;
      const bActive = maxActiveSet.has(b.id) ? 1 : 0;
      if (bActive !== aActive) return bActive - aActive;
      if (b.urgent !== a.urgent) return b.urgent - a.urgent;
      if (b.important !== a.important) return b.important - a.important;
      return a.created_at - b.created_at;
    });

    for (const obj of autonomous) {
      if (atConcurrencyLimit(db, machineId, cap)) break;
      console.log(`[engine] Spawning turn for ${obj.id.slice(0, 8)} "${obj.objective}"`);
      spawnTurn(db, obj.id);
    }
  }

  async function poll() {
    try {
      // Sync objectives, inbox, and turns from peer database
      syncFromPeer(db);

      // 1. Fire any ready schedules
      fireReadySchedules();

      // 1.5. Prune stale idle objectives (runs once per hour)
      pruneStale();

      // 1.6. Check backup health (runs once per hour)
      checkBackupHealth();

      // 2. Process pending messages and spawn turns
      processQueue();

      // 3. Recover stuck objectives (thinking > 30 min)
      const stuck = getStuckObjectives(db, STUCK_THRESHOLD);
      for (const obj of stuck) {
        const failCount = incrementFailCount(db, obj.id);
        if (failCount >= MAX_FAIL_COUNT) {
          updateStatus(db, obj.id, 'needs-input');

          // Fetch latest state to get last_error context
          const latest = getObjective(db, obj.id);
          const lastError = latest?.last_error ?? '';
          const errorSnippet = lastError
            ? lastError.slice(0, 300).replace(/\n/g, ' ').trim()
            : 'No diagnostic info captured.';

          insertMessage(db, {
            objective_id: obj.id,
            message: `[system] This objective has failed ${failCount} times and needs your attention.\n\nLast error: ${errorSnippet}`,
            sender: 'system',
            cascade_id: generateId(),
          });
          console.log(`[engine] ${obj.id.slice(0, 8)} stuck ${failCount} times, set to needs-input`);

          // Notify Max via aria notify
          try {
            const shortId = obj.id.slice(0, 8);
            const name = obj.objective.slice(0, 60);
            const notifyMsg = `"${name}" (${shortId}) stuck after ${failCount} failures. ${errorSnippet.slice(0, 120)}`;
            execSync(`aria notify ${JSON.stringify(notifyMsg)} --important --urgent`, { timeout: 10000 });
            console.log(`[engine] Notified Max about stuck objective ${shortId}`);
          } catch (notifyErr) {
            console.error('[engine] aria notify failed:', notifyErr);
          }
        } else {
          updateStatus(db, obj.id, 'idle');
          console.log(`[engine] ${obj.id.slice(0, 8)} stuck, reset to idle (fail ${failCount}/${MAX_FAIL_COUNT})`);
        }
      }
    } catch (err) {
      console.error('[engine] Poll error:', err);
    }
  }

  // Nudge: instantly process queue when server inserts a message
  let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  function nudge(): void {
    if (nudgeTimer) return;
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      try { processQueue(); }
      catch (err) { console.error('[engine] Nudge error:', err); }
    }, 50);
  }

  // Run immediately, then on interval
  poll();
  setInterval(poll, POLL_INTERVAL);
  return nudge;
}
