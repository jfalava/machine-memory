import { hasStrongMatch } from "@machine-memory/contract";
import { describe, expect, it } from "vitest";

import {
  extractTerms,
  scoreMemoryRows,
  scoredResultRow,
  strongerMatch,
  type FtsRankedMemoryRow,
} from "../src/product-logic";

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

function ranked(fields: {
  id: number;
  content: string;
  ftsRank: number;
  ageDays: number;
  certainty?: "verified" | "inferred";
  updateCount?: number;
  refs?: string[];
}): FtsRankedMemoryRow {
  return {
    id: fields.id,
    repository: "owner/name",
    content: fields.content,
    tags: "",
    context: "",
    memory_type: "decision",
    status: "active",
    certainty: fields.certainty ?? "verified",
    updated_at: daysAgo(fields.ageDays),
    update_count: fields.updateCount ?? 0,
    refs: fields.refs ?? [],
    evidence: [],
    validation_gaps: [],
    fts_rank: fields.ftsRank,
  };
}

describe("product search ranking", () => {
  it("lets relevance outrank recency, certainty, and update-count priors", () => {
    const results = scoreMemoryRows(
      [
        ranked({
          id: 1,
          content: "Admin dashboard layout uses a sticky sidebar.",
          ftsRank: -1.4,
          ageDays: 20,
          updateCount: 8,
        }),
        ranked({
          id: 2,
          content: "Admin keyboard shortcuts use TanStack Hotkeys.",
          ftsRank: -3.1,
          ageDays: 0,
          certainty: "inferred",
        }),
      ],
      { terms: extractTerms("admin shortcuts"), identifiers: [] },
    ).map(scoredResultRow);
    expect(results.map((row) => [row.id, row.match_strength])).toEqual([
      [2, "strong"],
      [1, "weak"],
    ]);
  });

  it("matches suggested file paths literally in refs", () => {
    const [row] = scoreMemoryRows(
      [
        ranked({
          id: 3,
          content: "Managed AGENTS.md block generator.",
          ftsRank: -1,
          ageDays: 3,
          refs: ["cli/src/cli/commands/agents-md-content.ts"],
        }),
      ],
      {
        terms: ["cli", "commands", "agents", "md", "content", "ts"],
        identifiers: [
          "cli/src/cli/commands/agents-md-content.ts",
          "agents-md-content.ts",
        ],
        scope: "files",
      },
    );
    expect(row?.match_strength).toBe("strong");
    expect(row?.exact_matches).toEqual([
      "cli/src/cli/commands/agents-md-content.ts",
      "agents-md-content.ts",
    ]);
  });

  it("keeps the stronger assessment when hybrid retrievers overlap", () => {
    const weak = {
      match_strength: "weak",
      term_coverage: 0.5,
      exact_matches: [],
    } as const;
    const strong = {
      match_strength: "strong",
      term_coverage: 0.5,
      exact_matches: [],
    } as const;
    expect(strongerMatch(weak, strong)).toBe(strong);
    expect(strongerMatch(strong, weak)).toBe(strong);
    expect(hasStrongMatch([weak])).toBe(false);
  });
});
