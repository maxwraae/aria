import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface EngineConfig {
  concurrency_idle: number;
  concurrency_active: number;
  max_autonomous_depth: number;
  max_children: number;
  max_fail_count: number;
  stuck_threshold_seconds: number;
  stale_threshold_days: number;
  cascade_turn_limit: number;
}

const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  concurrency_idle: 3,
  concurrency_active: 10,
  max_autonomous_depth: 5,
  max_children: 10,
  max_fail_count: 2,
  stuck_threshold_seconds: 600,
  stale_threshold_days: 14,
  cascade_turn_limit: 20,
};

function engineConfigPath(): string {
  return join(homedir(), '.aria', 'engine.json');
}

function ensureAriaDir(): void {
  const dir = join(homedir(), '.aria');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadEngineConfig(): EngineConfig {
  const p = engineConfigPath();
  if (!existsSync(p)) {
    ensureAriaDir();
    writeFileSync(p, JSON.stringify(DEFAULT_ENGINE_CONFIG, null, 2), 'utf-8');
    return { ...DEFAULT_ENGINE_CONFIG };
  }
  try {
    const raw = readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    // Merge with defaults so new fields get picked up
    return { ...DEFAULT_ENGINE_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_ENGINE_CONFIG };
  }
}

export function saveEngineConfig(config: EngineConfig): void {
  ensureAriaDir();
  writeFileSync(engineConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
}
