import { describe, expect, it } from "vitest";

import {
  composeEmbeddingText,
  embeddingBudgetMessage,
  embeddingTextError,
  embeddingSizeReport,
  MAX_EMBEDDING_BYTES,
  validateEmbeddingText,
} from "../src/index";

describe("embedding bounds", () => {
  it("accepts text at the byte cap and rejects one byte more", () => {
    const atCap = "a".repeat(MAX_EMBEDDING_BYTES);
    expect(MAX_EMBEDDING_BYTES).toBe(2000);
    expect(embeddingTextError(atCap, "Query")).toBe(undefined);
    expect(() => validateEmbeddingText(atCap, "Query")).not.toThrow();
    expect(() => validateEmbeddingText(`${atCap}a`, "Query")).toThrow(
      "Query is over by 1 bytes of 2,000.",
    );
  });

  it("measures bytes, not characters", () => {
    // 1,000 two-byte characters fit; 1,001 are two bytes over.
    expect(embeddingTextError("é".repeat(1000), "Query")).toBe(undefined);
    expect(embeddingTextError("é".repeat(1001), "Query")).toBe(
      "Query is over by 2 bytes of 2,000.",
    );
  });

  it("embeds content, tags and context, and nothing else", () => {
    expect(
      composeEmbeddingText({
        content: "body",
        tags: "area:api",
        context: "ctx",
      }),
    ).toBe("body\nTags: area:api\nContext: ctx");
    expect(
      composeEmbeddingText({ content: "body", tags: "", context: "" }),
    ).toBe("body");
  });

  it("reports each field's share of the budget", () => {
    const document = {
      content: "é".repeat(900),
      tags: "area:api",
      context: "x".repeat(200),
    };
    const report = embeddingSizeReport(document);
    // "\nTags: " is 7 bytes and "\nContext: " is 10.
    expect(report.parts).toEqual({ content: 1800, tags: 15, context: 210 });
    expect(report.bytes).toBe(
      new TextEncoder().encode(composeEmbeddingText(document)).byteLength,
    );
    expect(report).toMatchObject({
      bytes: 2025,
      max_bytes: 2000,
      within_budget: false,
      over_by_bytes: 25,
      remaining_bytes: -25,
    });
    expect(embeddingBudgetMessage("Memory", report)).toBe(
      "Memory is over by 25 bytes of 2,000: content 1,800, tags 15, context 210 bytes. Shorten it, or split it into one record per fact.",
    );
    expect(
      embeddingSizeReport({ content: "a".repeat(2000), tags: "", context: "" }),
    ).toMatchObject({ within_budget: true, remaining_bytes: 0 });
  });
});
