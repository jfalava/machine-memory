import { Tokenizer } from "@huggingface/tokenizers";
import { describe, expect, it } from "vitest";
import {
  assertBgeTokenCount,
  BGE_MAX_EMBEDDING_TOKENS,
  countTokens,
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
  });
});
