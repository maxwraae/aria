export const MODELS = {
  opus:   { name: 'Opus',   contextWindow: 1_000_000 },
  sonnet: { name: 'Sonnet', contextWindow: 200_000 },
  haiku:  { name: 'Haiku',  contextWindow: 200_000 },
} as const;

export type ModelName = keyof typeof MODELS;

/** Model specs as array, useful for rendering columns */
export const MODEL_SPECS = [
  { key: 'opus'   as ModelName, ...MODELS.opus },
  { key: 'sonnet' as ModelName, ...MODELS.sonnet },
  { key: 'haiku'  as ModelName, ...MODELS.haiku },
] as const;
