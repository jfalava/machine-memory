import { describe, expect, it } from "vitest";
import {
  estimateEmbeddingTokens,
  MAX_EMBEDDING_TOKENS,
  validateEmbeddingText,
} from "../../remote-db/cloudflare/src/embedding";

describe("embedding input bounds", () => {
  it("includes special tokens in the exact conservative boundary", () => {
    const text = "a".repeat(510);

    expect(estimateEmbeddingTokens(text)).toBe(MAX_EMBEDDING_TOKENS);
    expect(() => validateEmbeddingText(text, "Query")).not.toThrow();
  });

  it("rejects fragmented text as soon as it crosses the boundary", () => {
    const atLimit = "a ".repeat(255);
    const overLimit = `${atLimit}a`;

    expect(() => validateEmbeddingText(atLimit, "Query")).not.toThrow();
    expect(() => validateEmbeddingText(overLimit, "Query")).toThrow(
      "Query must be at most 512 tokens for embedding.",
    );
  });

  it("rejects multibyte text that exceeds the byte upper bound", () => {
    const text = "é".repeat(256);

    expect(estimateEmbeddingTokens(text)).toBeGreaterThan(MAX_EMBEDDING_TOKENS);
    expect(() => validateEmbeddingText(text, "Document text")).toThrow(
      "Document text must be at most 512 tokens for embedding.",
    );
  });
});
