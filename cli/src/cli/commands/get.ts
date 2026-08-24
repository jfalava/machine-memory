import { Effect } from "effect";
import { printJson, usageError } from "../../cli-utils";
import type { JsonObject } from "../../json";
import {
  getMemoryById,
  normalizeCertaintyValue,
  parseIdSpec,
  parseTags,
  stringValue,
} from "../shared";
import { requireDatabase, type CommandContext } from "../runtime/context";
import { printBriefLines, printCommandOutput } from "../runtime/output";

function minimalGetSummary(row: JsonObject): JsonObject {
  return {
    id: Number(row.id ?? 0),
    memory_type: stringValue(row.memory_type, "convention"),
    certainty: normalizeCertaintyValue(row.certainty),
    status: stringValue(row.status, "active"),
    tags: parseTags(stringValue(row.tags)),
  } satisfies JsonObject;
}

export function handleGetCommand(commandCtx: CommandContext) {
  return Effect.gen(function* () {
    const { args, outputMode } = commandCtx;
    const database = requireDatabase(commandCtx);
    const idSpec = args[0];
    if (!idSpec) {
      usageError("Usage: get <id>");
    }
    const ids = parseIdSpec(idSpec);
    const fetched = yield* Effect.all(
      ids.map((id) => getMemoryById(database, id)),
    );
    const rows = fetched.filter((row): row is JsonObject => row !== null);
    const missingIds = ids.filter(
      (id) => !rows.some((row) => Number(row.id) === id),
    );
    yield* Effect.sync(() => {
      if (outputMode.quiet || outputMode.jsonMin) {
        const payload: JsonObject = {
          count: rows.length,
          ids: rows.map((row) => Number(row.id)),
        };
        if (outputMode.jsonMin) {
          Object.assign(payload, { results: rows.map(minimalGetSummary) });
        }
        if (missingIds.length > 0) {
          Object.assign(payload, { missing_ids: missingIds });
        }
        printJson(payload);
        return;
      }
      if (outputMode.brief) {
        printBriefLines(rows);
        return;
      }
      if (ids.length === 1) {
        printCommandOutput(commandCtx, rows[0] ?? { error: "Not found" });
        return;
      }
      const payload = { results: rows };
      if (missingIds.length > 0) {
        Object.assign(payload, { missing_ids: missingIds });
      }
      printCommandOutput(commandCtx, payload);
    });
  });
}
