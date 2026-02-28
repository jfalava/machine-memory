import { describe, test, expect } from "bun:test";
import { createCliHarness } from "../../../_support/cli-harness";

const harness = createCliHarness();
const { exec, json, briefLines, parseJsonValue, asJsonObject, dbRun } = harness;

describe("get", () => {
  test("retrieves a memory by id", () => {
    json("add", "hello");
    const result = json("get", "1") as Record<string, unknown>;
    expect(result.content).toBe("hello");
    expect(result.id).toBe(1);
    expect(result).toHaveProperty("created_at");
    expect(result).toHaveProperty("updated_at");
  });

  test("returns error for nonexistent id", () => {
    const result = json("get", "999") as Record<string, unknown>;
    expect(result.error).toBe("Not found");
  });

  test("errors when no id provided", () => {
    const result = exec("get");
    expect(result.exitCode).toBe(1);
  });
});

describe("list", () => {
  test("returns empty array when no memories", () => {
    const result = json("list");
    expect(result).toEqual([]);
  });

  test("returns all memories", () => {
    json("add", "first");
    json("add", "second");
    const result = json("list") as Record<string, unknown>[];
    expect(result).toHaveLength(2);
  });

  test("orders by updated_at descending", () => {
    json("add", "older");
    Bun.sleepSync(1100);
    json("add", "newer");
    const result = json("list") as Record<string, unknown>[];
    const newest = result[0];
    const oldest = result[1];
    expect(newest).toBeDefined();
    expect(oldest).toBeDefined();
    if (!newest || !oldest) {
      throw new Error("Expected two memories in list result");
    }
    expect(newest.content).toBe("newer");
    expect(oldest.content).toBe("older");
  });

  test("filters by tag", () => {
    json("add", "a", "--tags", "alpha");
    json("add", "b", "--tags", "beta");
    json("add", "c", "--tags", "alpha,gamma");
    const result = json("list", "--tags", "alpha") as Record<string, unknown>[];
    expect(result).toHaveLength(2);
    expect(result.every((r) => String(r.tags).includes("alpha"))).toBe(true);
  });

  test("returns empty when tag filter matches nothing", () => {
    json("add", "item", "--tags", "x");
    const result = json("list", "--tags", "nonexistent");
    expect(result).toEqual([]);
  });

  test("supports --brief output on list", () => {
    json("add", "client auth overview", "--tags", "client,auth");
    const lines = briefLines("list", "--brief");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[1]");
    expect(lines[0]).toContain("<inferred> <convention>");
    expect(lines[0]).toContain("(#client #auth)");
  });

  test("supports --type on list", () => {
    json("add", "routing rule alpha", "--type", "decision");
    json("add", "routing rule beta", "--type", "reference");

    const listed = json("list", "--type", "decision") as Record<
      string,
      unknown
    >[];
    expect(listed).toHaveLength(1);
    expect(listed[0]?.memory_type).toBe("decision");
  });
});

