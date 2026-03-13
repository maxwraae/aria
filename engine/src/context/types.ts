import type Database from "better-sqlite3";

export interface Brick {
  name: string;
  type: 'static' | 'tree' | 'matched' | 'flex';
  render(ctx: BrickContext): BrickResult | null;
}

export interface BrickContext {
  db: Database.Database | null;
  objectiveId: string | null;
  budget: number;
  config: Record<string, unknown>;
}

export interface BrickMeta {
  // Static bricks
  sourcePath?: string;          // path to editable source file

  // Tree bricks
  config?: Record<string, number>;  // e.g. { max_detailed: 5, max_tokens: 5000 }
  condition?: string;               // e.g. "12 active children"
  conditionMet?: boolean;

  // Matched bricks
  matches?: Array<{ label: string; tokens: number; included: boolean }>;
  totalMatches?: number;

  // Flex (conversation)
  totalMessages?: number;
  messagesFit?: number;
  oldestIncluded?: string;       // date string
  truncatedCount?: number;
}

export interface BrickResult {
  name: string;
  type: 'static' | 'tree' | 'matched' | 'flex';
  content: string;
  tokens: number;
  meta?: BrickMeta;
}
