import { Tokenizer } from "@huggingface/tokenizers";
import { describe, expect, it } from "vitest";
import {
  analyzeBgeEmbeddingWith,
  analyzeEmbeddingByBytes,
  assertBgeBreakdown,
  assertBgeTokenCount,
  bgeEmbeddingLimitMessage,
  BGE_MAX_EMBEDDING_TOKENS,
  composeEmbeddingText,
  countTokens,
  estimateEmbeddingBytes,
  type EmbeddingTextPart,
} from "@/effect/bge-tokenizer";

const tokenizerJson = {
  version: "1.0",
  truncation: null,
  padding: null,
  added_tokens: [
    {
      id: 0,
      content: "[PAD]",
      single_word: false,
      lstrip: false,
      rstrip: false,
      normalized: false,
      special: true,
    },
    {
      id: 1,
      content: "[UNK]",
      single_word: false,
      lstrip: false,
      rstrip: false,
      normalized: false,
      special: true,
    },
    {
      id: 2,
      content: "[CLS]",
      single_word: false,
      lstrip: false,
      rstrip: false,
      normalized: false,
      special: true,
    },
    {
      id: 3,
      content: "[SEP]",
      single_word: false,
      lstrip: false,
      rstrip: false,
      normalized: false,
      special: true,
    },
  ],
  normalizer: {
    type: "BertNormalizer",
    clean_text: true,
    handle_chinese_chars: true,
    strip_accents: null,
    lowercase: true,
  },
  pre_tokenizer: { type: "BertPreTokenizer" },
  post_processor: {
    type: "BertProcessing",
    sep: ["[SEP]", 3],
    cls: ["[CLS]", 2],
  },
  decoder: { type: "WordPiece", prefix: "##", cleanup: true },
  model: {
    type: "WordPiece",
    unk_token: "[UNK]",
    continuing_subword_prefix: "##",
    max_input_chars_per_word: 100,
    vocab: { "[PAD]": 0, "[UNK]": 1, "[CLS]": 2, "[SEP]": 3, hello: 4 },
  },
};

const tokenizerConfig = {
  model_max_length: BGE_MAX_EMBEDDING_TOKENS,
  do_lower_case: true,
  cls_token: "[CLS]",
  sep_token: "[SEP]",
  unk_token: "[UNK]",
  pad_token: "[PAD]",
};

describe("BGE tokenizer validation", () => {
  it("counts model special tokens", () => {
    const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);

    expect(countTokens(tokenizer, "hello")).toBe(3);
  });

  it("requires the embedding text to be below the model limit", () => {
    expect(() =>
      assertBgeTokenCount(BGE_MAX_EMBEDDING_TOKENS - 1, "Memory"),
    ).not.toThrow();
    expect(() =>
      assertBgeTokenCount(BGE_MAX_EMBEDDING_TOKENS, "Memory"),
    ).toThrow("Memory must be below 512 tokens for embedding");
    expect(() =>
      assertBgeTokenCount(BGE_MAX_EMBEDDING_TOKENS, "Memory"),
    ).toThrow("Trim at least 1 token(s) to fit.");
  });

  it("composes embedding text from non-empty slices joined by newlines", () => {
    const parts: EmbeddingTextPart[] = [
      { part: "content", text: "hello" },
      { part: "tags", text: "" },
      { part: "context", text: "hello hello" },
    ];
    expect(composeEmbeddingText(parts)).toBe("hello\nhello hello");
  });
});

