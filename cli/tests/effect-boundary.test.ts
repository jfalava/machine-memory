import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { MemoryDatabaseApi } from "@/effect/database";
import { CommandError, MemoryDatabaseError } from "@/effect/errors";
import { handleReindexCommand } from "@/cli/commands/reindex";
import type { CommandContext } from "@/cli/runtime/context";
import { compareFact } from "@/cli/features/memory/compare";
import {
  combineHybridResults,
  normalizeSqliteRow,
  parseIdSpec,
} from "@/cli/shared";
import {
  databaseConfig,
  loadDatabaseConfig,
  normalizeRemoteUrl,
  validateDatabaseBackendFlags,
} from "@/database-config";

describe("Effect application boundaries", () => {
  it("represents command failures as tagged errors", () => {
    const error = new CommandError({
      command: "query",
      message: "A search term is required.",
      cause: undefined,
    });

    expect(error._tag).toBe("CommandError");
    expect(error.message).toBe("A search term is required.");
  });

  it("keeps database failures in the typed error channel", async () => {
    const result = await Effect.runPromiseExit(
      Effect.fail(
        new MemoryDatabaseError({
          operation: "get",
          message: "locked",
          cause: undefined,
        }),
      ),
    );

    expect(result._tag).toBe("Failure");
  });

  it("preserves the existing pure memory semantics", () => {
    expect(parseIdSpec("3,1,3")).toEqual([3, 1]);
    expect(
      normalizeSqliteRow({ certainty: "hard", refs: '["docs/a.md"]' }),
    ).toMatchObject({
      certainty: "verified",
      refs: ["docs/a.md"],
    });
    expect(compareFact("Effect is used", "Effect is not used").conflict).toBe(
      true,
    );
  });

  it("reports failed reindex upserts before failing, including quiet mode", async () => {
    const failure = new MemoryDatabaseError({
      operation: "vectorize/upsert",
      message: "Vectorize unavailable",
      cause: undefined,
    });
    const database: MemoryDatabaseApi = {
      run: () => Effect.succeed(undefined),
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
        upsert: () => Effect.fail(failure),
        delete: () => Effect.succeed({ id: "1", mutationId: "mutation" }),
        search: () => Effect.succeed({ count: 0, matches: [] }),
      },
    };
    const context = (outputMode: {
      jsonMin: boolean;
      quiet: boolean;
    }): CommandContext => ({
      args: ["--remote"],
      command: "reindex",
      outputMode: {
        brief: false,
        jsonMin: outputMode.jsonMin,
        noConflicts: false,
        pretty: false,
        quiet: outputMode.quiet,
      },
      database,
      fileSystem: {} as CommandContext["fileSystem"],
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      const jsonExit = await Effect.runPromiseExit(
        handleReindexCommand(context({ jsonMin: true, quiet: false })),
      );
      expect(jsonExit._tag).toBe("Failure");
      expect(info).toHaveBeenCalledWith(expect.stringContaining('"failed":1'));

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
      const humanOutput = info.mock.calls.flat().join("\n");
      expect(humanOutput).toContain("Vectorize unavailable");
      expect(humanOutput).not.toContain("Cause(");
    } finally {
      info.mockRestore();
    }
  });

  it("retries only rate-limited reindex upserts", async () => {
    let upsertCalls = 0;
    const rateLimit = new MemoryDatabaseError({
      operation: "vectorize/upsert",
      message: "Too Many Requests",
      cause: undefined,
    });
    const database: MemoryDatabaseApi = {
      run: () => Effect.succeed(undefined),
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
        upsert: () => {
          upsertCalls += 1;
          return upsertCalls === 1
            ? Effect.fail(rateLimit)
            : Effect.succeed({ id: "1", mutationId: "mutation" });
        },
        delete: () => Effect.succeed({ id: "1", mutationId: "mutation" }),
        search: () => Effect.succeed({ count: 0, matches: [] }),
      },
    };
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.useFakeTimers();

    try {
      const exitPromise = Effect.runPromiseExit(
        handleReindexCommand({
          args: ["--remote", "--json-min"],
          outputMode: {
            brief: false,
            jsonMin: true,
            noConflicts: false,
            pretty: false,
            quiet: false,
          },
          command: "reindex",
          database,
          fileSystem: {} as CommandContext["fileSystem"],
        }),
      );
      await vi.runAllTimersAsync();
      const exit = await exitPromise;

      expect(exit._tag).toBe("Success");
      expect(upsertCalls).toBe(2);
      expect(info).toHaveBeenCalledWith(expect.stringContaining('"failed":0'));
    } finally {
      vi.useRealTimers();
      info.mockRestore();
    }
  });

  it("combines lexical and semantic relevance with an explanation", () => {
    const results = combineHybridResults(
      [
        { id: 1, score: 90 },
        { id: 2, score: 50 },
      ],
      [
        { id: 2, score: 0.95, semantic_score: 0.95 },
        { id: 3, score: 0.8, semantic_score: 0.8 },
      ],
      3,
      true,
    );

    expect(results.map((row) => row.id)).toEqual([2, 1, 3]);
    expect(results[0]).toMatchObject({
      fts_score: 50,
      semantic_score: 0.95,
      hybrid_score: 75.556,
      score: 75.556,
    });
    expect(results[0]?.score_breakdown).toMatchObject({
      fts: { weight: 0.55 },
      semantic: { weight: 0.45 },
      total: 75.556,
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
