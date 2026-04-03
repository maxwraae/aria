import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { initMemoryTables } from "./schema.js";
import { insertMemory } from "./queries.js";
import {
  getEmbedding,
  cosineSimilarity,
  floatsToBuffer,
  bufferToFloats,
  searchVector,
  EMBED_DIMS,
} from "./embeddings.js";

// ── cosineSimilarity unit tests ────────────────────────────────────

describe("cosineSimilarity", () => {
  it("identical vectors score 1.0", () => {
    const v = [1, 2, 3, 4];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("opposite vectors score -1.0", () => {
    const a = [1, 0];
    const b = [-1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("orthogonal vectors score 0.0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 5);
  });

  it("zero vector returns 0 without throwing", () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });
});

// ── float buffer round-trip ────────────────────────────────────────

describe("float buffer serialization", () => {
  it("round-trips floats through buffer without precision loss", () => {
    const original = Array.from({ length: 16 }, (_, i) => (i + 1) * 0.1);
    const buf = floatsToBuffer(original);
    const restored = bufferToFloats(buf);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });

  it("buffer length is dims * 4 bytes", () => {
    const floats = new Array(EMBED_DIMS).fill(0.5);
    expect(floatsToBuffer(floats).length).toBe(EMBED_DIMS * 4);
  });
});

// ── Ollama integration ─────────────────────────────────────────────

describe("getEmbedding (requires Ollama running)", () => {
  it("returns a 1024-dim vector", async () => {
    const embedding = await getEmbedding("test sentence about Harvard lab safety");
    expect(embedding).toHaveLength(EMBED_DIMS);
    expect(typeof embedding[0]).toBe("number");
  }, 10000);

  it("similar texts score higher than dissimilar texts", async () => {
    const [a, b, c] = await Promise.all([
      getEmbedding("GLP certification required before lab access"),
      getEmbedding("safety training needed before entering the laboratory"),
      getEmbedding("Max enjoys hiking on weekends"),
    ]);

    const simAB = cosineSimilarity(a, b); // should be high — same topic
    const simAC = cosineSimilarity(a, c); // should be lower — unrelated

    expect(simAB).toBeGreaterThan(simAC);
  }, 30000);
});

// ── searchVector integration ───────────────────────────────────────

describe("searchVector", () => {
  it("returns top N results ranked by similarity", async () => {
    const db = new Database(":memory:");
    initMemoryTables(db);

    // Insert memories and store embeddings
    const contents = [
      "Max needs GLP certification before lab access at Harvard",
      "Harvard EHS requires online safety training before first day",
      "Max starts at Abudayyeh-Gootenberg lab in June 2026",
      "Max enjoys hiking on weekends",
      "Jenny handles admin coordination for Harvard transition",
    ];

    for (const content of contents) {
      const id = db.prepare("SELECT id FROM memories WHERE content = ?").get(content) as { id: string } | undefined;
      if (!id) {
        const embedding = await getEmbedding(content);
        const buf = floatsToBuffer(embedding);
        // Insert directly with embedding
        const newId = `test-${Math.random().toString(36).slice(2)}`;
        db.prepare("INSERT INTO memories (id, content, type, source, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
          newId, content, "world", null, buf, Math.floor(Date.now() / 1000)
        );
      }
    }

    const query = await getEmbedding("safety training requirements before lab");
    const results = searchVector(db, query, 3);

    expect(results).toHaveLength(3);
    expect(results[0].rank).toBe(1);
    // Top result should be about safety/GLP, not hiking
    expect(results[0].content).not.toContain("hiking");
    // Results should be ordered by descending similarity
    expect(results[0].similarity).toBeGreaterThanOrEqual(results[1].similarity);
    expect(results[1].similarity).toBeGreaterThanOrEqual(results[2].similarity);

    db.close();
  }, 60000);
});
