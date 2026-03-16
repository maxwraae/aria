import { describe, it, expect } from "vitest";
import { validateCaps } from "./config.js";
import type { ContextConfig } from "./config.js";

function makeConfig(overrides: Partial<ContextConfig["bricks"]> = {}): ContextConfig {
  return {
    bricks: {
      siblings: { max_items: 15, max_tokens: 2000 },
      children: { max_detailed: 5, max_oneliner: 15, max_tokens: 5000 },
      similar_resolved: { max_results: 3, max_tokens: 3000 },
      skills: { max_tokens: 3000 },
      memories: { max_results: 20, max_tokens: 3000 },
      conversation: { per_message_max: 2000, max_tokens: { opus: 200000, sonnet: 80000, haiku: 80000 } },
      ...overrides,
    },
  };
}

describe("validateCaps", () => {
  it("takes no budget parameter (uses smallest context window)", () => {
    // validateCaps should accept just config, no second argument
    const result = validateCaps(makeConfig());
    expect(result).toHaveProperty("warnings");
    expect(result).toHaveProperty("errors");
  });

  it("passes with default config (96K of 200K = 48%)", () => {
    // siblings(2K) + children(5K) + similar_resolved(3K) + skills(3K) + memories(3K) + conversation-min(80K) = 96K
    const { warnings, errors } = validateCaps(makeConfig());
    expect(warnings).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("warns when caps exceed 50% of smallest window", () => {
    const { warnings, errors } = validateCaps(makeConfig({
      siblings: { max_items: 15, max_tokens: 5_000 },
      children: { max_detailed: 5, max_oneliner: 15, max_tokens: 5_000 },
      similar_resolved: { max_results: 3, max_tokens: 5_000 },
      // conversation min = 80K; total = 5K+5K+5K+3K+3K+80K = 101K = ~50.5% of 200K
    }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("50%");
    expect(errors).toHaveLength(0);
  });

  it("errors when caps exceed 80% of smallest window", () => {
    const { warnings, errors } = validateCaps(makeConfig({
      siblings: { max_items: 15, max_tokens: 30_000 },
      children: { max_detailed: 5, max_oneliner: 15, max_tokens: 30_000 },
      similar_resolved: { max_results: 3, max_tokens: 20_000 },
      // conversation min = 80K; total = 30K+30K+20K+3K+3K+80K = 166K = 83% of 200K
    }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("80%");
  });
});
