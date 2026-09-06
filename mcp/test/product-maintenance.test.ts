import { describe, expect, test } from "vitest";
import {
  analyzeMemoryDoctor,
  summarizeMemoryStats,
} from "../../api/src/product-logic";
import {
  listCountSelect,
  listSelect,
  repositoryStatsSelect,
} from "../../api/src/product-api";

const BASE_ROW = {
  repository: "o/r",
  context: "",
  status: "active",
  certainty: "verified",
  superseded_by: null,
  source_agent: "test",
  last_updated_by: "test",
  update_count: 0,
  refs: "[]",
  created_at: "2026-01-01 00:00:00",
  updated_at: "2026-01-01 00:00:00",
};

describe("product maintenance logic", () => {
  test("doctor identifies duplicate, stale status, expiry, and tag findings", () => {
    const result = analyzeMemoryDoctor("o/r", [
      {
        ...BASE_ROW,
        id: 2,
        content: "current parser progress",
        tags: "area:cli,topic:parser,kind:status",
        memory_type: "status",
        expires_after_days: null,
      },
      {
        ...BASE_ROW,
        id: 1,
        content: "current parser progress",
        tags: "area:cli,topic:parser,kind:status",
        memory_type: "status",
        expires_after_days: null,
      },
    ]);

    expect(result.checked).toBe(2);
    expect(result.counts_by_kind).toMatchObject({
      exact_duplicate: 1,
      stale_status_overlap: 1,
      status_missing_expiry: 2,
      canonical_thread_overlap: 1,
    });
    expect(
      result.findings.find((finding) => finding.kind === "exact_duplicate")
        ?.ids,
    ).toEqual([2, 1]);
  });

  test("stats aggregates statuses, tags, age, and oldest memory", () => {
    const result = summarizeMemoryStats(
      "o/r",
      [
        {
          ...BASE_ROW,
          id: 1,
          content: "one",
          tags: "area:cli,topic:parser",
          memory_type: "decision",
          expires_after_days: null,
        },
        {
          ...BASE_ROW,
          id: 2,
          content: "two",
          tags: "",
          memory_type: "status",
          status: "deprecated",
          certainty: "inferred",
          expires_after_days: 7,
          created_at: "2026-02-01 00:00:00",
          updated_at: "2026-08-31 00:00:00",
        },
      ],
      Date.parse("2026-09-05T00:00:00Z"),
    );

    expect(result).toMatchObject({
      total_memories: 2,
      active: 1,
      deprecated: 1,
      superseded: 0,
      breakdown_by_memory_type: { decision: 1, status: 1 },
      breakdown_by_certainty: { verified: 1, inferred: 1 },
      tag_frequency_map: { "area:cli": 1, "topic:parser": 1 },
      oldest_memory: { id: 1, created_at: "2026-01-01 00:00:00" },
      memories_not_updated_over_90_days: 1,
      memories_with_no_tags: 1,
    });
  });

  test("list and repository queries carry explicit pagination", () => {
    expect(listSelect("o/r", { status: "active" }, 50, 100)).toEqual({
      sql: "SELECT * FROM memories WHERE repository = ? AND status = ? ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?",
      params: ["o/r", "active", 50, 100],
    });
    expect(listCountSelect("o/r", { status: "active" })).toEqual({
      sql: "SELECT COUNT(*) AS total_count FROM memories WHERE repository = ? AND status = ?",
      params: ["o/r", "active"],
    });
    expect(repositoryStatsSelect(20, 40).params).toEqual([20, 40]);
  });
});