describe("query", () => {
  test("finds memories by content keyword", () => {
    json("add", "the database uses PostgreSQL");
    json("add", "auth uses JWT tokens");
    const result = json("query", "JWT") as Record<string, unknown>[];
    expect(result).toHaveLength(1);
    const match = result[0];
    expect(match).toBeDefined();
    if (!match) {
      throw new Error("Expected a query match");
    }
    expect(match.content).toContain("JWT");
  });

  test("finds memories by tag keyword", () => {
    json("add", "something", "--tags", "architecture");
    json("add", "other", "--tags", "testing");
    const result = json("query", "architecture") as Record<string, unknown>[];
    expect(result).toHaveLength(1);
  });

  test("finds memories by context keyword", () => {
    json("add", "item", "--context", "discovered in the migration scripts");
    const result = json("query", "migration") as Record<string, unknown>[];
    expect(result).toHaveLength(1);
  });

  test("returns diagnostics when nothing matches", () => {
    json("add", "unrelated content");
    const result = json("query", "xyznonexistent") as Record<string, unknown>;
    expect(result.results).toEqual([]);
    expect(result.search_term).toBe("xyznonexistent");
    expect(Array.isArray(result.derived_terms)).toBe(true);
    expect(Array.isArray(result.hints)).toBe(true);
  });

  test("errors when no search term provided", () => {
    const result = exec("query");
    expect(result.exitCode).toBe(1);
  });

  test("supports --brief output on query", () => {
    json("add", "JWT signing key policy", "--tags", "auth,jwt");
    const lines = briefLines("query", "jwt", "--brief");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[1]");
    expect(lines[0]).toContain("<inferred> <convention>");
    expect(lines[0]).toContain("(#auth #jwt)");
  });

  test("supports --json-min output on query", () => {
    json("add", "JWT signing key policy", "--tags", "auth,jwt");
    const result = json("query", "jwt", "--json-min") as Record<
      string,
      unknown
    >;
    expect(result.count).toBe(1);
    expect(result.ids).toEqual([1]);
  });

  test("handles hyphenated search terms safely", () => {
    json(
      "add",
      "Non-English docs require locale fallback",
      "--tags",
      "blog,non-english",
    );
    const one = json("query", "non-english") as Record<string, unknown>[];
    expect(one).toHaveLength(1);
    const two = json("query", "blog non-english tags") as Record<
      string,
      unknown
    >[];
    expect(two).toHaveLength(1);
  });

  test("supports --quiet output on query", () => {
    json("add", "JWT signing key policy", "--tags", "auth,jwt");
    const result = json("query", "jwt", "--quiet") as Record<string, unknown>;
    expect(result.count).toBe(1);
    expect(result.ids).toEqual([1]);
  });

  test("supports --explain-score on query", () => {
    json("add", "JWT signing key policy", "--tags", "auth,jwt");
    const result = json("query", "jwt", "--explain-score") as Record<
      string,
      unknown
    >;
    const weights = asJsonObject(result.score_weights);
    const rows = result.results as Record<string, unknown>[];
    expect(weights.recency).toBeDefined();
    expect(weights.certainty).toBeDefined();
    expect(weights.tagMatch).toBeDefined();
    expect(weights.updateCount).toBeDefined();
    expect(weights.ftsRank).toBeDefined();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]?.score_breakdown).toBeDefined();
  });

  test("returns actionable error payload when schema is missing", () => {
    json("add", "temporary content");
    dbRun("DROP TABLE memories_fts");
    const result = exec("query", "temporary");
    const parsed = asJsonObject(parseJsonValue(result.stdout));
    expect(result.exitCode).toBe(1);
    expect(parsed.error).toContain("Database schema is outdated");
    expect(parsed.error).toContain("machine-memory migrate");
  });

  test("FTS stays in sync after update", () => {
    json("add", "original keyword");
    json("update", "1", "replacement term");
    const old = json("query", "original") as Record<string, unknown>;
    const updated = json("query", "replacement") as Record<string, unknown>[];
    expect(old.results).toEqual([]);
    expect(updated).toHaveLength(1);
  });

  test("FTS stays in sync after delete", () => {
    json("add", "searchable content");
    json("delete", "1");
    const result = json("query", "searchable");
    expect((result as Record<string, unknown>).results).toEqual([]);
  });

  test("returns score on results and sorts descending", () => {
    json(
      "add",
      "cache invalidation rules for auth responses",
      "--tags",
      "cache,auth",
      "--certainty",
      "verified",
    );
    json(
      "add",
      "cache invalidation note for auth responses",
      "--tags",
      "notes",
      "--certainty",
      "speculative",
    );

    json(
      "update",
      "1",
      "cache invalidation rules for auth responses",
      "--updated-by",
      "gpt-5-codex",
    );
    json(
      "update",
      "1",
      "cache invalidation rules for auth responses",
      "--updated-by",
      "gpt-5-codex",
    );

    const result = json("query", "cache invalidation") as Record<
      string,
      unknown
    >[];
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(typeof result[0]?.score).toBe("number");
    expect(typeof result[1]?.score).toBe("number");
    expect(Number(result[0]?.score)).toBeGreaterThanOrEqual(
      Number(result[1]?.score),
    );
    expect(result[0]?.id).toBe(1);
  });

  test("supports --type on query", () => {
    json("add", "routing rule alpha", "--type", "decision");
    json("add", "routing rule beta", "--type", "reference");

    const queried = json("query", "routing", "--type", "decision") as Record<
      string,
      unknown
    >[];
    expect(queried).toHaveLength(1);
    expect(queried[0]?.id).toBe(1);
  });
});

