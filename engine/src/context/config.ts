import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface ContextConfig {
  fill_target: {
    default: number;
    haiku: number;
    opus: number;
  };
  bricks: {
    siblings: { max_items: number; max_tokens: number };
    children: { max_detailed: number; max_oneliner: number; max_tokens: number };
    similar_resolved: { max_results: number; max_tokens: number };
    skills: { max_tokens: number };
    memories: { max_results: number; max_tokens: number };
    conversation: { per_message_max: number };
  };
}

const DEFAULT_CONFIG: ContextConfig = {
  fill_target: { default: 0.40, haiku: 0.30, opus: 0.50 },
  bricks: {
    siblings:         { max_items: 15, max_tokens: 2000 },
    children:         { max_detailed: 5, max_oneliner: 15, max_tokens: 5000 },
    similar_resolved: { max_results: 3, max_tokens: 3000 },
    skills:           { max_tokens: 3000 },
    memories:         { max_results: 20, max_tokens: 3000 },
    conversation:     { per_message_max: 1000 },
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
  budget: number,
): { warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];

  const brickTokenSums = [
    config.bricks.siblings.max_tokens,
    config.bricks.children.max_tokens,
    config.bricks.similar_resolved.max_tokens,
    config.bricks.skills.max_tokens,
    config.bricks.memories.max_tokens,
  ];

  const total = brickTokenSums.reduce((a, b) => a + b, 0);
  const pct = total / budget;

  if (pct >= 0.80) {
    errors.push(
      `Brick token caps sum to ${total} (${(pct * 100).toFixed(0)}% of budget ${budget}) — exceeds 80% threshold`,
    );
  } else if (pct >= 0.50) {
    warnings.push(
      `Brick token caps sum to ${total} (${(pct * 100).toFixed(0)}% of budget ${budget}) — exceeds 50% threshold`,
    );
  }

  return { warnings, errors };
}
