import { Effect } from "effect";

import { usageError } from "../../cli-utils";
import { repositoryForCurrentDirectory } from "../../repository";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { printCommandOutput } from "../runtime/output";
import { collectPositionalArgs, parseIdSpec } from "../shared";

export function handleDeleteCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { args } = commandCtx;
    const database = requireDatabase(commandCtx);
    const idSpec = collectPositionalArgs(args, []).join(",");
    if (!idSpec.trim()) {
      usageError("Usage: delete <id|id,id,...>");
    }
    const ids = parseIdSpec(idSpec);
    const deleted: number[] = [];
    const missing: number[] = [];
    let error: string | undefined;
    for (const id of ids) {
      const outcome = yield* database
        .get(
          "DELETE FROM memories WHERE repository = ? AND id = ? RETURNING id",
          [repositoryForCurrentDirectory(), id],
        )
        .pipe(
          Effect.match({
            onFailure: (cause) => ({ error: cause.message, row: undefined }),
            onSuccess: (row) => ({ error: undefined, row }),
          }),
        );
      if (outcome.error) {
        error = outcome.error;
        break;
      }
      if (outcome.row) {
        deleted.push(id);
      } else {
        missing.push(id);
      }
    }
    yield* Effect.sync(() => {
      if (missing.length || error) {
        process.exitCode = 1;
      }
      if (commandCtx.outputMode.quiet && !missing.length && !error) {
        return;
      }
      const payload = { deleted, not_found: missing, count: deleted.length };
      if (error) {
        Object.assign(payload, {
          error,
          unprocessed: ids.slice(deleted.length + missing.length),
        });
      }
      printCommandOutput(
        commandCtx,
        ids.length === 1 && deleted.length === 1 && !error
          ? { deleted: deleted[0] }
          : payload,
      );
    });
  });
}