describe("BGE token breakdown", () => {
  const parts: EmbeddingTextPart[] = [
    { part: "content", text: "hello" },
    { part: "tags", text: "" },
    { part: "context", text: "hello hello" },
    { part: "memory_type", text: "Memory type: convention" },
    { part: "status", text: "Status: active" },
    { part: "certainty", text: "Certainty: verified" },
  ];

  it("attributes tokens per part and reconciles the special-token overhead", () => {
    const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
    const breakdown = analyzeBgeEmbeddingWith(tokenizer, parts);

    expect(breakdown.source).toBe("tokenizer");
    expect(breakdown.total_tokens).toBe(15);
    expect(breakdown.max_tokens).toBe(BGE_MAX_EMBEDDING_TOKENS);
    expect(breakdown.within_limit).toBe(true);
    expect(breakdown.over_by).toBe(0);
    expect(breakdown.remaining).toBe(511 - 15);
    expect(breakdown.bytes_estimate).toBe(estimateEmbeddingBytes(composeEmbeddingText(parts)));
    expect(breakdown.parts).toEqual([
      { part: "content", tokens: 3 },
      { part: "context", tokens: 4 },
      { part: "memory_type", tokens: 6 },
      { part: "status", tokens: 5 },
      { part: "certainty", tokens: 5 },
    ]);
    // Each part is tokenized on its own, so [CLS]/[SEP] are counted once per
    // part even though the composed text carries them once.
    expect(breakdown.overhead).toBe(2 * (5 - 1));
  });

  it("flags a synthetic limit violation with an actionable message", () => {
    const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
    const content = Array.from({ length: 600 }, () => "hello").join(" ");
    const breakdown = analyzeBgeEmbeddingWith(
      tokenizer,
      parts.map((entry) =>
        entry.part === "content" ? { ...entry, text: content } : entry,
      ),
    );

    expect(breakdown.parts[0]).toEqual({ part: "content", tokens: 602 });
    const partSum = breakdown.parts.reduce(
      (sum, entry) => sum + entry.tokens,
      0,
    );
    expect(breakdown.total_tokens).toBe(partSum - breakdown.overhead);
    expect(breakdown.within_limit).toBe(false);
    expect(breakdown.over_by).toBe(
      Math.max(
        breakdown.total_tokens - 511,
        breakdown.bytes_estimate - 512,
      ),
    );
    expect(() => assertBgeBreakdown(breakdown, "Memory")).toThrow(
      /Memory has 614\/512 embedding tokens/,
    );

    const message = bgeEmbeddingLimitMessage(breakdown, "Memory");
    expect(message).toContain("content: 602 tokens");
    expect(message).toContain("byte estimate");
    expect(message).toContain(`Trim at least ${breakdown.over_by} token(s)`);
  });

  it("rejects on the embedding service byte estimate even when tokens fit", () => {
    const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
    // 400 repetitions of a short word: ~402 tokens (fits) but ~2.4KB of UTF-8
    // text — the Worker-side byte+2 estimate exceeds 512, so the write must
    // fail exactly like the embedding service would.
    const content = Array.from({ length: 400 }, () => "hello").join(" ");
    const breakdown = analyzeBgeEmbeddingWith(
      tokenizer,
      parts.map((entry) =>
        entry.part === "content" ? { ...entry, text: content } : entry,
      ),
    );

    expect(breakdown.total_tokens).toBeLessThan(BGE_MAX_EMBEDDING_TOKENS);
    expect(breakdown.bytes_estimate).toBeGreaterThan(BGE_MAX_EMBEDDING_TOKENS);
    expect(breakdown.within_limit).toBe(false);
    expect(breakdown.over_by).toBe(
      breakdown.bytes_estimate - BGE_MAX_EMBEDDING_TOKENS,
    );
    expect(bgeEmbeddingLimitMessage(breakdown, "Memory")).toContain(
      "token count fits",
    );
  });

  it("treats an empty slice as absent from the report and the total", () => {
    const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
    const withTags: EmbeddingTextPart[] = parts.map((entry) =>
      entry.part === "tags" ? { ...entry, text: "cli,memory" } : entry,
    );
    const withTagsBreakdown = analyzeBgeEmbeddingWith(tokenizer, withTags);
    const emptyTagsBreakdown = analyzeBgeEmbeddingWith(tokenizer, parts);

    expect(withTagsBreakdown.parts).toHaveLength(6);
    expect(emptyTagsBreakdown.parts).toHaveLength(5);
    expect(withTagsBreakdown.total_tokens).toBeGreaterThan(
      emptyTagsBreakdown.total_tokens,
    );
    expect(emptyTagsBreakdown.parts).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ part: "tags" })]),
    );
  });

  it("falls back to a conservative byte estimate", () => {
    const bytes = analyzeEmbeddingByBytes([
      { part: "content", text: "é".repeat(256) },
    ]);

    expect(bytes.source).toBe("bytes");
    expect(bytes.parts).toEqual([]);
    expect(bytes.total_tokens).toBe(256 * 2 + 2);
    expect(bytes.bytes_estimate).toBe(256 * 2 + 2);
    expect(bytes.within_limit).toBe(false);
    expect(bytes.over_by).toBe(2);
  });

  it("estimates embedding bytes as UTF-8 length plus special tokens", () => {
    expect(estimateEmbeddingBytes("abc")).toBe(5);
    expect(estimateEmbeddingBytes("é")).toBe(4);
  });
});
