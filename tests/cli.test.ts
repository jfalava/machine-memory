import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = join(import.meta.dir, "..", "src", "app.ts");
let testDir: string;
const extraEnv: Record<string, string> = {};

// Mock server for upgrade tests — node:http so we can .unref() it
let mockHandler: (req: IncomingMessage, res: ServerResponse) => void = (
  _req,
  res,
) => {
  res.writeHead(500);
  res.end();
};
const mockServer = createServer((req, res) => {
  mockHandler(req, res);
});
mockServer.listen(0);
mockServer.unref();
const mockPort = (mockServer.address() as { port: number }).port;

function mockJson(res: ServerResponse, statusCode: number, body: unknown) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function exec(...args: string[]): { stdout: string; exitCode: number } {
  const result = Bun.spawnSync(["bun", CLI, ...args], {
    cwd: testDir,
    env: { ...process.env, ...extraEnv },
  });
  return {
    stdout: result.stdout.toString().trim(),
    exitCode: result.exitCode,
  };
}

function parseJsonValue(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function asJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected JSON object");
  }
  return value as Record<string, unknown>;
}

function json(
  ...args: string[]
): Record<string, unknown> | Record<string, unknown>[] {
  const { stdout } = exec(...args);
  return parseJsonValue(stdout) as
    | Record<string, unknown>
    | Record<string, unknown>[];
}

function dbRun(sql: string, params: SQLQueryBindings[] = []) {
  const dbPath = join(testDir, ".agents", "memory.db");
  const db = new Database(dbPath);
  try {
    db.run(sql, params);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "mm-test-"));
});

afterAll(() => {
  mockServer.close();
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
});

// --- Database creation ---

describe("database initialization", () => {
  test("creates .agents/memory.db on first command", () => {
    exec("list");
    expect(existsSync(join(testDir, ".agents", "memory.db"))).toBe(true);
  });

  test("creates .agents directory if missing", () => {
    expect(existsSync(join(testDir, ".agents"))).toBe(false);
    exec("list");
    expect(existsSync(join(testDir, ".agents"))).toBe(true);
  });
});

// --- No command ---

describe("no command", () => {
  test("exits with error and shows help when no command given", () => {
    const result = exec();
    const parsed = asJsonObject(parseJsonValue(result.stdout));
    expect(result.exitCode).toBe(1);
    expect(parsed.name).toBe("machine-memory");
    expect(parsed.commands).toBeDefined();
  });
});

// --- help ---

describe("help", () => {
  test("returns help JSON with commands and guidance", () => {
    const result = exec("help");
    const parsed = asJsonObject(parseJsonValue(result.stdout));
    const commands = asJsonObject(parsed.commands);
    expect(result.exitCode).toBe(0);
    expect(parsed.name).toBe("machine-memory");
    expect(parsed.commands).toBeDefined();
    expect(commands.add).toBeDefined();
    expect(commands.query).toBeDefined();
    expect(parsed.what_to_store).toBeInstanceOf(Array);
  });

  test("does not create database", () => {
    exec("help");
    expect(existsSync(join(testDir, ".agents", "memory.db"))).toBe(false);
  });
});

// --- Unknown command ---

describe("unknown command", () => {
  test("exits with error for unknown command", () => {
    const result = exec("foo");
    const parsed = asJsonObject(parseJsonValue(result.stdout));
    expect(result.exitCode).toBe(1);
    expect(parsed.error).toContain("Unknown command: foo");
  });
});

// --- version ---

describe("version", () => {
  test("returns version as JSON", () => {
    const result = json("version");
    expect(result).toHaveProperty("version");
    expect(typeof (result as Record<string, unknown>).version).toBe("string");
  });

  test("does not create database", () => {
    exec("version");
    expect(existsSync(join(testDir, ".agents", "memory.db"))).toBe(false);
  });
});

// --- add ---

