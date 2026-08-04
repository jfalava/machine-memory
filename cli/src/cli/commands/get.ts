import { Effect } from "effect";
import { printJson, usageError } from "../../cli-utils";
import { getMemoryById, parseIdSpec } from "../shared";
import { requireDatabase, type CommandContext } from "../runtime/context";

export function handleGetCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { args } = commandCtx;
    const database = requireDatabase(commandCtx);
    const idSpec = args[0];
    if (!idSpec) {
      usageError("Usage: get <id>");
    }
    const ids = parseIdSpec(idSpec);
    const fetched = yield* Effect.all(
      ids.map((id) => getMemoryById(database, id)),
    );
    const rows = fetched.filter(
      (row): row is Record<string, unknown> => row !== null,
    );
    const missingIds = ids.filter(
      (id) => !rows.some((row) => Number(row.id) === id),
    );
    yield* Effect.sync(() => {
      if (ids.length === 1) {
        printJson(rows[0] ?? { error: "Not found" });
        return;
      }
      printJson({
        results: rows,
        ...(missingIds.length > 0 ? { missing_ids: missingIds } : {}),
      });
    });
  });
}
