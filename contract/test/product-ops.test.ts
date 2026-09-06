import { describe, expect, it } from "vitest";
import {
  CLI_LIMIT_MAX,
  decodeRequest,
  decodeResponse,
  encodeResponse,
  MemoryAddArgsInputSchema,
  MemoryDeleteManyArgsSchema,
  MemoryDeprecateArgsSchema,
  MemoryDiffSuccessSchema,
  MemoryListArgsInputSchema,
  MemoryListSuccessSchema,
  MemoryQueryArgsInputSchema,
  MemoryQuerySuccessSchema,
  MemorySuggestSuccessSchema,
  MemoryVerifySuccessSchema,
  normalizeMemoryAddArgs,
  normalizeMemoryListArgs,
  normalizeMemoryQueryArgs,
  SEARCH_LIMIT_MAX,
} from "../src/index";

describe("product ops schemas", () => {
  it("documents the limit split", () => {
    expect(SEARCH_LIMIT_MAX).toBe(50);
    expect(CLI_LIMIT_MAX).toBe(100);
  });

  it("defaults query mode to hybrid and limit to 8", () => {
    const result = decodeRequest(MemoryQueryArgsInputSchema, {
      repository: "owner/name",
      query: "deploy",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const normalized = normalizeMemoryQueryArgs(result.value);
      expect(normalized.mode).toBe("hybrid");
      expect(normalized.limit).toBe(8);
    }
  });

  it("defaults add enums and upsert threshold", () => {
    const result = decodeRequest(MemoryAddArgsInputSchema, {
      repository: "owner/name",
      content: "remember this",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const normalized = normalizeMemoryAddArgs(result.value);
      expect(normalized.memory_type).toBe("convention");
      expect(normalized.certainty).toBe("inferred");
      expect(normalized.status).toBe("active");
      expect(normalized.upsert_threshold).toBe(32);
    }
  });

  it("normalizes list offsets and bounds explicit bulk ids", () => {
    const list = decodeRequest(MemoryListArgsInputSchema, {
      repository: "owner/name",
      offset: 50,
    });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(normalizeMemoryListArgs(list.value).offset).toBe(50);
    }
    expect(
      decodeRequest(MemoryDeleteManyArgsSchema, {
        repository: "owner/name",
        ids: [],
      }).ok,
    ).toBe(false);
    expect(
      decodeRequest(MemoryDeprecateArgsSchema, {
        repository: "owner/name",
        ids: [1, 2],
        superseded_by: 3,
      }).ok,
    ).toBe(true);
  });

  it("round-trips product query success envelopes", () => {
    const payload = {
      ok: true as const,
      result: {
        count: 1,
        results: [
          {
            id: 7,
            repository: "owner/name",
            content: "deploy with bun",
            tags: "area:cli",
            context: "",
            memory_type: "convention" as const,
            status: "active" as const,
            certainty: "verified" as const,
            score: 42.5,
          },
        ],
      },
    };
    const encoded = encodeResponse(MemoryQuerySuccessSchema, payload);
    expect(decodeResponse(MemoryQuerySuccessSchema, encoded, "query")).toEqual(
      payload,
    );
  });

  it("round-trips product list, suggest, verify, and diff envelopes", () => {
    const list = {
      ok: true as const,
      result: {
        count: 1,
        total_count: 3,
        offset: 1,
        limit: 1,
        has_more: true,
        results: [
          {
            id: 1,
            repository: "owner/name",
            content: "hello",
            tags: "",
            context: "",
            memory_type: "convention" as const,
            status: "active" as const,
            certainty: "inferred" as const,
            superseded_by: null,
            source_agent: "agent",
            last_updated_by: "agent",
            update_count: 0,
            refs: [],
            expires_after_days: null,
            created_at: null,
            updated_at: null,
          },
        ],
      },
    };
    expect(
      decodeResponse(
        MemoryListSuccessSchema,
        encodeResponse(MemoryListSuccessSchema, list),
        "list",
      ),
    ).toEqual(list);
    const suggest = {
      ok: true as const,
      result: {
        files: ["src/a.ts"],
        normalized_path_terms: ["a"],
        derived_terms: ["a"],
        neighborhood: { tags: [], paths: [] },
        count: 0,
        results: [],
      },
    };
    expect(
      decodeResponse(
        MemorySuggestSuccessSchema,
        encodeResponse(MemorySuggestSuccessSchema, suggest),
        "suggest",
      ),
    ).toEqual(suggest);
    const verify = {
      ok: true as const,
      result: {
        id: 1,
        ok: true as const,
        result: "consistent" as const,
        similarity: 0.9,
      },
    };
    expect(
      decodeResponse(
        MemoryVerifySuccessSchema,
        encodeResponse(MemoryVerifySuccessSchema, verify),
        "verify",
      ),
    ).toEqual(verify);
    const diff = {
      ok: true as const,
      result: {
        id: 1,
        conflict: false,
        similarity: 0.8,
        added_terms: ["x"],
        removed_terms: [],
      },
    };
    expect(
      decodeResponse(
        MemoryDiffSuccessSchema,
        encodeResponse(MemoryDiffSuccessSchema, diff),
        "diff",
      ),
    ).toEqual(diff);
  });
});