describe("add", () => {
  test("adds a memory and returns it with id", () => {
    const result = json("add", "test content") as Record<string, unknown>;
    expect(result.id).toBe(1);
    expect(result.content).toBe("test content");
    expect(result.tags).toBe("");
    expect(result.context).toBe("");
  });

  test("adds a memory with tags", () => {
    const result = json("add", "tagged", "--tags", "a,b") as Record<
      string,
      unknown
    >;
    expect(result.tags).toBe("a,b");
  });

  test("adds a memory with context", () => {
    const result = json(
      "add",
      "with context",
      "--context",
      "some reason",
    ) as Record<string, unknown>;
    expect(result.context).toBe("some reason");
  });

  test("adds a memory with tags and context", () => {
    const result = json(
      "add",
      "full",
      "--tags",
      "x",
      "--context",
      "y",
    ) as Record<string, unknown>;
    expect(result.tags).toBe("x");
    expect(result.context).toBe("y");
  });

  test("auto-increments ids", () => {
    const first = json("add", "first") as Record<string, unknown>;
    const second = json("add", "second") as Record<string, unknown>;
    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
  });

  test("errors when no content provided", () => {
    const result = exec("add");
    expect(result.exitCode).toBe(1);
    const parsed = asJsonObject(parseJsonValue(result.stdout));
    expect(parsed.error).toContain("Usage:");
  });
});

// --- get ---

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

// --- update ---

describe("update", () => {
  test("updates content of a memory", () => {
    json("add", "original");
    const result = json("update", "1", "modified") as Record<string, unknown>;
    expect(result.content).toBe("modified");
  });

  test("updates tags", () => {
    json("add", "item", "--tags", "old");
    const result = json("update", "1", "item", "--tags", "new") as Record<
      string,
      unknown
    >;
    expect(result.tags).toBe("new");
  });

  test("updates context", () => {
    json("add", "item", "--context", "old reason");
    const result = json(
      "update",
      "1",
      "item",
      "--context",
      "new reason",
    ) as Record<string, unknown>;
    expect(result.context).toBe("new reason");
  });

  test("updates updated_at timestamp", () => {
    json("add", "item");
    const original = json("get", "1") as Record<string, unknown>;
    // Small delay to ensure timestamp difference
    Bun.sleepSync(1100);
    json("update", "1", "changed");
    const modified = json("get", "1") as Record<string, unknown>;
    expect(modified.updated_at).not.toBe(original.updated_at);
  });

  test("preserves tags when not specified in update", () => {
    json("add", "item", "--tags", "keep-me");
    json("update", "1", "new content");
    const result = json("get", "1") as Record<string, unknown>;
    expect(result.tags).toBe("keep-me");
  });

  test("returns error for nonexistent id", () => {
    const result = json("update", "999", "content") as Record<string, unknown>;
    expect(result.error).toBe("Not found");
  });

  test("errors when missing arguments", () => {
    const result = exec("update");
    expect(result.exitCode).toBe(1);
  });
});

// --- delete ---

describe("delete", () => {
  test("deletes a memory", () => {
    json("add", "to delete");
    const result = json("delete", "1") as Record<string, unknown>;
    expect(result.deleted).toBe(1);
  });

  test("memory is gone after delete", () => {
    json("add", "gone");
    json("delete", "1");
    const result = json("get", "1") as Record<string, unknown>;
    expect(result.error).toBe("Not found");
  });

  test("errors when no id provided", () => {
    const result = exec("delete");
    expect(result.exitCode).toBe(1);
  });
});

// --- list ---

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
});

// --- query (FTS) ---

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

  test("returns empty array when nothing matches", () => {
    json("add", "unrelated content");
    const result = json("query", "xyznonexistent");
    expect(result).toEqual([]);
  });

  test("errors when no search term provided", () => {
    const result = exec("query");
    expect(result.exitCode).toBe(1);
  });

  test("FTS stays in sync after update", () => {
    json("add", "original keyword");
    json("update", "1", "replacement term");
    const old = json("query", "original") as Record<string, unknown>[];
    const updated = json("query", "replacement") as Record<string, unknown>[];
    expect(old).toHaveLength(0);
    expect(updated).toHaveLength(1);
  });

  test("FTS stays in sync after delete", () => {
    json("add", "searchable content");
    json("delete", "1");
    const result = json("query", "searchable");
    expect(result).toEqual([]);
  });
});

