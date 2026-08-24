import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { Tokenizer } from "@huggingface/tokenizers";
import {
  analyzeBgeEmbeddingWith,
  analyzeEmbeddingByBytes,
  bgeEmbeddingLimitMessage,
  BGE_MAX_EMBEDDING_TOKENS,
  estimateEmbeddingBytes,
  sliceUtf8Safe,
  type EmbeddingTextPart,
} from "@/effect/bge-tokenizer";
import {
  embeddingSizeReport,
  measureEmbeddingFit,
} from "@/cli/features/memory/size-report";
import { tokenizerJson, tokenizerConfig } from "./fixtures/tokenizer";

const parts: EmbeddingTextPart[] = [
  { part: "content", text: "hello" },
  { part: "tags", text: "" },
  { part: "context", text: "" },
  { part: "memory_type", text: "Memory type: convention" },
  { part: "status", text: "Status: active" },
  { part: "certainty", text: "Certainty: inferred" },
];

describe("sliceUtf8Safe", () => {
  it("returns short text untouched", () => {
    expect(sliceUtf8Safe("hello", 100)).toBe("hello");
    expect(sliceUtf8Safe("hello", 5)).toBe("hello");
  });

  it("cuts ASCII at the exact byte budget", () => {
    expect(sliceUtf8Safe("hello world", 5)).toBe("hello");
  });

  it("never splits a multibyte character", () => {
    const text = "éééé"; // 8 UTF-8 bytes
    expect(sliceUtf8Safe(text, 7)).toBe("ééé");
    expect(sliceUtf8Safe(text, 2)).toBe("é");
    expect(sliceUtf8Safe(text, 1)).toBe("");
  });

  it("handles empty and non-positive budgets", () => {
    expect(sliceUtf8Safe("", 10)).toBe("");
    expect(sliceUtf8Safe("hello", 0)).toBe("");
    expect(sliceUtf8Safe("hello", -3)).toBe("");
  });
});

describe("size estimation: token vs byte binding", () => {
  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);

  it("reports a combined binding when both limits blow", () => {
    // 600 x "hello": every word is a known vocab entry. Tokens blow past 512
    // and so do bytes (each token costs at least one byte), so both bind and
    // the suggestion falls back to the precise byte truncation.
    const content = Array.from({ length: 600 }, () => "hello").join(" ");
    const breakdown = analyzeBgeEmbeddingWith(tokenizer, [
      ...parts.filter((entry) => entry.part !== "content"),
      { part: "content", text: content },
    ]);

    expect(breakdown.total_tokens).toBeGreaterThanOrEqual(
      BGE_MAX_EMBEDDING_TOKENS,
    );
    expect(breakdown.over_by_tokens).toBeGreaterThan(0);
    expect(breakdown.over_by_bytes).toBeGreaterThan(0);
    expect(breakdown.binding_limit).toBe("both");
    expect(breakdown.largest_part).toEqual({
      part: "content",
      amount: expect.any(Number),
      unit: "tokens",
    });
    expect(breakdown.trimmed_suggestion).toMatch(
      /truncating content to ~\d+ bytes makes the byte\+2 estimate fit/,
    );
  });

  it("reports the byte estimate as binding when tokens fit", () => {
    // Accented characters normalize to [UNK] one per character: ~256 tokens
    // (fits) but 512 content bytes -> byte+2 estimate over 512.
    const content = "é".repeat(256);
    const breakdown = analyzeBgeEmbeddingWith(tokenizer, [
      ...parts.filter((entry) => entry.part !== "content"),
      { part: "content", text: content },
    ]);

    expect(breakdown.over_by_tokens).toBe(0);
    expect(breakdown.over_by_bytes).toBeGreaterThan(0);
    expect(breakdown.binding_limit).toBe("bytes");
    expect(breakdown.over_by).toBe(breakdown.over_by_bytes);
    const message = bgeEmbeddingLimitMessage(breakdown, "Memory");
    expect(message).toContain("the token count itself fits");
    expect(message).not.toContain("Both limits bind");
  });

  it("stays silent about advice when within budget", () => {
    const breakdown = analyzeBgeEmbeddingWith(tokenizer, parts);

    expect(breakdown.within_limit).toBe(true);
    expect(breakdown.binding_limit).toBeNull();
    expect(breakdown.over_by_tokens).toBe(0);
    expect(breakdown.over_by_bytes).toBe(0);
    expect(breakdown.largest_part).toBeUndefined();
    expect(breakdown.trimmed_suggestion).toBeUndefined();
  });

  it("derives an exact byte truncation for the byte-bound fallback path", () => {
    const content = Array.from({ length: 200 }, () => "hello").join(" ");
    const overParts: EmbeddingTextPart[] = [
      ...parts.filter((entry) => entry.part !== "content"),
      { part: "content", text: content },
    ];
    const fallback = analyzeEmbeddingByBytes(overParts);

    expect(fallback.source).toBe("bytes");
    expect(fallback.within_limit).toBe(false);
    expect(fallback.binding_limit).toBe("bytes");
    expect(fallback.largest_part).toEqual({
      part: "content",
      amount: new TextEncoder().encode(content).byteLength,
      unit: "bytes",
    });

    // The suggested truncation must actually satisfy the byte+2 estimate.
    const suggestion = fallback.trimmed_suggestion ?? "";
    const match = suggestion.match(/~(\d+) bytes/);
    expect(match).toBeTruthy();
    const keptBytes = Number(match?.[1]);
    const keptContent = sliceUtf8Safe(content, keptBytes);
    const composed = [
      keptContent,
      "Memory type: convention",
      "Status: active",
      "Certainty: inferred",
    ].join("\n");
    expect(estimateEmbeddingBytes(composed)).toBeLessThanOrEqual(
      BGE_MAX_EMBEDDING_TOKENS,
    );
  });
});

describe("embeddingSizeReport", () => {
  it("marks pass/fail per limit and names the binding constraint", async () => {
    const okParts: EmbeddingTextPart[] = [
      { part: "content", text: "tiny" },
      ...parts.slice(1),
    ];
    const report = embeddingSizeReport(
      await Effect.runPromise(measureEmbeddingFit(okParts)),
    );

    expect(report.within_budget).toBe(true);
    expect(report.binding_limit).toBeNull();
    const limits = report.limits as Record<
      string,
      { pass: boolean; value: number }
    >;
    expect(limits.tokens?.pass).toBe(true);
    expect(limits.bytes_estimate?.pass).toBe(true);

    const overParts: EmbeddingTextPart[] = [
      { part: "content", text: "é".repeat(400) },
      ...parts.slice(1),
    ];
    const overReport = embeddingSizeReport(
      await Effect.runPromise(measureEmbeddingFit(overParts)),
    );
    expect(overReport.within_budget).toBe(false);
    expect(overReport.binding_limit).toBe("bytes");
    const overLimits = overReport.limits as Record<string, { pass: boolean }>;
    expect(overLimits.tokens?.pass).toBe(true);
    expect(overLimits.bytes_estimate?.pass).toBe(false);
    expect(overReport.over_by_bytes).toBeGreaterThan(0);
  });
});
