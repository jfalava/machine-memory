import { Effect } from "effect";

import { usageError } from "../../cli-utils";
import { jsonNumber, jsonObject } from "../../json";
import { repositoryForCurrentDirectory } from "../../repository";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { printCommandOutput } from "../runtime/output";

export function handleReindexCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const database = requireDatabase(commandCtx);
    if (!database.vectorize) {
      usageError("Reindex requires the remote backend: reindex --remote.");
    }
    const repository = repositoryForCurrentDirectory();
    // Queue IDs atomically on the server, including retained deletion tombstones.
    // The coordinator reads current rows; no stale client snapshots are indexed.
    const result = yield* database.run(
      `UPDATE memory_vector_sync
      SET generation = generation + 1, next_attempt_at = 0, attempts = 0, last_error = NULL
      WHERE repository = ?`,
      [repository],
    );
    yield* Effect.sync(() =>
      printCommandOutput(commandCtx, {
        repository,
        queued: jsonNumber(jsonObject(result)?.changes) ?? 0,
        indexing: "queued",
      }),
    );
  });
}
