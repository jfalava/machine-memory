import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { VectorizeSearchResultSchema } from "../src/index";

describe("Vectorize result contract", () => {
  it("accepts absent metadata and preserves supplied JSON metadata", () => {
    const result = {
      count: 2,
      matches: [
        { id: "7", score: 0.8 },
        {
          id: "8",
          score: 0.7,
          metadata: { status: "active", custom: [1, true] },
        },
      ],
    };
    expect(
      Schema.decodeUnknownSync(VectorizeSearchResultSchema)(result),
    ).toEqual(result);
  });
  it.each([
    { count: 1, matches: [{ id: "7", score: "0.8" }] },
    { count: 1, matches: [{ id: "", score: 0.8 }] },
    { count: -1, matches: [] },
    { count: 1, matches: [{ id: "7", score: Infinity }] },
    { count: 1, matches: [{ id: "7", score: 0.8, metadata: [] }] },
    { arbitrary: "json" },
  ])("rejects malformed results: %j", (body) => {
    expect(() =>
      Schema.decodeUnknownSync(VectorizeSearchResultSchema)(body),
    ).toThrow();
  });
});
