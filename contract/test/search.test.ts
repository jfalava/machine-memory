import { describe, expect, it } from "vitest";

import {
  assessMatch,
  extractQueryIdentifiers,
  fileIdentifiers,
  hasStrongMatch,
  matchText,
  mergeSuggestCandidates,
  orderByMatchStrength,
} from "../src/index";

describe("search match assessment", () => {
  it("extracts literal identifiers and ignores plain words", () => {
    expect(
      extractQueryIdentifiers(
        'cli/src/cli/shared.ts SEARCH_LIMIT_MAX --json-min nixpkgs-security TanStack "sync:mcp," home manager e.g.',
      ),
    ).toEqual([
      "cli/src/cli/shared.ts",
      "search_limit_max",
      "--json-min",
      "nixpkgs-security",
      "tanstack",
      "sync:mcp",
    ]);
    expect(extractQueryIdentifiers("admin shortcuts 2026")).toEqual([]);
  });

  it("derives file identifiers without generic entry-point basenames", () => {
    expect(
      fileIdentifiers(["cli/src/cli/shared.ts", "contract/src/index.ts"]),
    ).toEqual(["cli/src/cli/shared.ts", "shared.ts", "contract/src/index.ts"]);
  });

  it("labels exact identifier hits strong even with low term coverage", () => {
    const match = assessMatch({
      queryTerms: ["search", "limit", "max", "semantic"],
      identifiers: ["search_limit_max"],
      text: matchText(["Contract caps SEARCH_LIMIT_MAX=50."]),
    });
    expect(match).toEqual({
      match_strength: "strong",
      term_coverage: 0.75,
      exact_matches: ["search_limit_max"],
    });
  });

  it("requires every query identifier unless term coverage is also strong", () => {
    const query = {
      queryTerms: ["sync", "mcp", "init", "payload", "regenerate"],
      identifiers: ["sync:mcp", "init-mcp"],
    };
    expect(
      assessMatch({
        ...query,
        text: matchText(["Init scripts stay at /init-mcp on the docs host."]),
      }),
    ).toMatchObject({ match_strength: "weak", exact_matches: ["init-mcp"] });
    expect(
      assessMatch({
        ...query,
        text: matchText([
          "docs/public/init-mcp embeds the block; regenerate via bun run sync:mcp.",
        ]),
      }).match_strength,
    ).toBe("strong");
  });

  it("separates strong, weak, and absent lexical coverage", () => {
    const text = matchText(["Admin keyboard shortcuts use TanStack Hotkeys."]);
    expect(
      assessMatch({ queryTerms: ["admin", "shortcuts"], identifiers: [], text })
        .match_strength,
    ).toBe("strong");
    expect(
      assessMatch({
        queryTerms: ["admin", "dashboard", "layout"],
        identifiers: [],
        text,
      }).match_strength,
    ).toBe("weak");
    expect(
      assessMatch({ queryTerms: ["banana", "bread"], identifiers: [], text })
        .match_strength,
    ).toBe("none");
  });

  it("uses calibrated bge-base cosine bars for semantic-only matches", () => {
    const base = { queryTerms: ["unrelated"], identifiers: [], text: "x" };
    expect(assessMatch({ ...base, semanticScore: 0.875 }).match_strength).toBe(
      "strong",
    );
    expect(assessMatch({ ...base, semanticScore: 0.726 }).match_strength).toBe(
      "weak",
    );
    expect(assessMatch({ ...base, semanticScore: 0.643 }).match_strength).toBe(
      "none",
    );
  });

  it("keeps generic file-path terms from making a suggestion strong", () => {
    const text = matchText(["cli commands are written in ts"]);
    const query = {
      queryTerms: ["cli", "commands", "ts"],
      identifiers: ["cli/src/cli/commands/init.ts", "init.ts"],
      text,
    };
    expect(assessMatch(query).match_strength).toBe("strong");
    expect(assessMatch({ ...query, scope: "files" }).match_strength).toBe(
      "weak",
    );
    expect(
      assessMatch({
        ...query,
        scope: "files",
        text: matchText(["Generator lives in cli/src/cli/commands/init.ts"]),
      }).match_strength,
    ).toBe("strong");
  });

  it("orders strong before weak before none, stable within a tier", () => {
    const rows = [
      { id: 1, match_strength: "weak" as const },
      { id: 2, match_strength: "none" as const },
      { id: 3, match_strength: "strong" as const },
      { id: 4, match_strength: "weak" as const },
      { id: 5, match_strength: "strong" as const },
    ];
    expect(orderByMatchStrength(rows).map((row) => row.id)).toEqual([
      3, 5, 1, 4, 2,
    ]);
  });

  it("reports whether any row is strong", () => {
    expect(hasStrongMatch([{ match_strength: "weak" }])).toBe(false);
    expect(
      hasStrongMatch([
        { match_strength: "none" },
        { match_strength: "strong" },
      ]),
    ).toBe(true);
  });
});

describe("suggest candidate merge", () => {
  it("boosts neighborhood rows, keeps the higher score, and drops nothing", () => {
    const fts = Array.from({ length: 25 }, (_, index) => ({
      id: index + 1,
      score: 100 - index,
    }));
    const merged = mergeSuggestCandidates(fts, [
      { id: 25, score: 90 },
      { id: 1, score: 10 },
      { id: 99, score: 5 },
    ]);

    expect(merged).toHaveLength(26);
    expect(merged[0]).toEqual({ id: 25, score: 102 });
    expect(merged.find((row) => row.id === 1)?.score).toBe(100);
    expect(merged.at(-1)).toEqual({ id: 99, score: 17 });
  });
});
