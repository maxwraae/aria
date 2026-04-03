/**
 * Claude subscription usage tracking + window scheduling.
 *
 * Two responsibilities:
 *   1. Fetch & cache usage data from the OAuth endpoint
 *   2. Maintain 5-hour windows: 03:01, 08:01, 13:01, 18:01, 23:01
 *
 * Every window gets a ping (tiny Haiku call) to anchor the 5h reset.
 * The critical one is 03:01 → resets at 08:00, fresh bucket for morning.
 *
 * Online/offline is about background process intensity, not whether
 * Aria can work. Aria is always active.
 */

import { execSync } from 'node:child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

// ── Types ────────────────────────────────────────────────────────

export interface UsageBucket {
  utilization: number;    // 0–100 percentage
  resets_at: string;      // ISO 8601
}

export interface UsageData {
  five_hour: UsageBucket | null;
  seven_day: UsageBucket | null;
  seven_day_sonnet: UsageBucket | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number;
  } | null;
  cached_at: number;      // Unix ms
}

interface UsageSettings {
  windows: string[];      // ["03:01", "08:01", ...] — all get pinged
  online_hours: { start: string; end: string };
  weekly_ceiling: number;
}

export interface WindowStatus {
  /** Current window (e.g. "08:01") */
  current_window: string;
  /** Next window (e.g. "13:01") */
  next_window: string;
  /** Expected reset hour (e.g. 13 for the 08:01 window) */
  expected_reset_hour: number;
  /** Actual reset hour from the API (or null if no data) */
  actual_reset_hour: number | null;
  /** Is the actual 5h window aligned with our target? */
  in_sync: boolean;
  /** Hours of drift (positive = resets too late, negative = too early) */
  drift_hours: number;
  /** Is Max online right now? (affects background process intensity) */
  is_online: boolean;
  /** Is the weekly ceiling hit? */
  ceiling_hit: boolean;
  /** Next ping time (ISO 8601) */
  next_ping_at: string;
}

// ── Settings ─────────────────────────────────────────────────────

const SETTINGS_PATH = path.join(os.homedir(), '.aria', 'settings.json');

function loadSettings(): UsageSettings {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed.usage;
  } catch {
    return {
      windows: ['03:01', '08:01', '13:01', '18:01', '23:01'],
      online_hours: { start: '06:00', end: '22:00' },
      weekly_ceiling: 85,
    };
  }
}

// ── Cache ────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;
let cached: UsageData | null = null;

// ── Token retrieval ──────────────────────────────────────────────

function getOAuthToken(): string | null {
  const platform = os.platform();

  if (platform === 'darwin') {
    try {
      const raw = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w',
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
      const parsed = JSON.parse(raw);
      return parsed?.claudeAiOauth?.accessToken ?? null;
    } catch {
      return null;
    }
  }

  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    const raw = fs.readFileSync(credPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

// ── Fetch usage ──────────────────────────────────────────────────

async function fetchUsage(): Promise<UsageData | null> {
  const token = getOAuthToken();
  if (!token) return null;

  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
  });

  if (!res.ok) return null;

  const data = await res.json();

  return {
    five_hour: data.five_hour ?? null,
    seven_day: data.seven_day ?? null,
    seven_day_sonnet: data.seven_day_sonnet ?? null,
    extra_usage: data.extra_usage ?? null,
    cached_at: Date.now(),
  };
}

// ── Time helpers ─────────────────────────────────────────────────

/** Parse "HH:MM" → hour */
function parseHour(s: string): number {
  return parseInt(s.split(':')[0], 10);
}

