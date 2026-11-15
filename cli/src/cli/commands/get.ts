import { Effect } from "effect";

import { usageError } from "../../cli-utils";
import type { JsonObject } from "../../json";
import { requireDatabase, type CommandContext } from "../runtime/context";
import {
  minimalResultSummary,
  printRead,
  readEnvelope,
} from "../runtime/output";
import {
  findElsewhere,
  getMemoryById,
  parseIdSpec,
  readScope,
  stringValue,
} from "../shared";

/** get is how a memory is read in full, so its summary keeps the whole content. */
function minimalGetSummary(row: JsonObject): JsonObject {
  const { snippet: _snippet, ...summary } = minimalResultSummary(row);
  return { ...summary, content: stringValue(row.content) };
}

export function handleGetCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const database = requireDatabase(commandCtx);
    const idSpec = commandCtx.positionals[0];
    if (!idSpec) {
      usageError("Usage: get <id|id,id,...>");
    }
    const ids = parseIdSpec(idSpec);
    const fetched = yield* Effect.forEach(ids, (id) =>
      getMemoryById(database, id),
    );
    const rows = fetched.filter((row): row is JsonObject => row !== null);
    const missingIds = ids.filter(
      (id) => !rows.some((row) => Number(row.id) === id),
    );
    // A miss says where the id is when another repository holds it.
    const scope = yield* readScope(database, rows.length);
    const elsewhere = yield* findElsewhere(database, missingIds);
    const extras: JsonObject = {};
    if (missingIds.length > 0) {
      extras.missing_ids = missingIds;
    }
    if (elsewhere.length > 0) {
      extras.found_elsewhere = elsewhere;
    }
    yield* Effect.sync(() => {
      printRead(
        commandCtx,
        rows,
        readEnvelope(commandCtx.outputMode, scope, rows, {
          extras,
          summarize: minimalGetSummary,
        }),
      );
    });
  });
}
