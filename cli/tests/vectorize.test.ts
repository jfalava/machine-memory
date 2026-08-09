import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { MemoryDatabaseError } from "@/effect/errors";
import { remoteVectorApi, vectorizeRateLimitInfo } from "@/effect/vectorize";

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
  it("normalizes valid match metadata without dropping matches", async () => {
    stubSearchResponse({
      count: 2,
      matches: [
        { id: "1", score: 0.9, metadata: { tags: "cli" } },
        { id: "2", score: 0.8, metadata: "invalid" },
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
      message: expect.stringContaining("invalid search match"),
    });
  });

  it("preserves rate-limit status and retry-after metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ ok: false, error: "Too Many Requests" }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "2",
            },
          },
        ),
      ),
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
