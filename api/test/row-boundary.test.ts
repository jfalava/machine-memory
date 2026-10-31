import {
  decodeResponse,
  encodeResponse,
  MemoryGetSuccessSchema,
  MemoryWriteSuccessSchema,
} from "@machine-memory/contract";
import { describe, expect, it } from "vitest";

import { toProductRow, toRankedRow } from "../src/product-logic";

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
      // Rows from a schema without the evidence columns decode as unspecified.
      evidence: [],
      validation_gaps: [],
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
