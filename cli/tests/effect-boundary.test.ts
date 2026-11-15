import {
  compareMemoryFact,
  deriveFileNeighborhood,
} from "@machine-memory/contract";
import { Cause, Effect, Exit, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  handleIndexCommand,
  handleReindexCommand,
} from "@/cli/commands/reindex";
import type { CommandContext } from "@/cli/runtime/context";
import {
  combineHybridResults,
  normalizeSqliteRow,
  parseIdSpec,
  queryNeighborhoodMatches,
} from "@/cli/shared";
import {
  databaseConfig,
  loadDatabaseConfig,
  normalizeRemoteUrl,
  validateDatabaseBackendFlags,
} from "@/database-config";
import type { SqlQueryBinding } from "@/db";
import { MemoryDatabase, type MemoryDatabaseApi } from "@/effect/database";
import { MemoryDatabaseError } from "@/effect/errors";
import { remoteLayer } from "@/effect/remote-database";

const decodeIndexStatus = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.StructWithRest(
      Schema.Struct({ oldest_pending_seconds: Schema.NullOr(Schema.Finite) }),
      [Schema.Record(Schema.String, Schema.Json)],
    ),
  ),
);

describe("Effect application boundaries", () => {
  it("preserves the existing pure memory semantics", () => {
    expect(parseIdSpec("3,1,3")).toEqual([3, 1]);
    expect(
      normalizeSqliteRow({ certainty: "verified", refs: '["docs/a.md"]' }),
    ).toMatchObject({
      certainty: "verified",
      refs: ["docs/a.md"],
    });
    expect(
      compareMemoryFact("Effect is used", "Effect is not used").conflict,
    ).toBe(true);
  });

  it("queries long suggest paths as literal substrings without wildcards", async () => {
    const calls: Array<[string, SqlQueryBinding[]]> = [];
    const all: MemoryDatabaseApi["all"] = (sql, params = []) => {
      calls.push([sql, [...params]]);
      return Effect.succeed([]);
    };
    const database: MemoryDatabaseApi = {
      run: () => Effect.void.pipe(Effect.as(undefined)),
      get: () => Effect.void.pipe(Effect.as(undefined)),
      all,
    };
    const neighborhood = deriveFileNeighborhood([
      "web/portal/src/components/references/gallery/gallery-tab.tsx",
    ]);

    await Effect.runPromise(
      queryNeighborhoodMatches(
        database,
        neighborhood,
        { includeDeprecated: false },
        8,
      ),
    );
    expect(neighborhood.pathHints).toEqual([
      "web/portal/src/components/references/gallery/",
    ]);
    const [sql, params] = calls[0] ?? ["", []];
    expect(sql).toContain("INSTR(LOWER(m.content), ?) > 0");
    expect(sql).not.toContain("LIKE");
    expect(params).toContain("web/portal/src/components/references/gallery/");
    expect(
      params?.some(
        (param) => Schema.is(Schema.String)(param) && param.includes("%"),
      ),
    ).toBe(false);
  });

  it("preserves actionable remote query errors through the CLI database layer", async () => {
    const guidance =
      "Full-text query could not be parsed. Use simpler words and remove FTS punctuation or operators.";
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: guidance }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const database = yield* MemoryDatabase;
          return yield* database.all("SELECT * FROM memories");
        }).pipe(
          Effect.provide(remoteLayer("https://memory.test/query", "token")),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(guidance);
      }
    } finally {
      fetch.mockRestore();
    }
  });

  it("fails if server-side reindex queueing fails, including quiet mode", async () => {
    const failure = new MemoryDatabaseError({
      operation: "reindex",
      message: "Vectorize unavailable",
      cause: undefined,
    });
    const database: MemoryDatabaseApi = {
      run: () => Effect.fail(failure),
      get: () => Effect.succeed(null),
      all: () =>
        Effect.succeed([
          {
            id: 1,
            repository: "jfalava/machine-memory",
            content: "A memory that needs indexing",
          },
        ]),
      vectorize: {
        search: () => Effect.succeed({ count: 0, matches: [] }),
      },
    };
    const context = (outputMode: {
      jsonMin: boolean;
      quiet: boolean;
    }): CommandContext => ({
      flags: new Map([["--remote", true]]),
      positionals: [],
      command: "reindex",
      outputMode: {
        brief: false,
        jsonMin: outputMode.jsonMin,
        pretty: false,
        quiet: outputMode.quiet,
      },
      database,
      // SAFETY: handleReindexCommand never reads context.fileSystem.
      fileSystem: {} as CommandContext["fileSystem"],
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      const jsonExit = await Effect.runPromiseExit(
        handleReindexCommand(context({ jsonMin: true, quiet: false })),
      );
      expect(jsonExit._tag).toBe("Failure");
      expect(info).not.toHaveBeenCalled();

      info.mockClear();
      const quietExit = await Effect.runPromiseExit(
        handleReindexCommand(context({ jsonMin: false, quiet: true })),
      );
      expect(quietExit._tag).toBe("Failure");
      expect(info).not.toHaveBeenCalled();

      info.mockClear();
      const humanExit = await Effect.runPromiseExit(
        handleReindexCommand(context({ jsonMin: false, quiet: false })),
      );
      expect(humanExit._tag).toBe("Failure");
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });

  it("queues reindex atomically on the server without indexing client snapshots", async () => {
    const run = vi.fn((_sql: string, _params?: unknown[]) =>
      Effect.succeed({ changes: 1 }),
    );
    const database: MemoryDatabaseApi = {
      run,
      get: () => Effect.succeed(null),
      all: () =>
        Effect.succeed([
          {
            id: 1,
            repository: "jfalava/machine-memory",
            content: "A memory that needs indexing",
          },
        ]),
      vectorize: {
        search: () => Effect.succeed({ count: 0, matches: [] }),
      },
    };
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      const exit = await Effect.runPromiseExit(
        handleReindexCommand({
          flags: new Map([
            ["--remote", true],
            ["--json-min", true],
          ]),
          positionals: [],
          outputMode: {
            brief: false,
            jsonMin: true,
            pretty: false,
            quiet: false,
          },
          command: "reindex",
          database,
          // SAFETY: handleReindexCommand never reads context.fileSystem.
          fileSystem: {} as CommandContext["fileSystem"],
        }),
      );

      expect(exit._tag).toBe("Success");
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0]).toContain("UPDATE memory_vector_sync");
      expect(run.mock.calls[0]?.[0]).toContain("WHERE repository = ?");
      expect(info).toHaveBeenCalledWith(expect.stringContaining('"queued":1'));
    } finally {
      info.mockRestore();
    }
  });

  type IndexFlag = [string, string | true];

  /** A remote database whose writes and reads are recorded by the test. */
  function indexContext(
    command: string,
    flags: IndexFlag[],
    database: Pick<MemoryDatabaseApi, "run" | "get" | "all">,
    positionals: string[] = [],
  ): CommandContext {
    return {
      flags: new Map<string, string | true>([["--remote", true], ...flags]),
      positionals,
      outputMode: {
        brief: false,
        jsonMin: false,
        pretty: false,
        quiet: false,
      },
      command,
      database: {
        ...database,
        vectorize: { search: () => Effect.succeed({ count: 0, matches: [] }) },
      },
      // SAFETY: the index commands never read context.fileSystem.
      fileSystem: {} as CommandContext["fileSystem"],
    };
  }

  const reindexCases: {
    flags: IndexFlag[];
    where: string | undefined;
    params: (string | number)[];
  }[] = [
    {
      flags: [["--failed-only", true]],
      where:
        "WHERE repository = ? AND generation > delivered_generation AND last_error IS NOT NULL",
      params: ["jfalava/machine-memory"],
    },
    {
      flags: [["--id", "7,9"]],
      where: "WHERE repository = ? AND memory_id IN (?, ?)",
      params: ["jfalava/machine-memory", 7, 9],
    },
    {
      flags: [
        ["--all-repos", true],
        ["--failed-only", true],
      ],
      where:
        "WHERE generation > delivered_generation AND last_error IS NOT NULL",
      params: [],
    },
    {
      flags: [["--all-repos", true]],
      where: undefined,
      params: [],
    },
  ];
  it.each(reindexCases)(
    "reindex narrows the queued rows: $flags",
    async ({ flags, where, params }) => {
      const run = vi.fn((_sql: string, _params?: unknown[]) =>
        Effect.succeed({ changes: 1 }),
      );
      const info = vi
        .spyOn(console, "info")
        .mockImplementation(() => undefined);
      try {
        const exit = await Effect.runPromiseExit(
          handleReindexCommand(
            indexContext("reindex", flags, {
              run,
              get: () => Effect.undefined,
              all: () => Effect.succeed([]),
            }),
          ),
        );
        expect(exit._tag).toBe("Success");
        const [sql, bound] = run.mock.calls[0] ?? [];
        if (where === undefined) {
          expect(sql).not.toContain("WHERE");
        } else {
          expect(String(sql).replace(/\s+/g, " ")).toContain(where);
        }
        expect(sql).toContain("queued_at = unixepoch() * 1000");
        expect(bound).toEqual(params);
      } finally {
        info.mockRestore();
      }
    },
  );

  it("reindex refuses --id together with --all-repos", async () => {
    const run = vi.fn(() => Effect.succeed({ changes: 1 }));
    const exit = await Effect.runPromiseExit(
      Effect.suspend(() =>
        handleReindexCommand(
          indexContext(
            "reindex",
            [
              ["--all-repos", true],
              ["--id", "7"],
            ],
            {
              run,
              get: () => Effect.undefined,
              all: () => Effect.succeed([]),
            },
          ),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
    expect(run).not.toHaveBeenCalled();
  });

  it("index status reports pending, retrying and parked records with their errors", async () => {
    const now = Date.now();
    const get = vi.fn((_sql: string, _params?: unknown[]) =>
      Effect.succeed({
        pending: 3,
        retrying: 2,
        parked: 1,
        oldest_queued_at: now - 90_000,
      }),
    );
    const all = vi.fn((_sql: string, _params?: unknown[]) =>
      Effect.succeed([
        { error: "AI unavailable", parked: 0, count: 2, ids: "4,5" },
        {
          error: "Memory is over by 1 bytes of 2,000.",
          parked: 1,
          count: 1,
          ids: "9",
        },
      ]),
    );
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const exit = await Effect.runPromiseExit(
        handleIndexCommand(
          indexContext(
            "index",
            [],
            { run: () => Effect.succeed({}), get, all },
            ["status"],
          ),
        ),
      );
      expect(exit._tag).toBe("Success");
      expect(get.mock.calls[0]?.[1]?.at(-1)).toBe("jfalava/machine-memory");
      const printed = decodeIndexStatus(String(info.mock.calls[0]?.[0]));
      expect(printed).toMatchObject({
        repository: "jfalava/machine-memory",
        all_repositories: false,
        pending: 3,
        retrying: 2,
        parked: 1,
        failures: [
          { error: "AI unavailable", state: "retrying", count: 2, ids: [4, 5] },
          {
            error: "Memory is over by 1 bytes of 2,000.",
            state: "parked",
            count: 1,
            ids: [9],
          },
        ],
      });
      expect(printed.oldest_pending_seconds).toBeGreaterThanOrEqual(90);
      expect(printed.oldest_pending_seconds).toBeLessThan(120);
    } finally {
      info.mockRestore();
    }
  });

  it("index status --all-repos reads every repository", async () => {
    const get = vi.fn((_sql: string, _params?: unknown[]) =>
      Effect.succeed({
        pending: 0,
        retrying: 0,
        parked: 0,
        oldest_queued_at: null,
      }),
    );
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await Effect.runPromise(
        handleIndexCommand(
          indexContext(
            "index",
            [["--all-repos", true]],
            {
              run: () => Effect.succeed({}),
              get,
              all: () => Effect.succeed([]),
            },
            ["status"],
          ),
        ),
      );
      expect(get.mock.calls[0]?.[0]).not.toContain("repository = ?");
      expect(decodeIndexStatus(String(info.mock.calls[0]?.[0]))).toMatchObject({
        repository: null,
        all_repositories: true,
        pending: 0,
        oldest_pending_seconds: null,
        failures: [],
      });
    } finally {
      info.mockRestore();
    }
  });

  it("fuses lexical and semantic results by rank, not score scale", () => {
    // Weighted score blending would rank #2 (near-top lexical score) above #3;
    // reciprocal-rank fusion only sees that #3 is the best semantic hit.
    const results = combineHybridResults(
      [
        { id: 1, score: 90 },
        { id: 2, score: 89 },
      ],
      [
        { id: 3, score: 0.99, semantic_score: 0.99 },
        { id: 1, score: 0.1, semantic_score: 0.1 },
      ],
      3,
      true,
    );

    expect(results.map((row) => row.id)).toEqual([1, 3, 2]);
    expect(results[0]).toMatchObject({
      fts_score: 90,
      semantic_score: 0.1,
      hybrid_score: 1 / 61 + 1 / 62,
      score: 1 / 61 + 1 / 62,
    });
    expect(results[0]?.score_breakdown).toEqual({
      fts: { rank: 1, contribution: 1 / 61 },
      semantic: { rank: 2, contribution: 1 / 62 },
      total: 1 / 61 + 1 / 62,
    });
    expect(results[2]?.score_breakdown).toMatchObject({
      semantic: { rank: null, contribution: 0 },
    });
  });

  it("selects the remote backend from explicit configuration", async () => {
    expect(
      databaseConfig({
        MACHINE_MEMORY_DB_URL: "https://memory.example/query",
        MACHINE_MEMORY_DB_TOKEN: "secret",
      }),
    ).toEqual({
      kind: "remote",
      url: "https://memory.example/query",
      token: "secret",
    });
    expect(
      databaseConfig({
        MACHINE_MEMORY_DB_URL: "https://memory.example",
        MACHINE_MEMORY_DB_TOKEN: "secret",
      }),
    ).toEqual({
      kind: "remote",
      url: "https://memory.example/query",
      token: "secret",
    });
    await expect(
      loadDatabaseConfig(
        {
          MACHINE_MEMORY_DB_URL: "https://memory.example",
          MACHINE_MEMORY_DB_TOKEN: "secret",
        },
        { local: false, remote: true },
      ),
    ).resolves.toEqual({
      kind: "remote",
      url: "https://memory.example/query",
      token: "secret",
    });
    expect(databaseConfig({})).toEqual({ kind: "local" });
    expect(
      databaseConfig(
        {
          MACHINE_MEMORY_DB_URL: "https://memory.example/query",
          MACHINE_MEMORY_DB_TOKEN: "secret",
        },
        { local: true, remote: false },
      ),
    ).toEqual({ kind: "local" });
    expect(() => databaseConfig({}, { local: true, remote: true })).toThrow(
      "Choose only one database backend",
    );
    expect(() =>
      validateDatabaseBackendFlags({ local: false, remote: false }, true),
    ).toThrow("Choose a database backend explicitly");
    expect(normalizeRemoteUrl("https://memory.example.workers.dev/")).toBe(
      "https://memory.example.workers.dev/query",
    );
  });

  it("keeps an explicit --local selection even when stored remote credentials exist", async () => {
    const storedCredentials = JSON.stringify({
      url: "https://stored.example/query",
      token: "stored-token",
    });
    const secretsGet = vi.fn().mockResolvedValue(storedCredentials);
    vi.stubGlobal("Bun", { secrets: { get: secretsGet } });

    try {
      await expect(
        loadDatabaseConfig({}, { local: true, remote: false }),
      ).resolves.toEqual({ kind: "local" });
      // The stored credential lookup must not be consulted at all.
      expect(secretsGet).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