/** Parse "HH:MM" → minutes since midnight */
function parseMinutes(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

/** Minutes since midnight for a Date */
function minuteOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** Is time t (minutes) inside [start, end)? Handles overnight wrap. */
function inRange(t: number, start: number, end: number): boolean {
  if (start <= end) return t >= start && t < end;
  return t >= start || t < end;
}

/** Next occurrence of HH:MM from now */
function nextOccurrence(hhMM: string, now: Date): Date {
  const [h, m] = hhMM.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

// ── Window logic ─────────────────────────────────────────────────

export function getWindowStatus(usage: UsageData | null, now: Date = new Date()): WindowStatus {
  const settings = loadSettings();
  const nowMin = minuteOfDay(now);

  // ── Find current & next window ─────────────────────────────
  const sorted = settings.windows
    .map(w => ({ time: w, minutes: parseMinutes(w), hour: parseHour(w) }))
    .sort((a, b) => a.minutes - b.minutes);

  let currentIdx = -1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (nowMin >= sorted[i].minutes) {
      currentIdx = i;
      break;
    }
  }
  if (currentIdx === -1) currentIdx = sorted.length - 1;

  const current = sorted[currentIdx];
  const next = sorted[(currentIdx + 1) % sorted.length];

  // ── Expected reset hour ────────────────────────────────────
  const expectedResetHour = (current.hour + 5) % 24;

  // ── Actual reset hour from API ─────────────────────────────
  let actualResetHour: number | null = null;
  let inSync = false;
  let driftHours = 0;

  if (usage?.five_hour?.resets_at) {
    const actualReset = new Date(usage.five_hour.resets_at);
    actualResetHour = actualReset.getHours();
    inSync = actualResetHour === expectedResetHour;
    driftHours = actualResetHour - expectedResetHour;
    if (driftHours > 12) driftHours -= 24;
    if (driftHours < -12) driftHours += 24;
  }

  // ── Online/offline ─────────────────────────────────────────
  const onlineStart = parseMinutes(settings.online_hours.start);
  const onlineEnd = parseMinutes(settings.online_hours.end);
  const isOnline = inRange(nowMin, onlineStart, onlineEnd);

  // ── Weekly ceiling ─────────────────────────────────────────
  const ceilingHit = (usage?.seven_day?.utilization ?? 0) >= settings.weekly_ceiling;

  // ── Next ping = next window ────────────────────────────────
  const nextPingAt = nextOccurrence(next.time, now).toISOString();

  return {
    current_window: current.time,
    next_window: next.time,
    expected_reset_hour: expectedResetHour,
    actual_reset_hour: actualResetHour,
    in_sync: inSync,
    drift_hours: driftHours,
    is_online: isOnline,
    ceiling_hit: ceilingHit,
    next_ping_at: nextPingAt,
  };
}

// ── Window ping ──────────────────────────────────────────────────

let lastPingWindow: string | null = null;

/**
 * Tiny Haiku call to anchor the 5h window. Fires once per window.
 * Returns true if a ping was sent, false if skipped (already pinged
 * this window or not within the first 2 minutes of a window).
 */
export async function maybePing(now: Date = new Date()): Promise<boolean> {
  const settings = loadSettings();
  const nowMin = minuteOfDay(now);

  const sorted = settings.windows
    .map(w => ({ time: w, minutes: parseMinutes(w) }))
    .sort((a, b) => a.minutes - b.minutes);

  // Check each window: are we within 2 minutes of any window start?
  // (handles overnight wrap — at 03:01 we want the 03:01 window, not 23:01)
  let target: typeof sorted[0] | null = null;
  for (const w of sorted) {
    const diff = nowMin - w.minutes;
    // diff in [0, 2] means we're 0–2 minutes past this window's start
    if (diff >= 0 && diff <= 2) {
      target = w;
      break;
    }
  }
  if (!target) return false;

  // Don't ping the same window twice
  if (lastPingWindow === target.time) return false;
  lastPingWindow = target.time;

  // Fire a tiny Haiku call — let it complete so it registers as usage
  const { spawn } = await import('node:child_process');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');

  return new Promise((resolve) => {
    const claudePath = process.env.CLAUDE_PATH ?? join(homedir(), '.local', 'bin', 'claude');

    const proc = spawn(claudePath, [
      '-p', 'ping',
      '--model', 'haiku',
      '--max-turns', '1',
      '--dangerously-skip-permissions',
    ], {
      env: { ...process.env, CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: '' },
      cwd: process.env.HOME,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdin?.end();

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      console.log(`[usage] Window ping ${target!.time} timed out`);
      resolve(false);
    }, 30_000);

    proc.on('close', () => {
      clearTimeout(timer);
      console.log(`[usage] Window ping ${target!.time} — anchored 5h window`);
      resolve(true);
    });

    proc.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// ── Public API ───────────────────────────────────────────────────

export async function getUsage(): Promise<UsageData | null> {
  if (cached && Date.now() - cached.cached_at < CACHE_TTL_MS) {
    return cached;
  }

  try {
    const fresh = await fetchUsage();
    if (fresh) cached = fresh;
    return cached;
  } catch {
    return cached;
  }
}

export async function getFullStatus(): Promise<{
  usage: UsageData | null;
  window: WindowStatus;
  settings: UsageSettings;
}> {
  const usage = await getUsage();
  const window = getWindowStatus(usage);
  const settings = loadSettings();
  return { usage, window, settings };
}