describe("suggest", () => {
  test("derives search terms from file paths and returns ranked memories", () => {
    json(
      "add",
      "JWT auth middleware uses RS256",
      "--tags",
      "auth,jwt,middleware",
    );
    json("add", "Database migrations run on deploy", "--tags", "db,migrations");

    const result = json(
      "suggest",
      "--files",
      "src/auth/jwt.ts,src/middleware/session.ts",
    ) as Record<string, unknown>;

    const derivedTerms = result.derived_terms as string[];
    const suggestions = result.results as Record<string, unknown>[];
    expect(Array.isArray(derivedTerms)).toBe(true);
    expect(derivedTerms).toContain("auth");
    expect(derivedTerms).toContain("jwt");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]?.id).toBe(1);
  });

  test("adds neighborhood matches from nearby paths and directory tags", () => {
    json(
      "add",
      "Session refresh follows src/client/session.ts conventions",
      "--tags",
      "architecture",
    );
    json("add", "Client boundary architecture note", "--tags", "client");

    const result = json("suggest", "--files", "src/client/auth.ts") as Record<
      string,
      unknown
    >;

    const suggestions = result.results as Record<string, unknown>[];
    const ids = suggestions.map((item) => Number(item.id));
    expect(ids).toContain(1);
    expect(ids).toContain(2);
  });

  test("supports --json-min output on suggest", () => {
    json(
      "add",
      "JWT auth middleware uses RS256",
      "--tags",
      "auth,jwt,middleware",
    );
    const result = json(
      "suggest",
      "--files",
      "src/auth/jwt.ts,src/middleware/session.ts",
      "--json-min",
    ) as Record<string, unknown>;
    expect(typeof result.count).toBe("number");
    expect(Array.isArray(result.ids)).toBe(true);
  });

  test("supports --files-json for shell-safe paths", () => {
    json(
      "add",
      "Dynamic blog slug route conventions",
      "--tags",
      "blog,slug,nextjs",
    );
    const result = json(
      "suggest",
      "--files-json",
      '["src/app/blog/$slug.tsx","src/app/blog/[slug]/page.tsx"]',
      "--json-min",
    ) as Record<string, unknown>;
    expect(typeof result.count).toBe("number");
    expect(Array.isArray(result.ids)).toBe(true);
  });

  test("supports --quiet output on suggest", () => {
    json(
      "add",
      "JWT auth middleware uses RS256",
      "--tags",
      "auth,jwt,middleware",
    );
    const result = json(
      "suggest",
      "--files",
      "src/auth/jwt.ts,src/middleware/session.ts",
      "--quiet",
    ) as Record<string, unknown>;
    expect(typeof result.count).toBe("number");
    expect(Array.isArray(result.ids)).toBe(true);
  });

  test("supports --explain-score on suggest", () => {
    json(
      "add",
      "JWT auth middleware uses RS256",
      "--tags",
      "auth,jwt,middleware",
    );
    const result = json(
      "suggest",
      "--files",
      "src/auth/jwt.ts,src/middleware/session.ts",
      "--explain-score",
    ) as Record<string, unknown>;
    const weights = asJsonObject(result.score_weights);
    expect(weights.recency).toBeDefined();
    expect(weights.certainty).toBeDefined();
    expect(weights.tagMatch).toBeDefined();
    expect(weights.updateCount).toBeDefined();
    expect(weights.ftsRank).toBeDefined();
  });

  test("normalizes file paths and returns normalized path terms", () => {
    json("add", "JWT auth middleware uses RS256", "--tags", "auth,jwt");
    const result = json(
      "suggest",
      "--files-json",
      '["./src\\\\auth\\\\jwt.ts","src//middleware//session.ts"]',
    ) as Record<string, unknown>;
    expect(result.normalized_files).toEqual([
      "src/auth/jwt.ts",
      "src/middleware/session.ts",
    ]);
    const pathTerms = result.normalized_path_terms as string[];
    expect(pathTerms).toContain("auth");
    expect(pathTerms).toContain("jwt");
    expect(pathTerms).toContain("middleware");
    expect(pathTerms).toContain("session");
  });

  test("supports context-dense --brief output on suggest", () => {
    json("add", "Client auth token lifecycle", "--tags", "client,auth,status");
    const lines = briefLines(
      "suggest",
      "--files",
      "src/client/auth.ts",
      "--brief",
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("[1]");
    expect(lines[0]).toContain("<inferred> <convention>");
    expect(lines[0]).toContain("(#client #auth #status)");
  });

  test("errors when both --files and --files-json are provided", () => {
    const result = exec(
      "suggest",
      "--files",
      "src/auth/jwt.ts",
      "--files-json",
      '["src/auth/jwt.ts"]',
    );
    const parsed = asJsonObject(parseJsonValue(result.stdout));
    expect(result.exitCode).toBe(1);
    expect(parsed.error).toContain("Use either --files or --files-json");
  });

  test("errors on invalid --files-json payload", () => {
    const result = exec("suggest", "--files-json", "[not-json]");
    const parsed = asJsonObject(parseJsonValue(result.stdout));
    expect(result.exitCode).toBe(1);
    expect(parsed.error).toContain("Invalid --files-json value");
  });
});

