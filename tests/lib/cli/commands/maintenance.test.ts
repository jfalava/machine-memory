import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCliHarness } from "../../../_support/cli-harness";

const harness = createCliHarness();
const { json, dbRun, getTestDir } = harness;

describe("migrate", () => {
  test("runs schema migration explicitly", () => {
    const result = json("migrate") as Record<string, unknown>;
    expect(result.status).toBe("ok");
    expect(result.migrated).toBe(true);
  });
});

describe("coverage", () => {
  test("reports uncovered paths and tag distribution", () => {
    mkdirSync(join(getTestDir(), "src", "db"), { recursive: true });
    mkdirSync(join(getTestDir(), "src", "workers"), { recursive: true });

    json("add", "DB layer notes", "--tags", "db");

    const result = json("coverage", "--root", ".") as Record<string, unknown>;
    const uncovered = result.uncovered_paths as string[];
    const distribution = result.tag_distribution as Record<string, unknown>;

    expect(Array.isArray(uncovered)).toBe(true);
    expect(uncovered).toContain("src/workers/");
    expect(distribution.db).toBe(1);
  });
});

describe("ttl and gc", () => {
  test("gc --dry-run returns memories past TTL", () => {
    json("add", "temporary migration note", "--expires-after-days", "1");
    dbRun(
      "UPDATE memories SET updated_at = datetime('now', '-3 days') WHERE id = 1",
    );

    const result = json("gc", "--dry-run") as Record<string, unknown>;
    const expired = result.expired as Record<string, unknown>[];
    expect(result.dry_run).toBe(true);
    expect(result.count).toBe(1);
    expect(expired).toHaveLength(1);
    expect(expired[0]?.id).toBe(1);
  });
});

describe("stats", () => {
  test("returns memory health breakdowns and stale/no-tag counts", () => {
    json(
      "add",
      "old architecture fact",
      "--type",
      "decision",
      "--certainty",
      "verified",
    );
    json(
      "add",
      "db gotcha",
      "--tags",
      "db,auth",
      "--type",
      "gotcha",
      "--certainty",
      "speculative",
    );

    dbRun(
      "UPDATE memories SET created_at = datetime('now', '-120 days'), updated_at = datetime('now', '-120 days') WHERE id = 1",
    );

    const stats = json("stats") as Record<string, unknown>;
    const byType = stats.breakdown_by_memory_type as Record<string, unknown>;
    const byCertainty = stats.breakdown_by_certainty as Record<string, unknown>;
    const tags = stats.tag_frequency_map as Record<string, unknown>;
    const oldest = stats.oldest_memory as Record<string, unknown>;

    expect(stats.total_memories).toBe(2);
    expect(byType.decision).toBe(1);
    expect(byType.gotcha).toBe(1);
    expect(byCertainty.verified).toBe(1);
    expect(byCertainty.speculative).toBe(1);
    expect(tags.db).toBe(1);
    expect(oldest.id).toBe(1);
    expect(stats.memories_not_updated_over_90_days).toBe(1);
    expect(stats.memories_with_no_tags).toBe(1);
  });
});

describe("bulk import", () => {
  test("returns per-entry success|conflict|skip statuses", () => {
    json("add", "exact duplicate seed", "--tags", "seed", "--context", "ctx");
    json("add", "JWT auth middleware uses RS256", "--tags", "auth,jwt");

    const importPath = join(getTestDir(), "memories.json");
    writeFileSync(
      importPath,
      JSON.stringify([
        { content: "exact duplicate seed", tags: "seed", context: "ctx" },
        { content: "Auth middleware signs JWT with RS256", tags: "auth" },
        {
          content: "imported unique memory",
          tags: "imported",
          memory_type: "decision",
          certainty: "verified",
          refs: ["https://example.com/pr/2"],
        },
      ]),
    );

    const result = json("import", "memories.json") as Record<string, unknown>;
    const entries = result.results as Record<string, unknown>[];
    const statuses = entries.map((entry) => entry.status);

    expect(statuses).toContain("skip");
    expect(statuses).toContain("conflict");
    expect(statuses).toContain("success");

    const imported = json("list", "--tags", "imported") as Record<
      string,
      unknown
    >[];
    expect(imported).toHaveLength(1);
  });
});

describe("export", () => {
  test("exports active memories and supports type/tag/certainty/since filters", () => {
    json(
      "add",
      "auth export target",
      "--tags",
      "auth",
      "--type",
      "decision",
      "--certainty",
      "verified",
    );
    json(
      "add",
      "deprecated export target",
      "--tags",
      "auth",
      "--type",
      "decision",
      "--certainty",
      "verified",
    );
    json("deprecate", "2");

    const filtered = json(
      "export",
      "--tags",
      "auth",
      "--type",
      "decision",
      "--certainty",
      "verified",
    ) as Record<string, unknown>[];
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe(1);
    expect(filtered[0]?.status).toBe("active");

    const future = json("export", "--since", "2999-01-01T00:00:00Z") as Record<
      string,
      unknown
    >[];
    expect(future).toEqual([]);
  });
});
