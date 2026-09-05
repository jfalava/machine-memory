import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  memoryVectorEmbeddingText,
  remoteVectorApi,
  vectorizeRateLimitInfo,
} from "@/effect/vectorize";
import { MemoryDatabaseError } from "@/effect/errors";

const searchRequest = {
  repository: "jfalava/machine-memory",
  query: "Vectorize",
  top_k: 8,
};

const upsertRequest = {
  id: "1",
  repository: "jfalava/machine-memory",
  content: "A memory to index",
  tags: "",
  context: "",
  memory_type: "convention",
  status: "active",
  certainty: "verified",
};

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
    vocab: {
      "[PAD]": 0,
      "[UNK]": 1,
      "[CLS]": 2,
      "[SEP]": 3,
    },
  },
};

const tokenizerConfig = {
  model_max_length: 512,
  do_lower_case: true,
  cls_token: "[CLS]",
  sep_token: "[SEP]",
  unk_token: "[UNK]",
  pad_token: "[PAD]",
};

function stubSearchResponse(result: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result }), {
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("remote Vectorize response parsing", () => {
  it("preserves valid match metadata and defaults absent metadata", async () => {
    stubSearchResponse({
      count: 2,
      matches: [
        { id: "1", score: 0.9, metadata: { tags: "cli" } },
        { id: "2", score: 0.8 },
      ],
    });

    const result = await Effect.runPromise(
      remoteVectorApi("https://memory.example/query", undefined).search(
        searchRequest,
      ),
    );

    expect(result).toEqual({
      count: 2,
      matches: [
        { id: "1", score: 0.9, metadata: { tags: "cli" } },
        { id: "2", score: 0.8, metadata: {} },
      ],
    });
  });

  it.each([
    ["id", { id: 1, score: 0.9 }],
    ["score", { id: "1", score: "0.9" }],
    ["metadata", { id: "1", score: 0.9, metadata: "invalid" }],
  ] as const)("rejects a match with an invalid %s", async (_field, match) => {
    stubSearchResponse({ count: 1, matches: [match] });

    await expect(
      Effect.runPromise(
        remoteVectorApi("https://memory.example/query", undefined).search(
          searchRequest,
        ),
      ),
    ).rejects.toMatchObject({
      operation: "vectorize/search",
      message: expect.stringContaining("invalid search result"),
    });
  });

  it("rejects an oversized memory before contacting the remote API", async () => {
    const calls: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/tokenizer.json")) {
          return new Response(JSON.stringify(tokenizerJson), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/tokenizer_config.json")) {
          return new Response(JSON.stringify(tokenizerConfig), {
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error("remote vector API should not be contacted");
      }),
    );

    const document = {
      ...upsertRequest,
      content: Array.from({ length: 600 }, () => "oversized").join(" "),
    };

    expect(memoryVectorEmbeddingText(document)).toContain(
      "Memory type: convention",
    );
    await expect(
      Effect.runPromise(
        remoteVectorApi("https://memory.example/query", undefined).upsert(
          document,
        ),
      ),
    ).rejects.toMatchObject({
      operation: "vectorize/upsert",
      message: expect.stringContaining("below 512 tokens"),
    });
    expect(calls).toHaveLength(2);
    expect(calls.some((url) => url.includes("/vectorize/upsert"))).toBe(false);
  });

  it("preserves rate-limit status and retry-after metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/tokenizer.json")) {
          return new Response(JSON.stringify(tokenizerJson), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/tokenizer_config.json")) {
          return new Response(JSON.stringify(tokenizerConfig), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ ok: false, error: "Too Many Requests" }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "2",
            },
          },
        );
      }),
    );

    let error: unknown;
    try {
      await Effect.runPromise(
        remoteVectorApi("https://memory.example/query", undefined).upsert(
          upsertRequest,
        ),
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(MemoryDatabaseError);
    expect(vectorizeRateLimitInfo(error as MemoryDatabaseError)).toEqual({
      retryAfterMs: 2000,
    });
  });
});
