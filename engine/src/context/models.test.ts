import { describe, it, expect } from "vitest";
import { MODELS, MODEL_SPECS } from "./models.js";

describe("MODELS", () => {
  it("has no fillTarget property", () => {
    for (const model of Object.values(MODELS)) {
      expect(model).not.toHaveProperty("fillTarget");
    }
  });

  it("defines context windows for all models", () => {
    expect(MODELS.opus.contextWindow).toBe(1_000_000);
    expect(MODELS.sonnet.contextWindow).toBe(200_000);
    expect(MODELS.haiku.contextWindow).toBe(200_000);
  });
});

describe("MODEL_SPECS", () => {
  it("has no budget property", () => {
    for (const spec of MODEL_SPECS) {
      expect(spec).not.toHaveProperty("budget");
    }
  });

  it("carries contextWindow from MODELS", () => {
    const opus = MODEL_SPECS.find(s => s.key === "opus");
    const sonnet = MODEL_SPECS.find(s => s.key === "sonnet");
    expect(opus?.contextWindow).toBe(1_000_000);
    expect(sonnet?.contextWindow).toBe(200_000);
  });
});