describe("sweep", () => {
  test("merges suggest/query/list results with source labels", () => {
    json(
      "add",
      "JWT auth middleware uses RS256 and rotates keys",
      "--tags",
      "auth,jwt,middleware",
    );
    const result = json(
      "sweep",
      "--files",
      "src/auth/jwt.ts,src/middleware/session.ts",
      "--query",
      "jwt rotates keys",
      "--tags",
      "auth",
    ) as Record<string, unknown>;
    const results = result.results as Record<string, unknown>[];
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    const first = results[0];
    expect(first).toBeDefined();
    if (!first) {
      throw new Error("Expected at least one sweep result");
    }
    const sources = first.sources as string[];
    expect(Array.isArray(sources)).toBe(true);
    expect(typeof first.score).toBe("number");
    expect(sources.length).toBeGreaterThan(0);
  });

  test("supports --json-min output on sweep", () => {
    json("add", "Sweep baseline memory", "--tags", "auth");
    const result = json(
      "sweep",
      "--files",
      "src/auth/jwt.ts",
      "--json-min",
    ) as Record<string, unknown>;
    expect(typeof result.count).toBe("number");
    expect(Array.isArray(result.ids)).toBe(true);
  });

  test("sorts sweep results by score then recency", () => {
    json("add", "older low confidence", "--tags", "ops", "--certainty", "speculative");
    Bun.sleepSync(1100);
    json("add", "newer medium confidence", "--tags", "ops", "--certainty", "inferred");
    Bun.sleepSync(1100);
    json("add", "newer high confidence", "--tags", "ops", "--certainty", "verified");

    const result = json("sweep", "--files", "src/ops/runbook.ts") as Record<
      string,
      unknown
    >;
    const rows = result.results as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThanOrEqual(3);

    for (let i = 0; i < rows.length - 1; i += 1) {
      const current = rows[i];
      const next = rows[i + 1];
      if (!current || !next) {
        continue;
      }
      const currentScore = Number(current.score ?? 0);
      const nextScore = Number(next.score ?? 0);
      expect(currentScore).toBeGreaterThanOrEqual(nextScore);
      if (currentScore === nextScore) {
        const currentUpdated = Date.parse(String(current.updated_at));
        const nextUpdated = Date.parse(String(next.updated_at));
        expect(currentUpdated).toBeGreaterThanOrEqual(nextUpdated);
      }
    }
  });

  test("errors when missing file inputs", () => {
    const result = exec("sweep");
    const parsed = asJsonObject(parseJsonValue(result.stdout));
    expect(result.exitCode).toBe(1);
    expect(parsed.error).toContain("Usage: sweep");
  });
});

describe("verify and diff", () => {
  test("verify returns consistent/conflict booleans", () => {
    json("add", "Auth uses JWT with RS256", "--tags", "auth,jwt");
    const consistent = json(
      "verify",
      "1",
      "Auth uses JWT with RS256 signatures",
    ) as Record<string, unknown>;
    expect(consistent.ok).toBe(true);

    const conflict = json("verify", "1", "Auth does not use JWT") as Record<
      string,
      unknown
    >;
    expect(conflict.ok).toBe(false);
    expect(conflict.result).toBe("conflict");
  });

  test("diff reports added/removed terms and conflict status", () => {
    json("add", "Database uses Postgres for writes");
    const result = json(
      "diff",
      "1",
      "Database uses SQLite for writes",
    ) as Record<string, unknown>;
    expect(typeof result.conflict).toBe("boolean");
    expect(Array.isArray(result.added_terms)).toBe(true);
    expect(Array.isArray(result.removed_terms)).toBe(true);
  });
});
