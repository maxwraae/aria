import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { MODELS } from './models.js';

export interface ContextConfig {
  bricks: {
    siblings: { max_items: number; max_tokens: number };
    children: { max_detailed: number; max_oneliner: number; max_tokens: number };
    similar_resolved: { max_results: number; max_tokens: number };
    skills: { max_tokens: number };
    memories: { max_results: number; max_tokens: number };
    conversation: { per_message_max: number; max_tokens: number | Record<string, number> };
  };
}

const DEFAULT_CONFIG: ContextConfig = {
  bricks: {
    siblings:         { max_items: 15, max_tokens: 2000 },
    children:         { max_detailed: 5, max_oneliner: 15, max_tokens: 5000 },
    similar_resolved: { max_results: 3, max_tokens: 3000 },
    skills:           { max_tokens: 3000 },
    memories:         { max_results: 20, max_tokens: 3000 },
    conversation:     { per_message_max: 2000, max_tokens: { opus: 200000, sonnet: 80000, haiku: 80000 } },
  },
};

function configPath(): string {
  return join(homedir(), '.aria', 'context.json');
}

function ensureAriaDir(): void {
  const dir = join(homedir(), '.aria');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadConfig(): ContextConfig {
  const p = configPath();
  if (!existsSync(p)) {
    ensureAriaDir();
    writeFileSync(p, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
    return DEFAULT_CONFIG;
  }
  try {
    const raw = readFileSync(p, 'utf-8');
    return JSON.parse(raw) as ContextConfig;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: ContextConfig): void {
  ensureAriaDir();
  writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf-8');
}

export function validateCaps(
  config: ContextConfig,
): { warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];

  const smallestWindow = Math.min(
    ...Object.values(MODELS).map(m => m.contextWindow),
  );

  const convConfig = config.bricks.conversation;
  const convMax = typeof convConfig.max_tokens === 'number'
    ? convConfig.max_tokens
    : Math.min(...Object.values(convConfig.max_tokens));

  const brickTokenSums = [
    config.bricks.siblings.max_tokens,
    config.bricks.children.max_tokens,
    config.bricks.similar_resolved.max_tokens,
    config.bricks.skills.max_tokens,
    config.bricks.memories.max_tokens,
    convMax,
  ];

  const total = brickTokenSums.reduce((a, b) => a + b, 0);
  const pct = total / smallestWindow;

  if (pct >= 0.80) {
    errors.push(
      `Brick token caps sum to ${total} (${(pct * 100).toFixed(0)}% of smallest window ${smallestWindow}) — exceeds 80% threshold`,
    );
  } else if (pct >= 0.50) {
    warnings.push(
      `Brick token caps sum to ${total} (${(pct * 100).toFixed(0)}% of smallest window ${smallestWindow}) — exceeds 50% threshold`,
    );
  }

  return { warnings, errors };
}