// --- Checklist feature coverage ---

describe("checklist: deprecation and invalidation", () => {
  test("deprecate marks status and query excludes deprecated by default", () => {
    json("add", "legacy auth token format");
    json("add", "new auth token format");

    const deprecated = json(
      "deprecate",
      "1",
      "--superseded-by",
      "2",
    ) as Record<string, unknown>;
    expect(deprecated.status).toBe("superseded_by");
    expect(deprecated.superseded_by).toBe(2);

    const defaultQuery = json("query", "legacy") as Record<string, unknown>[];
    expect(defaultQuery).toEqual([]);

    const withDeprecated = json(
      "query",
      "legacy",
      "--include-deprecated",
    ) as Record<string, unknown>[];
    expect(withDeprecated).toHaveLength(1);
    expect(withDeprecated[0]?.id).toBe(1);
  });
});

describe("checklist: structured memory_type", () => {
  test("supports --type on add, update, list, and query", () => {
    json("add", "routing rule alpha", "--type", "decision");
    json("add", "routing rule beta", "--type", "gotcha");

    const listed = json("list", "--type", "decision") as Record<string, unknown>[];
    expect(listed).toHaveLength(1);
    expect(listed[0]?.memory_type).toBe("decision");

    const queried = json(
      "query",
      "routing",
      "--type",
      "decision",
    ) as Record<string, unknown>[];
    expect(queried).toHaveLength(1);
    expect(queried[0]?.id).toBe(1);

    const updated = json(
      "update",
      "1",
      "routing rule alpha",
      "--type",
      "constraint",
    ) as Record<string, unknown>;
    expect(updated.memory_type).toBe("constraint");
  });
});

describe("checklist: provenance fields", () => {
  test("tracks source_agent, last_updated_by, created_at, and update_count", () => {
    const created = json(
      "add",
      "provenance memory",
      "--source-agent",
      "claude-sonnet-4-6",
    ) as Record<string, unknown>;

    expect(created.source_agent).toBe("claude-sonnet-4-6");
    expect(created.last_updated_by).toBe("claude-sonnet-4-6");
    expect(created).toHaveProperty("created_at");
    expect(created.update_count).toBe(0);

    const updated = json(
      "update",
      "1",
      "provenance memory revised",
      "--updated-by",
      "gpt-5-codex",
    ) as Record<string, unknown>;
    expect(updated.last_updated_by).toBe("gpt-5-codex");
    expect(updated.update_count).toBe(1);
  });
});

describe("checklist: certainty field", () => {
  test("defaults certainty to soft and supports updates", () => {
    const created = json("add", "certainty test") as Record<string, unknown>;
    expect(created.certainty).toBe("soft");

    const updated = json(
      "update",
      "1",
      "certainty test",
      "--certainty",
      "hard",
    ) as Record<string, unknown>;
    expect(updated.certainty).toBe("hard");

    const listed = json("list", "--certainty", "hard") as Record<string, unknown>[];
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(1);
  });
});

describe("checklist: conflict detection on add", () => {
  test("returns potential_conflicts in add response", () => {
    json("add", "JWT middleware uses RS256 signatures", "--tags", "auth,jwt");

    const created = json(
      "add",
      "Auth JWT middleware signs with RS256",
      "--tags",
      "auth",
    ) as Record<string, unknown>;

    const conflicts = created.potential_conflicts as Record<string, unknown>[];
    expect(Array.isArray(conflicts)).toBe(true);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.some((item) => item.id === 1)).toBe(true);
  });
});

