import { Effect } from "effect";
import { printJson, usageError } from "../../cli-utils";
import { repositoryForCurrentDirectory } from "../../repository";
import { parseIdSpec } from "../shared";
import { requireDatabase, type CommandContext } from "../runtime/context";

export function handleDeleteCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { args } = commandCtx;
    const database = requireDatabase(commandCtx);
    const idSpec = args.join(",");
    if (!idSpec.trim()) {
      usageError("Usage: delete <id|id,id,...>");
    }
    const ids = parseIdSpec(idSpec);
    for (const id of ids) {
      yield* database.run(
        "DELETE FROM memories WHERE repository = ? AND id = ?",
        [repositoryForCurrentDirectory(), id],
      );
    }
    yield* Effect.sync(() =>
      printJson(
        ids.length === 1
          ? { deleted: ids[0] }
          : { deleted: ids, count: ids.length },
      ),
    );
  });
}
