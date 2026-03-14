import { describe, it, expect } from "vitest";
import { assembleContext } from "./assembler.js";
import type { Brick, BrickContext, BrickResult } from "./types.js";

function fakeBrick(name: string, content: string): Brick {
  return {
    name,
    type: "static",
    render(_ctx: BrickContext): BrickResult {
      return {
        name,
        type: "static",
        content,
        tokens: Math.ceil(content.length / 4),
      };
    },
  };
}

function nullBrick(name: string): Brick {
  return {
    name,
    type: "static",
    render(_ctx: BrickContext): BrickResult | null {
      return null;
    },
  };
}

describe("assembleContext", () => {
  it("assembles multiple bricks in order", () => {
    const bricks = [
      fakeBrick("A", "Section A content"),
      fakeBrick("B", "Section B content"),
    ];
    const result = assembleContext(bricks);

    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].name).toBe("A");
    expect(result.sections[1].name).toBe("B");
    expect(result.content).toContain("Section A content");
    expect(result.content).toContain("---");
    expect(result.content).toContain("Section B content");
  });

  it("skips bricks that return null", () => {
    const bricks = [
      fakeBrick("A", "Content A"),
      nullBrick("SKIP"),
      fakeBrick("C", "Content C"),
    ];
    const result = assembleContext(bricks);

    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].name).toBe("A");
    expect(result.sections[1].name).toBe("C");
  });

  it("sums tokens correctly", () => {
    const bricks = [
      fakeBrick("A", "abcd"),     // 4 chars = 1 token
      fakeBrick("B", "abcdefgh"), // 8 chars = 2 tokens
    ];
    const result = assembleContext(bricks);

    expect(result.totalTokens).toBe(3);
  });

  it("returns empty result for no bricks", () => {
    const result = assembleContext([]);

    expect(result.sections).toHaveLength(0);
    expect(result.totalTokens).toBe(0);
    expect(result.content).toBe("");
  });

  it("uses default budget of 80000", () => {
    let capturedBudget = 0;
    const spy: Brick = {
      name: "SPY",
      type: "static",
      render(ctx: BrickContext): BrickResult | null {
        capturedBudget = ctx.budget;
        return null;
      },
    };
    assembleContext([spy]);
    expect(capturedBudget).toBe(80_000);
  });

  it("passes custom context through", () => {
    let capturedId: string | null = null;
    const spy: Brick = {
      name: "SPY",
      type: "static",
      render(ctx: BrickContext): BrickResult | null {
        capturedId = ctx.objectiveId;
        return null;
      },
    };
    assembleContext([spy], { objectiveId: "test-123" });
    expect(capturedId).toBe("test-123");
  });
});
