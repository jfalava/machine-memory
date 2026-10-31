import type { JsonValue } from "@machine-memory/contract";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { remoteVectorApi } from "@/effect/vectorize";

const searchRequest = {
  repository: "jfalava/machine-memory",
  query: "Vectorize",
  top_k: 8,
};

function stubSearchResponse(result: JsonValue): void {
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

    const error = await Effect.runPromise(
      Effect.flip(
        remoteVectorApi("https://memory.example/query", undefined).search(
          searchRequest,
        ),
      ),
    );
    expect(error).toMatchObject({ operation: "vectorize/search" });
    expect(error.message).toContain("invalid search result");
  });
});
