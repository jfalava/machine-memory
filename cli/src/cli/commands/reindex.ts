import {
  EMBEDDING_MODEL,
  indexStatusFromRows,
  indexStatusQueries,
  UNINDEXED_SQL,
  type IndexStatus,
} from "@machine-memory/contract";
import { Effect } from "effect";

import { getFlagValue, hasFlag, usageError } from "../../cli-utils";
import type { MemoryDatabaseApi } from "../../effect/database";
import type { MemoryDatabaseError } from "../../effect/errors";
import { toContractValue } from "../../effect/remote-http";
import { jsonNumber, jsonObject, type JsonObject } from "../../json";
import { repositoryForCurrentDirectory } from "../../repository";
import { INDEX_USAGE, REINDEX_USAGE } from "../features/memory/usage";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { printCommandOutput } from "../runtime/output";
import { parseIdSpec } from "../shared";

/** --failed-only or --unindexed: the part of the scope to queue, if not all of it. */
function reindexSubset(flags: CommandContext["flags"]) {
  const failedOnly = hasFlag(flags, "--failed-only");
  const unindexed = hasFlag(flags, "--unindexed");
  if (failedOnly && unindexed) {
    usageError(
      `--failed-only and --unindexed select different memories; run reindex once for each. Usage: ${REINDEX_USAGE}`,
    );
  }
  if (failedOnly) {
    return {
      sql: "generation > delivered_generation AND last_error IS NOT NULL",
      params: [],
    };
  }
  if (unindexed) {
    return {
      sql: `memory_id IN (SELECT s.memory_id FROM memory_vector_sync s JOIN memories m ON m.id = s.memory_id WHERE m.status = 'active' AND ${UNINDEXED_SQL})`,
      params: [EMBEDDING_MODEL],
    };
  }
  return undefined;
}

/** Which sync rows `reindex` re-queues, as a WHERE clause and its bindings. */
function reindexScope(commandCtx: CommandContext) {
  const { flags } = commandCtx;
  const allRepos = hasFlag(flags, "--all-repos");
  const idSpec = getFlagValue(flags, "--id");
  if (allRepos && idSpec !== undefined) {
    usageError(
      `--id selects memories of the current repository, so it cannot be combined with --all-repos. Usage: ${REINDEX_USAGE}`,
    );
  }
  const ids = idSpec === undefined ? undefined : parseIdSpec(idSpec);
  const repository = allRepos ? undefined : repositoryForCurrentDirectory();
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (repository !== undefined) {
    conditions.push("repository = ?");
    params.push(repository);
  }
  if (ids !== undefined) {
    conditions.push(`memory_id IN (${ids.map(() => "?").join(", ")})`);
    params.push(...ids);
  }
  const subset = reindexSubset(flags);
  if (subset !== undefined) {
    conditions.push(subset.sql);
    params.push(...subset.params);
  }
  return {
    repository,
    ids,
    where: conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

export function handleReindexCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const database = requireDatabase(commandCtx);
    if (!database.vectorize) {
      usageError("Reindex requires the remote backend: reindex --remote.");
    }
    const scope = reindexScope(commandCtx);
    // Queue IDs atomically on the server, including retained deletion tombstones.
    // The coordinator reads current rows; no stale client snapshots are indexed.
    const result = yield* database.run(
      `UPDATE memory_vector_sync
      SET generation = generation + 1, next_attempt_at = 0, attempts = 0, last_error = NULL,
        queued_at = unixepoch() * 1000${scope.where}`,
      scope.params,
    );
    const queued = jsonNumber(jsonObject(result)?.changes) ?? 0;
    const payload: JsonObject = {
      repository: scope.repository ?? null,
      all_repositories: scope.repository === undefined,
      queued,
      indexing: "queued",
    };
    if (scope.ids !== undefined && queued < scope.ids.length) {
      payload.note = `${scope.ids.length - queued} of the ${scope.ids.length} ids matched nothing to queue in this repository.`;
    }
    yield* Effect.sync(() => printCommandOutput(commandCtx, payload));
  });
}

/** Where a repository's records, or all records, stand in the semantic index. */
export function readIndexStatus(
  database: MemoryDatabaseApi,
  repository: string | undefined,
): Effect.Effect<IndexStatus, MemoryDatabaseError> {
  return Effect.gen(function* () {
    const queries = indexStatusQueries(repository);
    const counts = yield* database.get(queries.counts.sql, [
      ...queries.counts.params,
    ]);
    const failures = yield* database.all(queries.failures.sql, [
      ...queries.failures.params,
    ]);
    return indexStatusFromRows(
      toContractValue(counts ?? null),
      failures.map(toContractValue),
    );
  });
}

export function handleIndexCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    if (
      commandCtx.positionals.length !== 1 ||
      commandCtx.positionals[0] !== "status"
    ) {
      usageError(`Usage: ${INDEX_USAGE}`);
    }
    const database = requireDatabase(commandCtx);
    if (!database.vectorize) {
      usageError(
        "Only the remote backend has a semantic index: index status --remote.",
      );
    }
    const repository = hasFlag(commandCtx.flags, "--all-repos")
      ? undefined
      : repositoryForCurrentDirectory();
    const status = yield* readIndexStatus(database, repository);
    const payload: JsonObject = {
      repository: repository ?? null,
      all_repositories: repository === undefined,
      ...status,
    };
    if (status.unindexed > 0) {
      payload.note = `Semantic search cannot find ${status.unindexed} active memories: their vectors predate the current index. Queue them with 'machine-memory reindex --unindexed --remote${repository === undefined ? " --all-repos" : ""}'.`;
    }
    yield* Effect.sync(() => printCommandOutput(commandCtx, payload));
  });
}
