import { describe, expect, it } from "vitest";

import {
  CLI_LIMIT_MAX,
  decideUpsert,
  decodeRequest,
  decodeResponse,
  encodeResponse,
  memoryContentError,
  MemoryAddArgsInputSchema,
  MemoryDeleteManyArgsSchema,
  MemoryDeprecateArgsSchema,
  MemoryDiffSuccessSchema,
  MemoryListArgsInputSchema,
  MemoryListSuccessSchema,
  MemoryHistoryArgsSchema,
  MemoryRestoreArgsSchema,
  MemoryQueryArgsInputSchema,
  MemoryQuerySuccessSchema,
  MemorySuggestSuccessSchema,
  MemoryVerifySuccessSchema,
  normalizeMemoryAddArgs,
  normalizeMemoryListArgs,
  normalizeMemoryQueryArgs,
  PRODUCT_OPERATIONS,
  repositorySlugError,
  SEARCH_LIMIT_MAX,
} from "../src/index";

const MemoryUpdateArgsSchema = PRODUCT_OPERATIONS.update.request;

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
      expect(normalized.upsert_threshold).toBe(50);
    }
  });

  it("requires explicit restore identity and concurrency count, and bounds history pagination", () => {
    const restore = {
      repository: "owner/name",
      id: 7,
      revision_id: 11,
      expected_update_count: 0,
    };
    expect(decodeRequest(MemoryRestoreArgsSchema, restore).ok).toBe(true);
    for (const invalid of [
      { repository: "owner/name", id: 7, revision_id: 11 },
      { ...restore, expected_update_count: -1 },
      { ...restore, expected_update_count: 1.5 },
      { ...restore, revision_id: 0 },
      { ...restore, id: 0 },
      { ...restore, repository: "" },
    ]) {
      expect(decodeRequest(MemoryRestoreArgsSchema, invalid).ok).toBe(false);
    }
    const history = { repository: "owner/name", id: 7, limit: 1, offset: 2 };
    expect(decodeRequest(MemoryHistoryArgsSchema, history).ok).toBe(true);
    expect(
      decodeRequest(MemoryHistoryArgsSchema, { ...history, offset: -1 }).ok,
    ).toBe(false);
    expect(
      decodeRequest(MemoryHistoryArgsSchema, { ...history, limit: 51 }).ok,
    ).toBe(false);
  });

  it("refuses content that is blank or a coerced missing value", () => {
    for (const junk of ["", "   ", "null", " NULL\n", "undefined"]) {
      expect(memoryContentError(junk)).toBeDefined();
      expect(
        decodeRequest(MemoryAddArgsInputSchema, {
          repository: "owner/name",
          content: junk,
        }).ok,
      ).toBe(false);
      expect(
        decodeRequest(MemoryUpdateArgsSchema, {
          repository: "owner/name",
          id: 1,
          content: junk,
        }).ok,
      ).toBe(false);
    }
    // The words are only junk when they are the whole content.
    expect(memoryContentError("null is returned when the row is missing")).toBe(
      undefined,
    );
    expect(
      decodeRequest(MemoryUpdateArgsSchema, {
        repository: "owner/name",
        id: 1,
        certainty: "verified",
      }).ok,
    ).toBe(true);
  });

  it("accepts repository slugs from any git host and rejects the rest", () => {
    for (const slug of [
      "owner/name",
      "@jfalava/clanka",
      "group/subgroup/project",
      "~user/repo.name",
      `o/${"x".repeat(62)}`,
    ]) {
      expect(repositorySlugError(slug)).toBe(undefined);
    }
    for (const slug of [
      "",
      "name",
      "owner/",
      "/name",
      "owner//name",
      "owner/na me",
      "owner/@name",
      "@@owner/name",
      "https://github.com/owner/name",
      `o/${"x".repeat(63)}`,
    ]) {
      expect(repositorySlugError(slug)).toBeDefined();
      expect(
        decodeRequest(MemoryListArgsInputSchema, { repository: slug }).ok,
      ).toBe(false);
    }
  });

  it("decides an upsert from match strength and the stated intent", () => {
    const strong = { rank_score: 32, text_overlap: 0.62 };
    const lowScore = { rank_score: 31, text_overlap: 0.9 };
    const lowOverlap = { rank_score: 90, text_overlap: 0.61 };
    const decide = (
      match: { rank_score: number; text_overlap: number } | undefined,
      createNew: boolean,
      minScore = 32,
    ) => decideUpsert({ match, minScore, createNew });
    expect(decide(undefined, false)).toBe("create");
    expect(decide(strong, false)).toBe("update");
    // "This is a different fact" wins even over a strong match.
    expect(decide(strong, true)).toBe("create");
    expect(decide(lowScore, false)).toBe("refuse");
    expect(decide(lowOverlap, false)).toBe("refuse");
    expect(decide(lowScore, true)).toBe("create");
    expect(decide(lowScore, false, 31)).toBe("update");
  });

  it("accepts metadata-only updates and the add intent fields", () => {
    expect(
      decodeRequest(MemoryUpdateArgsSchema, {
        repository: "owner/name",
        id: 1,
        add_tags: "area:cli",
        remove_validation_gaps: ["untested on Windows"],
      }).ok,
    ).toBe(true);
    const add = decodeRequest(MemoryAddArgsInputSchema, {
      repository: "owner/name",
      content: "fact",
      update_id: 7,
      allow_drop: true,
    });
    expect(add.ok).toBe(true);
    if (add.ok) {
      expect(normalizeMemoryAddArgs(add.value)).toMatchObject({
        update_id: 7,
        allow_drop: true,
      });
    }
  });

  it("bounds the expected update count on update", () => {
    const update = { repository: "owner/name", id: 1, content: "new" };
    expect(
      decodeRequest(MemoryUpdateArgsSchema, {
        ...update,
        expected_update_count: 0,
      }).ok,
    ).toBe(true);
    expect(
      decodeRequest(MemoryUpdateArgsSchema, {
        ...update,
        expected_update_count: -1,
      }).ok,
    ).toBe(false);
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
        repository: "o/r",
        count: 1,
        no_strong_match: false,
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
            evidence: ["tested_behavior" as const],
            validation_gaps: ["Windows not tested"],
            score: 42.5,
            match_strength: "strong" as const,
            term_coverage: 1,
            exact_matches: [],
            matched_terms: ["lint"],
            matched_in: ["content"],
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
        repository: "o/r",
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
            evidence: [],
            validation_gaps: [],
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
        repository: "o/r",
        count: 0,
        files: ["src/a.ts"],
        generic_files: [],
        normalized_path_terms: ["a"],
        derived_terms: ["a"],
        neighborhood: { tags: [], paths: [] },
        no_strong_match: true,
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
        dropped: { identifiers: ["src/a.ts"], sentences: [] },
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