describe("checklist: query result scoring", () => {
  test("returns score on results and sorts descending", () => {
    json(
      "add",
      "cache invalidation rules for auth responses",
      "--tags",
      "cache,auth",
      "--certainty",
      "hard",
    );
    json(
      "add",
      "cache invalidation note for auth responses",
      "--tags",
      "notes",
      "--certainty",
      "uncertain",
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

    const result = json("query", "cache invalidation") as Record<string, unknown>[];
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(typeof result[0]?.score).toBe("number");
    expect(typeof result[1]?.score).toBe("number");
    expect(Number(result[0]?.score)).toBeGreaterThanOrEqual(Number(result[1]?.score));
    expect(result[0]?.id).toBe(1);
  });
});

describe("checklist: suggest --files", () => {
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
});

describe("checklist: coverage command", () => {
  test("reports uncovered paths and tag distribution", () => {
    mkdirSync(join(testDir, "src", "db"), { recursive: true });
    mkdirSync(join(testDir, "src", "workers"), { recursive: true });

    json("add", "DB layer notes", "--tags", "db");

    const result = json("coverage", "--root", ".") as Record<string, unknown>;
    const uncovered = result.uncovered_paths as string[];
    const distribution = result.tag_distribution as Record<string, unknown>;

    expect(Array.isArray(uncovered)).toBe(true);
    expect(uncovered).toContain("src/workers/");
    expect(distribution.db).toBe(1);
  });
});

describe("checklist: refs field", () => {
  test("stores refs internally and returns refs as arrays on add/update", () => {
    const created = json(
      "add",
      "refs example",
      "--refs",
      '["https://example.com/pr/1","docs/adr-001.md"]',
    ) as Record<string, unknown>;
    expect(created.refs).toEqual([
      "https://example.com/pr/1",
      "docs/adr-001.md",
    ]);

    const updated = json(
      "update",
      "1",
      "refs example updated",
      "--refs",
      '["https://example.com/issues/2"]',
    ) as Record<string, unknown>;
    expect(updated.refs).toEqual(["https://example.com/issues/2"]);
  });
});

describe("checklist: ttl and gc", () => {
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

describe("checklist: stats command", () => {
  test("returns memory health breakdowns and stale/no-tag counts", () => {
    json("add", "old architecture fact", "--type", "decision", "--certainty", "hard");
    json(
      "add",
      "db gotcha",
      "--tags",
      "db,auth",
      "--type",
      "gotcha",
      "--certainty",
      "uncertain",
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
    expect(byCertainty.hard).toBe(1);
    expect(byCertainty.uncertain).toBe(1);
    expect(tags.db).toBe(1);
    expect(oldest.id).toBe(1);
    expect(stats.memories_not_updated_over_90_days).toBe(1);
    expect(stats.memories_with_no_tags).toBe(1);
  });
});

describe("checklist: bulk import", () => {
  test("returns per-entry success|conflict|skip statuses", () => {
    json("add", "exact duplicate seed", "--tags", "seed", "--context", "ctx");
    json("add", "JWT auth middleware uses RS256", "--tags", "auth,jwt");

    const importPath = join(testDir, "memories.json");
    writeFileSync(
      importPath,
      JSON.stringify([
        { content: "exact duplicate seed", tags: "seed", context: "ctx" },
        { content: "Auth middleware signs JWT with RS256", tags: "auth" },
        {
          content: "imported unique memory",
          tags: "imported",
          memory_type: "decision",
          certainty: "hard",
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

    const imported = json("list", "--tags", "imported") as Record<string, unknown>[];
    expect(imported).toHaveLength(1);
  });
});

describe("checklist: export command", () => {
  test("exports active memories and supports type/tag/certainty/since filters", () => {
    json(
      "add",
      "auth export target",
      "--tags",
      "auth",
      "--type",
      "decision",
      "--certainty",
      "hard",
    );
    json(
      "add",
      "deprecated export target",
      "--tags",
      "auth",
      "--type",
      "decision",
      "--certainty",
      "hard",
    );
    json("deprecate", "2");

    const filtered = json(
      "export",
      "--tags",
      "auth",
      "--type",
      "decision",
      "--certainty",
      "hard",
    ) as Record<string, unknown>[];
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe(1);
    expect(filtered[0]?.status).toBe("active");

    const future = json(
      "export",
      "--since",
      "2999-01-01T00:00:00Z",
    ) as Record<string, unknown>[];
    expect(future).toEqual([]);
  });
});

// --- JSON output format ---

describe("output format", () => {
  test("all output is valid JSON", () => {
    const commands = [
      ["add", "test"],
      ["list"],
      ["get", "1"],
      ["query", "test"],
      ["version"],
    ];
    for (const entry of commands) {
      const { stdout } = exec(...entry);
      expect(() => {
        void parseJsonValue(stdout);
      }).not.toThrow();
    }
  });
});

// --- upgrade ---

// TODO: mock server (Bun.serve / node:http) keeps the event loop alive and hangs bun test
describe.skip("upgrade", () => {
  let fakeBinPath: string;

  beforeEach(() => {
    fakeBinPath = join(testDir, "machine-memory-fake");
    writeFileSync(fakeBinPath, "original-binary-content");
    extraEnv["MACHINE_MEMORY_API_URL"] = `http://localhost:${mockPort}`;
    extraEnv["MACHINE_MEMORY_BIN_PATH"] = fakeBinPath;
  });

  test("reports already up to date when versions match", () => {
    mockHandler = (_req, res) => {
      mockJson(res, 200, { tag_name: "v0.1.0", assets: [] });
    };
    const result = json("upgrade") as Record<string, unknown>;
    expect(result.message).toBe("Already up to date");
    expect(result.version).toBe("0.1.0");
  });

  test("errors when API returns non-200", () => {
    mockHandler = (_req, res) => {
      res.writeHead(404);
      res.end("Not Found");
    };
    const result = exec("upgrade");
    const parsed = asJsonObject(parseJsonValue(result.stdout));
    expect(result.exitCode).toBe(1);
    expect(parsed.error).toContain("Failed to fetch latest release: 404");
  });

  test("errors when no matching binary for platform", () => {
    mockHandler = (_req, res) => {
      mockJson(res, 200, {
        tag_name: "v99.0.0",
        assets: [
          { name: "machine-memory-fake-arch", browser_download_url: "" },
        ],
      });
    };
    const result = exec("upgrade");
    const parsed = asJsonObject(parseJsonValue(result.stdout));
    expect(result.exitCode).toBe(1);
    expect(parsed.error).toContain("No binary found");
    expect(parsed.available).toEqual(["machine-memory-fake-arch"]);
  });

  test("errors when binary download fails", () => {
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const assetName = `machine-memory-${platform}-${arch}`;

    mockHandler = (req, res) => {
      if (req.url?.includes("/releases/latest")) {
        mockJson(res, 200, {
          tag_name: "v99.0.0",
          assets: [
            {
              name: assetName,
              browser_download_url: `http://localhost:${mockPort}/download`,
            },
          ],
        });
        return;
      }
      res.writeHead(500);
      res.end("Server Error");
    };
    const result = exec("upgrade");
    const parsed = asJsonObject(parseJsonValue(result.stdout));
    expect(result.exitCode).toBe(1);
    expect(parsed.error).toContain("Download failed: 500");
  });

  test("successfully downloads and replaces binary", () => {
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const assetName = `machine-memory-${platform}-${arch}`;
    const newContent = "new-binary-content-v2";

    mockHandler = (req, res) => {
      if (req.url?.includes("/releases/latest")) {
        mockJson(res, 200, {
          tag_name: "v2.0.0",
          assets: [
            {
              name: assetName,
              browser_download_url: `http://localhost:${mockPort}/download`,
            },
          ],
        });
        return;
      }
      res.writeHead(200);
      res.end(newContent);
    };

    const result = json("upgrade") as Record<string, unknown>;
    expect(result.message).toBe("Upgraded");
    expect(result.from).toBe("0.1.0");
    expect(result.to).toBe("2.0.0");

    const replaced = readFileSync(fakeBinPath, "utf-8");
    expect(replaced).toBe(newContent);

    expect(existsSync(`${fakeBinPath}.bak`)).toBe(false);
    expect(existsSync(`${fakeBinPath}.tmp`)).toBe(false);
  });

  test("does not create database", () => {
    mockHandler = (_req, res) => {
      mockJson(res, 200, { tag_name: "v0.1.0", assets: [] });
    };
    exec("upgrade");
    expect(existsSync(join(testDir, ".agents", "memory.db"))).toBe(false);
  });
});
