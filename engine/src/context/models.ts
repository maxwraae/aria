export const MODELS = {
  opus:   { name: 'Opus',   contextWindow: 1_000_000, fillTarget: 0.50 },
  sonnet: { name: 'Sonnet', contextWindow: 200_000,   fillTarget: 0.40 },
  haiku:  { name: 'Haiku',  contextWindow: 200_000,   fillTarget: 0.30 },
} as const;

export type ModelName = keyof typeof MODELS;

export const BUDGETS = {
  opus:   MODELS.opus.contextWindow   * MODELS.opus.fillTarget,
  sonnet: MODELS.sonnet.contextWindow * MODELS.sonnet.fillTarget,
  haiku:  MODELS.haiku.contextWindow  * MODELS.haiku.fillTarget,
} as const;

/** Model specs as array, useful for rendering columns */
export const MODEL_SPECS = [
  { key: 'opus'   as ModelName, ...MODELS.opus,   budget: BUDGETS.opus },
  { key: 'sonnet' as ModelName, ...MODELS.sonnet,  budget: BUDGETS.sonnet },
  { key: 'haiku'  as ModelName, ...MODELS.haiku,   budget: BUDGETS.haiku },
] as const;
