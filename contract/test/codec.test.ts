import { describe, expect, it, vi } from "vitest";
import {
  decodeRequest,
  decodeResponse,
  encodeResponse,
  ErrorBodySchema,
  MigrationRequestInputSchema,
  MigrationSuccessSchema,
  normalizeMigrationRequest,
  normalizeVectorizeSearchRequest,
  normalizeVectorizeUpsertRequest,
  QueryRequestSchema,
  VectorizeSearchRequestInputSchema,
  VectorizeUpsertRequestInputSchema,
} from "../src/index";

describe("codec", () => {
  it("encodeResponse fails closed on invalid domain values", () => {
    expect(() =>
      encodeResponse(ErrorBodySchema, {
        ok: false,
        error: "boom",
      }),
    ).not.toThrow();
    expect(() =>
      encodeResponse(ErrorBodySchema, {
        ok: true,
        error: "boom",
      } as unknown as {
        readonly ok: false;
        readonly error: string;
      }),
    ).toThrow();
  });

  it("decodeResponse fails open and logs", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      decodeResponse(ErrorBodySchema, { ok: true }, "err"),
    ).toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("decodeRequest returns structured errors", () => {
    const bad = decodeRequest(QueryRequestSchema, { operation: "nope" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.length).toBeGreaterThan(0);
    }
  });
});

describe("api request schemas", () => {
  it("decodes query requests", () => {
    const result = decodeRequest(QueryRequestSchema, {
      operation: "all",
      sql: "select 1",
      params: [1, "x", null],
      repository: "owner/name",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        operation: "all",
        sql: "select 1",
        params: [1, "x", null],
        repository: "owner/name",
      },
    });
  });

  it("rejects oversized repository namespaces", () => {
    const result = decodeRequest(QueryRequestSchema, {
      operation: "get",
      sql: "select 1",
      params: [],
      repository: "x".repeat(100),
    });
    expect(result.ok).toBe(false);
  });

  it("applies migration row defaults", () => {
    const result = decodeRequest(MigrationRequestInputSchema, {
      repository: "owner/name",
      rows: [
        {
          source_id: 1,
          content: "hello",
          update_count: 0,
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const normalized = normalizeMigrationRequest(result.value);
      expect(normalized.ok).toBe(true);
      if (!normalized.ok) {
        return;
      }
      expect(normalized.value.rows[0]).toMatchObject({
        memory_type: "convention",
        status: "active",
        certainty: "inferred",
        tags: "",
        refs: "[]",
        superseded_by_source_id: null,
        expires_after_days: null,
      });
    }
  });

  it("applies vectorize search defaults and optional filters", () => {
    const result = decodeRequest(VectorizeSearchRequestInputSchema, {
      repository: "owner/name",
      query: "deploy",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const normalized = normalizeVectorizeSearchRequest(result.value);
      expect(normalized.top_k).toBe(8);
      expect(normalized.status).toBeUndefined();
    }
  });

  it("decodes vectorize upsert documents with defaults", () => {
    const result = decodeRequest(VectorizeUpsertRequestInputSchema, {
      id: 42,
      repository: "owner/name",
      content: "body",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(normalizeVectorizeUpsertRequest(result.value)).toMatchObject({
        id: 42,
        memory_type: "convention",
        status: "active",
        certainty: "inferred",
        tags: "",
        context: "",
      });
    }
  });

  it("rejects duplicate migration source_ids", () => {
    const result = decodeRequest(MigrationRequestInputSchema, {
      repository: "owner/name",
      rows: [
        { source_id: 1, content: "a", update_count: 0 },
        { source_id: 1, content: "b", update_count: 0 },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(normalizeMigrationRequest(result.value)).toEqual({
        ok: false,
        error: "Duplicate source_id 1.",
      });
    }
  });

  it("round-trips migration success envelopes", () => {
    const payload = {
      ok: true as const,
      result: {
        processed: 1,
        inserted: 1,
        duplicates: 0,
        items: [{ source_id: 1, target_id: 9, status: "inserted" as const }],
      },
    };
    const encoded = encodeResponse(MigrationSuccessSchema, payload);
    expect(decodeResponse(MigrationSuccessSchema, encoded, "migrate")).toEqual(
      payload,
    );
  });
});
