import { describe, expect, it } from "vitest";

import {
  assessMatch,
  extractPathTerms,
  extractQueryIdentifiers,
  fileIdentifiers,
  hasStrongMatch,
  isExpiredStatus,
  isoTimestamp,
  matchText,
  mergeSuggestCandidates,
  orderByMatchStrength,
  scoreCandidate,
  sqliteTimestamp,
} from "../src/index";

describe("timestamps", () => {
  it("adds the zone SQLite leaves out and keeps values that already have one", () => {
    expect(isoTimestamp("2026-09-05 12:30:00")).toBe("2026-09-05T12:30:00Z");
    expect(isoTimestamp("2026-09-05T12:30:00Z")).toBe("2026-09-05T12:30:00Z");
    expect(isoTimestamp("2026-09-05T14:30:00+02:00")).toBe(
      "2026-09-05T14:30:00+02:00",
    );
    expect(isoTimestamp("")).toBe("");
  });

  it("stores any ISO time as UTC in SQLite's form", () => {
    expect(sqliteTimestamp("2026-09-05T12:30:00Z")).toBe("2026-09-05 12:30:00");
    expect(sqliteTimestamp("2026-09-05T14:30:00+02:00")).toBe(
      "2026-09-05 12:30:00",
    );
    expect(sqliteTimestamp("2026-09-05T12:30:00.789Z")).toBe(
      "2026-09-05 12:30:00",
    );
  });
});

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
      matched_terms: ["search", "limit", "max"],
      matched_in: [],
    });
  });

  it("reports the matched terms and the fields that hold them", () => {
    const fields = {
      content: "Deploys run through scripts/deploy.sh.",
      tags: "area:ops,topic:release",
      context: "",
      refs: "docs/release.md",
    };
    const match = assessMatch({
      queryTerms: ["release", "deploys", "rollback"],
      identifiers: ["docs/release.md"],
      text: matchText(Object.values(fields)),
      fields,
    });
    expect(match.matched_terms).toEqual(["release", "deploys"]);
    // "deploys" is in the content; "release" is in the tags and the refs.
    expect(match.matched_in).toEqual(["content", "tags", "refs"]);
  });

  it("keeps manifests and lockfiles out of file identifiers and path terms", () => {
    expect(
      fileIdentifiers([
        "package.json",
        "cli/package.json",
        "bun.lock",
        "bunfig.toml",
        "cli/src/size.ts",
      ]),
    ).toEqual(["cli/package.json", "cli/src/size.ts", "size.ts"]);
    expect(extractPathTerms(["cli/package.json", "bun.lock"])).toEqual(["cli"]);
    expect(extractPathTerms(["cli/src/size.ts"])).toEqual([
      "cli",
      "src",
      "size",
      "ts",
    ]);
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

  it("uses calibrated bge-m3 cosine bars for semantic-only matches", () => {
    const base = { queryTerms: ["unrelated"], identifiers: [], text: "x" };
    expect(assessMatch({ ...base, semanticScore: 0.63 }).match_strength).toBe(
      "strong",
    );
    expect(assessMatch({ ...base, semanticScore: 0.629 }).match_strength).toBe(
      "weak",
    );
    expect(assessMatch({ ...base, semanticScore: 0.55 }).match_strength).toBe(
      "weak",
    );
    // Unrelated questions peak near 0.50 on bge-m3.
    expect(assessMatch({ ...base, semanticScore: 0.549 }).match_strength).toBe(
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

describe("rank score", () => {
  const DAY = 86_400_000;
  const now = Date.UTC(2026, 10, 15);
  const match = (coverage: number) => ({
    match_strength: "weak" as const,
    term_coverage: coverage,
    exact_matches: [],
    matched_terms: [],
    matched_in: [],
  });
  const candidate = (fields: {
    ftsRank: number;
    coverage: number;
    ageDays?: number;
    certainty?: string;
    memoryType?: string;
  }) =>
    scoreCandidate({
      ftsRank: fields.ftsRank,
      bestFtsRank: -12,
      match: match(fields.coverage),
      tags: [],
      queryTerms: ["alpha", "beta", "gamma"],
      updatedAtMs: now - (fields.ageDays ?? 0) * DAY,
      certainty: fields.certainty ?? "verified",
      memoryType: fields.memoryType ?? "decision",
      nowMs: now,
    });

  it("scales full-text points to the best candidate instead of capping them", () => {
    // Under a fixed cap of 30 at |bm25| 3, both of these scored 30.
    expect(candidate({ ftsRank: -12, coverage: 0 }).fts_rank).toBe(30);
    expect(candidate({ ftsRank: -6, coverage: 0 }).fts_rank).toBe(15);
    expect(candidate({ ftsRank: 0, coverage: 0 }).fts_rank).toBe(0);
    expect(
      scoreCandidate({
        ftsRank: 0,
        bestFtsRank: 0,
        match: match(0),
        tags: [],
        queryTerms: [],
        updatedAtMs: null,
        certainty: "speculative",
        memoryType: "decision",
      }).total,
    ).toBe(0);
  });

  it("lets recency and certainty order equal matches only", () => {
    const stale = candidate({
      ftsRank: -9,
      coverage: 2 / 3,
      ageDays: 400,
      certainty: "speculative",
    });
    const fresh = candidate({ ftsRank: -9, coverage: 1 / 3 });
    // One more matched term is worth 10 points; a new verified record gets 5.
    expect(fresh.recency + fresh.certainty).toBe(5);
    expect(stale.recency + stale.certainty).toBe(0);
    expect(stale.total).toBeGreaterThan(fresh.total);
    expect(candidate({ ftsRank: -9, coverage: 1 / 3 }).total).toBeGreaterThan(
      candidate({ ftsRank: -9, coverage: 1 / 3, ageDays: 90 }).total,
    );
  });

  it("ranks a status memory below a durable one that matches as well", () => {
    const durable = candidate({ ftsRank: -9, coverage: 1, ageDays: 300 });
    const status = candidate({
      ftsRank: -9,
      coverage: 1,
      memoryType: "status",
    });
    expect(status.status_penalty).toBe(10);
    expect(durable.total).toBeGreaterThan(status.total);
  });

  it("treats a status memory as expired from its expiry day on", () => {
    const status = { memory_type: "status", expires_after_days: 7 };
    expect(isExpiredStatus(status, now - 7 * DAY, now)).toBe(true);
    expect(isExpiredStatus(status, now - 7 * DAY + 1, now)).toBe(false);
    expect(
      isExpiredStatus(
        { memory_type: "status", expires_after_days: null },
        now - 400 * DAY,
        now,
      ),
    ).toBe(false);
    expect(
      isExpiredStatus(
        { memory_type: "decision", expires_after_days: 7 },
        now - 400 * DAY,
        now,
      ),
    ).toBe(false);
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
