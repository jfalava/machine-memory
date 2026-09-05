import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { toProductRow, toRankedRow } from "../../api/src/product-logic";
import {
  decodeResponse,
  encodeResponse,
  MemoryGetSuccessSchema,
  MemoryWriteSuccessSchema,
  VectorizeSearchResultSchema,
} from "../src/index";

const stored = {
  id: 7,
  repository: "owner/repo",
  content: "Status expires after seven days",
  tags: null,
  context: null,
  memory_type: "status",
  status: "superseded_by",
  certainty: "verified",
  superseded_by: 9,
  source_agent: "codex",
  last_updated_by: "mcp",
  update_count: 2,
  refs: '["docs/status.md"]',
  expires_after_days: 7,
  created_at: "2026-09-01 10:00:00",
  updated_at: "2026-09-05 10:00:00",
};

describe("database to product wire boundary", () => {
  it("retains metadata through database decoding, response encoding, and client decoding", () => {
    const memory = toProductRow(stored);
    expect(memory).toEqual({
      ...stored,
      tags: "",
      context: "",
      refs: ["docs/status.md"],
    });
    const get = { ok: true as const, result: memory };
    expect(
      decodeResponse(
        MemoryGetSuccessSchema,
        encodeResponse(MemoryGetSuccessSchema, get),
        "get",
      ),
    ).toEqual(get);
    const write = {
      ok: true as const,
      result: { id: memory.id, written_to: memory.repository, memory },
    };
    expect(
      decodeResponse(
        MemoryWriteSuccessSchema,
        encodeResponse(MemoryWriteSuccessSchema, write),
        "update",
      ),
    ).toEqual(write);
  });

  it.each(["memory_type", "status", "certainty"])(
    "rejects invalid stored %s before it becomes a domain value",
    (field) => {
      expect(() => toProductRow({ ...stored, [field]: "invalid" })).toThrow(
        field,
      );
      expect(() => toRankedRow({ ...stored, [field]: "invalid" })).toThrow(
        field,
      );
    },
  );

  it("rejects missing metadata and corrupt serialized refs", () => {
    const { update_count: _, ...incomplete } = stored;
    expect(() => toProductRow(incomplete)).toThrow("update_count");
    expect(() => toProductRow({ ...stored, refs: "not json" })).toThrow("refs");
  });

  it("normalizes nullable text in search rows while preserving ranking metadata", () => {
    expect(toRankedRow({ ...stored, fts_rank: -2 })).toMatchObject({
      tags: "",
      context: "",
      update_count: 2,
      updated_at: stored.updated_at,
      fts_rank: -2,
    });
  });
});

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
