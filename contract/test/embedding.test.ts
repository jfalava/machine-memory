import { describe, expect, it } from "vitest";
import {
  composeEmbeddingText,
  estimateEmbeddingTokens,
  MAX_EMBEDDING_TOKENS,
  validateEmbeddingText,
} from "../src/index";

describe("embedding bounds", () => {
  it("includes special tokens in the conservative boundary", () => {
    const text = "a".repeat(510);
    expect(estimateEmbeddingTokens(text)).toBe(MAX_EMBEDDING_TOKENS);
    expect(() => validateEmbeddingText(text, "Query")).not.toThrow();
  });

  it("rejects text over the byte upper bound", () => {
    const text = "é".repeat(256);
    expect(estimateEmbeddingTokens(text)).toBeGreaterThan(MAX_EMBEDDING_TOKENS);
    expect(() => validateEmbeddingText(text, "Document text")).toThrow(
      "Document text must be at most 512 tokens for embedding.",
    );
  });

  it("composes embedding text like the Worker", () => {
    expect(
      composeEmbeddingText({
        content: "body",
        tags: "area:api",
        context: "ctx",
        memory_type: "decision",
        status: "active",
        certainty: "verified",
      }),
    ).toBe(
      [
        "body",
        "Tags: area:api",
        "Context: ctx",
        "Memory type: decision",
        "Status: active",
        "Certainty: verified",
      ].join("\n"),
    );
  });
});
