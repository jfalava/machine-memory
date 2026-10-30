import { extractQueryIdentifiers } from "@machine-memory/contract";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { minimalResultSummary } from "@/cli/runtime/output";
import {
  annotateMatches,
  extractTerms,
  hasStrongMatchRow,
  scoreRowsWithDetails,
} from "@/cli/shared";

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

function memory(fields: {
  id: number;
  content: string;
  ftsRank: number;
  ageDays: number;
  certainty?: string;
  updateCount?: number;
  tags?: string;
}) {
  return {
    id: fields.id,
    repository: "owner/name",
    content: fields.content,
    tags: fields.tags ?? "",
    context: "",
    memory_type: "decision",
    status: "active",
    certainty: fields.certainty ?? "verified",
    updated_at: daysAgo(fields.ageDays),
    update_count: fields.updateCount ?? 0,
    refs: "[]",
    fts_rank: fields.ftsRank,
  };
}

function rank(query: string, rows: ReturnType<typeof memory>[]) {
  return scoreRowsWithDetails(rows, extractTerms(query), {
    identifiers: extractQueryIdentifiers(query),
  });
}

describe("search ranking regressions from the memory usage audit", () => {
  it("ranks new directly relevant records above older, heavily updated neighbors", () => {
    const results = rank("admin shortcuts", [
      memory({
        id: 1,
        content:
          "Admin dashboard layout uses a two-column grid with a sticky sidebar.",
        ftsRank: -1.4,
        ageDays: 20,
        updateCount: 8,
      }),
      memory({
        id: 2,
        content: "Bot probe requests to admin routes return 404 before auth.",
        ftsRank: -1.3,
        ageDays: 25,
        updateCount: 6,
      }),
      memory({
        id: 3,
        content:
          "Admin keyboard shortcuts use TanStack Hotkeys; the user requires TanStack for app keybindings.",
        ftsRank: -3.1,
        ageDays: 0,
        certainty: "inferred",
      }),
    ]);
    expect(results.map((row) => row.id)).toEqual([3, 1, 2]);
    expect(results.map((row) => row.match_strength)).toEqual([
      "strong",
      "weak",
      "weak",
    ]);
  });

  it("prefers the gotcha matching every query term over a busy bootstrap record", () => {
    const results = rank("outfit nix update", [
      memory({
        id: 10,
        content:
          "Outfit bootstrap script installs Homebrew, mise, and shell tooling.",
        ftsRank: -1.2,
        ageDays: 2,
        updateCount: 10,
      }),
      memory({
        id: 11,
        content:
          "Outfit nix flake update pulls Node 26; the Node overlay pins nodejs_24 until native addons rebuild.",
        ftsRank: -2.9,
        ageDays: 90,
        certainty: "inferred",
        updateCount: 1,
      }),
    ]);
    expect(results[0]?.id).toBe(11);
    expect(results[0]?.match_strength).toBe("strong");
  });

  it("boosts the record that contains an exact identifier", () => {
    const results = rank("SEARCH_LIMIT_MAX semantic limit", [
      memory({
        id: 20,
        content:
          "query --hybrid combines FTS and semantic similarity; semantic limits are applied before topK.",
        ftsRank: -2.6,
        ageDays: 5,
        updateCount: 4,
      }),
      memory({
        id: 21,
        content:
          "contract PRODUCT_OPERATIONS schemas; SEARCH_LIMIT_MAX=50, CLI_LIMIT_MAX=100.",
        ftsRank: -1.8,
        ageDays: 60,
      }),
    ]);
    expect(results[0]?.id).toBe(21);
    expect(results[0]?.exact_matches).toEqual(["search_limit_max"]);
  });

  it("flags loosely related semantic candidates as no strong match", () => {
    const rows = annotateMatches(
      [
        {
          id: 30,
          content: "Docs sidebar order lists Installation first.",
          semantic_score: 0.52,
        },
        {
          id: 31,
          content: "Release binaries are code-signed.",
          semantic_score: 0.64,
        },
      ],
      { terms: extractTerms("banana bread recipe"), identifiers: [] },
    );
    expect(rows.map((row) => row.match_strength)).toEqual(["none", "none"]);
    expect(hasStrongMatchRow(rows)).toBe(false);
  });

  it("adds match strength and a content snippet to minimal summaries", () => {
    const [row] = rank("admin shortcuts", [
      memory({
        id: 40,
        content: `Admin shortcuts ${"detail ".repeat(40)}`,
        ftsRank: -2,
        ageDays: 1,
      }),
    ]);
    const summary = minimalResultSummary(row ?? {});
    expect(summary.match_strength).toBe("strong");
    const snippet = Schema.decodeUnknownSync(Schema.String)(summary.snippet);
    expect(snippet).toHaveLength(140);
    expect(snippet.endsWith("…")).toBe(true);
  });
});
